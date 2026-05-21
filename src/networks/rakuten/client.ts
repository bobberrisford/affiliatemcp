/**
 * Rakuten Advertising HTTP client — the only sanctioned network I/O path.
 *
 * Same hard rules as the Awin client (see `src/networks/awin/client.ts`):
 *   1. No `fetch` outside this file inside the rakuten/ folder.
 *   2. Every request flows through `withResilience` so timeouts, retries, and
 *      the circuit breaker apply uniformly.
 *   3. Non-2xx responses throw `HttpStatusError` so the resilience layer can
 *      classify and retry by status policy alone.
 *   4. Raw response bodies are preserved verbatim on failure for the envelope
 *      (PRD principle 4.1).
 *
 * Rakuten-specific differences from the Awin client:
 *
 *   - **Bearer token from cache**: every call asks `auth.getAccessToken()` for
 *     a token rather than receiving one from the caller. The cache lives in
 *     `auth.ts` and refreshes proactively when the lifetime gets short.
 *
 *   - **401 → refresh → retry once**: if the data endpoint returns 401 with a
 *     cached token, the cache may be stale (Rakuten can revoke a token
 *     server-side before its `expires_in` elapses). We force-refresh and
 *     retry the original call exactly once. The retry is logged at debug
 *     level — per the project's "no silent retries" rule, the 401-recovery
 *     path is NOT hidden.
 *
 *   - **Explicit `Accept: application/json`**: Rakuten's older endpoints
 *     default to XML; sending the JSON Accept header is what gets you the
 *     documented JSON shape across the board.
 */

import { getAccessToken, refreshToken } from './auth.js';
import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('rakuten.client');

/**
 * The Rakuten API root. Hard-coded for v0.1 — see findings doc for the note
 * about tenants that use `api.rakutenmarketing.com` instead.
 */
export const RAKUTEN_BASE_URL = 'https://api.linksynergy.com';

export interface RakutenRequestInput {
  /** Canonical operation name — used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to `RAKUTEN_BASE_URL`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. `undefined` values are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
  /**
   * Override the base URL. Used internally by retry; production callers leave
   * it unset.
   */
  baseUrl?: string;
}

/**
 * Issue a single Rakuten API request under the resilience policy with the
 * 401-refresh-retry-once behaviour.
 *
 * The `withResilience` wrapper handles all the "retry on 5xx / 429 / network
 * blip" cases. The 401 handling sits INSIDE the resilience callable because:
 *   - We must call `refreshToken({ forceRefresh: true })` and then retry the
 *     SAME request. That's a behaviour the resilience layer doesn't model;
 *     it treats 401 as `auth_error` (non-retryable, which is correct in the
 *     general case).
 *   - By collapsing the refresh-retry into a single callable, the resilience
 *     layer still gets to apply timeout / 5xx-retry / circuit breaker to the
 *     composite. If the refresh itself fails, the resilience layer sees a
 *     normal failure.
 *
 * Tradeoff: the resilience layer sees ONE attempt for the composite (request
 * + maybe-refresh + maybe-retry). That's intentional — we don't want N retries
 * of the same 401 to cascade into N×2 token refreshes.
 */
export async function rakutenRequest<T>(input: RakutenRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'rakuten', operation: input.operation };

  return withResilience(
    ctx,
    async () => doRequestWith401Refresh<T>(input),
    input.resilience,
  );
}

async function doRequestWith401Refresh<T>(input: RakutenRequestInput): Promise<T> {
  let token = await getAccessToken();

  const firstAttempt = await rawRequest<T>(input, token);
  if (firstAttempt.kind === 'ok') return firstAttempt.value;

  if (firstAttempt.status === 401) {
    // The 401-refresh-retry-once path. Surfaced at debug+ — not hidden.
    log.debug(
      {
        operation: input.operation,
        path: input.path,
        reason: 'Rakuten returned 401 with cached token; forcing refresh and retrying once',
      },
      'rakuten 401 → refreshing token',
    );
    token = await refreshToken({ reason: '401 from data endpoint' });
    const secondAttempt = await rawRequest<T>(input, token);
    if (secondAttempt.kind === 'ok') return secondAttempt.value;
    // Two consecutive 401s = the credentials are bad, not stale. Surface the
    // verbatim body so the user can see what Rakuten told us.
    throw new HttpStatusError(
      secondAttempt.status,
      secondAttempt.body,
      `Rakuten ${input.operation} ${input.method ?? 'GET'} ${input.path} → HTTP ${secondAttempt.status} after token refresh`,
    );
  }

  // Non-401 failure — surface as HttpStatusError so the resilience layer can
  // make the retry/no-retry decision.
  throw new HttpStatusError(
    firstAttempt.status,
    firstAttempt.body,
    `Rakuten ${input.operation} ${input.method ?? 'GET'} ${input.path} → HTTP ${firstAttempt.status}`,
  );
}

type RawResult<T> = { kind: 'ok'; value: T } | { kind: 'err'; status: number; body: string };

async function rawRequest<T>(input: RakutenRequestInput, token: string): Promise<RawResult<T>> {
  const url = buildUrl(input.path, input.query, input.baseUrl);
  const init: RequestInit = {
    method: input.method ?? 'GET',
    headers: buildHeaders(token, input.body !== undefined),
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }
  if (input.signal) {
    init.signal = input.signal;
  }

  log.debug({ url, method: init.method, operation: input.operation }, 'rakuten request');

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
    // 2xx but unparseable body — Rakuten occasionally returns XML when the
    // Accept header gets stripped by an intermediary. Throw with the verbatim
    // body so the user can see what came back.
    throw new Error(
      `Rakuten ${input.operation} returned HTTP ${res.status} with non-JSON body: ${rawBody.slice(0, 500)} (parse error: ${(err as Error).message})`,
    );
  }
}

function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // Rakuten's older endpoints default to XML; explicit JSON acceptance
    // sidesteps that. See findings doc.
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(
  pathname: string,
  query: Record<string, string | number | undefined> | undefined,
  baseOverride?: string,
): string {
  const base = baseOverride ?? RAKUTEN_BASE_URL;
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
