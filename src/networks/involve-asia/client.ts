/**
 * Involve Asia HTTP client — the only sanctioned network I/O path for this folder.
 *
 * Same hard rules as the Awin client (`src/networks/awin/client.ts`):
 *   1. No `fetch` outside this file inside the involve-asia/ folder.
 *   2. Every request flows through `withResilience` so timeouts, retries, and
 *      the circuit breaker apply uniformly.
 *   3. Non-2xx responses throw `HttpStatusError` so the resilience layer can
 *      classify and retry by status policy alone.
 *   4. Raw response bodies are preserved verbatim on failure for the envelope
 *      (PRD principle 4.1).
 *
 * Involve Asia specifics (verify against
 * https://help.involve.asia/hc/en-us/articles/360029841771):
 *
 *   - **Short-lived bearer token from cache**: data calls send
 *     `Authorization: Bearer <token>`. The token is obtained from
 *     `POST /authenticate` (key + secret) and lives ~2 hours. The cache lives
 *     in `auth.ts` and refreshes proactively when the lifetime gets short.
 *     This client asks `auth.getAccessToken()` for a token per call rather than
 *     receiving one from the caller — the Rakuten pattern.
 *
 *   - **401 → refresh → retry once**: if a data endpoint returns 401 with a
 *     cached token, the token may have expired early. We force-refresh and
 *     retry the original call exactly once. The retry is logged at debug level —
 *     per the project's "no silent retries" rule, the recovery path is NOT
 *     hidden. Two consecutive 401s surface as an `HttpStatusError` carrying the
 *     verbatim body.
 *
 *   - **Form-encoded POST bodies**: Involve Asia's data endpoints
 *     (`/offers/all`, `/conversions/range`) take parameters as
 *     `application/x-www-form-urlencoded`, not JSON. The `form` field below is
 *     serialised with `URLSearchParams`; array filters use the documented
 *     `filters[key]` bracket convention.
 *
 *   - **JSON responses**: every data endpoint returns JSON; we send
 *     `Accept: application/json` to be explicit.
 */

import { getAccessToken, refreshToken } from './auth.js';
import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('involve-asia.client');

/**
 * The Involve Asia API root. Hard-coded for v0.1. Every endpoint
 * (`/authenticate`, `/offers/all`, `/conversions/range`, `/offers/links`) is
 * a child of this base. Centralised so a test harness can reason about the
 * shape in one place.
 */
export const INVOLVE_ASIA_BASE_URL = 'https://api.involve.asia/api';

/**
 * Form parameters for a data request. Values may be scalars or — for the
 * documented `filters[...]` convention — a nested record whose keys are
 * appended as `filters[key]=value`.
 */
export type FormParams = Record<string, string | number | undefined | Record<string, string | number>>;

export interface InvolveAsiaRequestInput {
  /** Canonical operation name — used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `INVOLVE_ASIA_BASE_URL`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. `undefined` values are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Form-encoded body parameters (Involve Asia data endpoints are form POSTs). */
  form?: FormParams;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Involve Asia API request under the resilience policy with the
 * 401-refresh-retry-once behaviour.
 *
 * The `withResilience` wrapper handles the "retry on 5xx / 429 / network blip"
 * cases. The 401 handling sits INSIDE the resilience callable for the same
 * reasons documented in the Rakuten client: a 401-driven refresh + retry is a
 * behaviour the resilience layer does not model, and collapsing it into one
 * callable means a single composite attempt is what the breaker sees (so N
 * retries cannot cascade into N token refreshes).
 */
export async function involveAsiaRequest<T>(input: InvolveAsiaRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'involve-asia', operation: input.operation };

  return withResilience(
    ctx,
    async () => doRequestWith401Refresh<T>(input),
    input.resilience,
  );
}

async function doRequestWith401Refresh<T>(input: InvolveAsiaRequestInput): Promise<T> {
  let token = await getAccessToken();

  const firstAttempt = await rawRequest<T>(input, token);
  if (firstAttempt.kind === 'ok') return firstAttempt.value;

  if (firstAttempt.status === 401) {
    // The 401-refresh-retry-once path. Surfaced at debug+ — not hidden.
    log.debug(
      {
        operation: input.operation,
        path: input.path,
        reason: 'Involve Asia returned 401 with cached token; forcing refresh and retrying once',
      },
      'involve-asia 401 → refreshing token',
    );
    token = await refreshToken({ reason: '401 from data endpoint' });
    const secondAttempt = await rawRequest<T>(input, token);
    if (secondAttempt.kind === 'ok') return secondAttempt.value;
    // Two consecutive 401s = the credentials are bad, not stale. Surface the
    // verbatim body so the user can see what Involve Asia told us.
    throw new HttpStatusError(
      secondAttempt.status,
      secondAttempt.body,
      `Involve Asia ${input.operation} ${input.method ?? 'POST'} ${input.path} → HTTP ${secondAttempt.status} after token refresh`,
    );
  }

  // Non-401 failure — surface as HttpStatusError so the resilience layer can
  // make the retry/no-retry decision.
  throw new HttpStatusError(
    firstAttempt.status,
    firstAttempt.body,
    `Involve Asia ${input.operation} ${input.method ?? 'POST'} ${input.path} → HTTP ${firstAttempt.status}`,
  );
}

type RawResult<T> = { kind: 'ok'; value: T } | { kind: 'err'; status: number; body: string };

async function rawRequest<T>(input: InvolveAsiaRequestInput, token: string): Promise<RawResult<T>> {
  const url = buildUrl(input.path, input.query);
  const hasForm = input.form !== undefined;
  const init: RequestInit = {
    method: input.method ?? (hasForm ? 'POST' : 'GET'),
    headers: buildHeaders(token, hasForm),
  };
  if (hasForm) {
    init.body = encodeForm(input.form ?? {});
  }
  if (input.signal) {
    init.signal = input.signal;
  }

  log.debug({ url, method: init.method, operation: input.operation }, 'involve-asia request');

  const res = await fetch(url, init);
  const rawBody = await res.text();

  if (!res.ok) {
    return { kind: 'err', status: res.status, body: rawBody };
  }

  if (rawBody.trim() === '') {
    return { kind: 'ok', value: {} as T };
  }

  try {
    return { kind: 'ok', value: JSON.parse(rawBody) as T };
  } catch (err) {
    // Preserve the verbatim body on the envelope (PRD §4.1).
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: 'involve-asia',
        operation: input.operation,
        httpStatus: res.status,
        networkErrorBody: rawBody,
        message: `Involve Asia ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
      }),
    );
  }
}

/**
 * Serialise form parameters. Scalars are set directly; a nested record is
 * expanded into Involve Asia's documented `filters[key]=value` bracket
 * convention. `undefined` values are skipped.
 */
function encodeForm(form: FormParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        params.set(`${key}[${innerKey}]`, String(innerValue));
      }
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function buildHeaders(token: string, hasForm: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (hasForm) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return headers;
}

/**
 * Join a path to the base.
 *
 * Why string concatenation rather than `new URL(path, base)`: the Involve Asia
 * base carries a path prefix (`/api`). `new URL('/offers/all', '…/api')` would
 * discard the `/api` segment because a leading-slash pathname is absolute. We
 * therefore concatenate `base + path` and let `URL` own only the query-string
 * encoding, which is the part that genuinely needs escaping.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const base = INVOLVE_ASIA_BASE_URL.replace(/\/$/, '');
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(base + suffix);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
