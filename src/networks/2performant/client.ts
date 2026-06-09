/**
 * 2Performant HTTP client — the ONLY path 2Performant adapter methods use for
 * network I/O.
 *
 * 2Performant uses a credential/session based auth scheme (devise-token-auth):
 * there is no static API key. The caller POSTs email + password to a sign-in
 * endpoint and receives three session headers (`access-token`, `client`, `uid`)
 * which must be replayed on every subsequent call. Those headers rotate — the
 * server may issue a fresh `access-token` on any response — so the session is
 * cached and refreshed in `auth.ts` (modelled on Rakuten's token cache).
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly. A 401 is surfaced this way so the
 *      adapter can re-login once and retry (see `adapter.ts`).
 *   4. Preserve the raw response body verbatim on failure.
 *
 * --- The `.json` route suffix ----------------------------------------------
 *
 * 2Performant routes are content-negotiated by extension: `/affiliate/programs`
 * is requested as `/affiliate/programs.json`. The PHP reference wrapper appends
 * `.json` to every route; we do the same in `buildUrl` so callers pass clean
 * paths.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('2performant.client');

/**
 * The 2Performant API root. Centralised so a test harness can override it
 * without touching adapter code. Hard-coded for v0.1.
 */
export const TWOPERFORMANT_BASE_URL = 'https://api.2performant.com';

/**
 * The three rotating session headers 2Performant issues on sign-in and on most
 * authenticated responses. We replay them on every call and pick up any rotated
 * values the server returns.
 */
export interface TwoPerformantSession {
  accessToken: string;
  client: string;
  uid: string;
}

export interface TwoPerformantRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `TWOPERFORMANT_BASE_URL`. `.json` is appended automatically. */
  path: string;
  /**
   * Session headers. Omitted only for the sign-in call itself (which carries no
   * session yet). Every other call MUST pass a session.
   */
  session?: TwoPerformantSession;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. Nested objects are bracket-encoded. */
  query?: Record<string, unknown>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * A request result: the parsed JSON body plus any rotated session headers the
 * server returned. The adapter/auth layer folds `rotatedSession` back into the
 * cache so the next call uses the freshest tokens.
 */
export interface TwoPerformantResponse<T> {
  body: T;
  rotatedSession?: TwoPerformantSession;
}

/**
 * Issue a single 2Performant API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: 2Performant's
 * REST surface wraps payloads in a named container (`{ programs: [...] }`,
 * `{ commissions: [...] }`, `{ metadata: {...} }`) and the per-field shapes are
 * weakly documented. Over-specifying a schema here would force the client into
 * "is this a valid response?" business that belongs in the adapter's
 * transformer. Transformers MUST tolerate missing keys defensively.
 */
export async function twoPerformantRequest<T>(
  input: TwoPerformantRequestInput,
): Promise<TwoPerformantResponse<T>> {
  const ctx: WithResilienceContext = { network: '2performant', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.session, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, '2performant request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). 2Performant error bodies
      // are JSON-shaped (`{ "errors": [...] }`) but may be plain text on a CDN
      // error — preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. A 401 here is classified as auth_error and NOT
        // retried by the resilience layer; the adapter catches it, re-logs in,
        // and retries exactly once. Do NOT inspect `res.status` to decide
        // retries — policy lives in resilience.ts.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `2Performant ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
        );
      }

      const rotatedSession = readRotatedSession(res);

      // Empty body (e.g. a 204) is returned as the empty object — adapters that
      // legitimately expect a payload detect the missing fields and throw a
      // meaningful envelope.
      if (rawBody.trim() === '') {
        return { body: {} as T, rotatedSession };
      }

      try {
        return { body: JSON.parse(rawBody) as T, rotatedSession };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: '2performant',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `2Performant ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Read the rotated session headers off a response, if all three are present.
 *
 * 2Performant (devise-token-auth) may issue a fresh `access-token` on any
 * authenticated response. When it does, the three headers travel together;
 * if any is missing we return `undefined` and the caller keeps the prior
 * session unchanged.
 */
function readRotatedSession(res: Response): TwoPerformantSession | undefined {
  const accessToken = res.headers.get('access-token');
  const client = res.headers.get('client');
  const uid = res.headers.get('uid');
  if (accessToken && client && uid) {
    return { accessToken, client, uid };
  }
  return undefined;
}

/**
 * Build the request headers.
 *
 * The three session headers (`access-token`, `client`, `uid`) authenticate the
 * call. We send `Accept: application/json` explicitly because the API is
 * content-negotiated. `Content-Type` is set only when a body is present.
 */
function buildHeaders(
  session: TwoPerformantSession | undefined,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (session) {
    headers['access-token'] = session.accessToken;
    headers['client'] = session.client;
    headers['uid'] = session.uid;
  }
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with `.json` suffix and a bracket-encoded query string.
 *
 * 2Performant takes nested filter/sort params as `filter[status]=...` and
 * `sort[date]=desc`. We expand one level of nesting; primitive values pass
 * through. `URLSearchParams` handles the percent-encoding (commission `date`
 * filters carry ISO ranges with reserved characters).
 */
function buildUrl(pathname: string, query?: Record<string, unknown>): string {
  const withSuffix = pathname.endsWith('.json') ? pathname : `${pathname}.json`;
  const url = new URL(
    withSuffix.startsWith('/') ? withSuffix : `/${withSuffix}`,
    TWOPERFORMANT_BASE_URL,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          if (nv === undefined || nv === null) continue;
          url.searchParams.set(`${k}[${nk}]`, String(nv));
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly. The boundary stays clean: "everything network
// goes through ./client".
export { HttpStatusError };
