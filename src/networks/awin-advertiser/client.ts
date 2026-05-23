/**
 * Awin advertiser HTTP client — the ONLY path adapter methods use for network I/O.
 *
 * Two safety layers wrap every request:
 *
 *   1. Read-only guard (mandatory). The Awin advertiser surface exposes write
 *      endpoints — Conversion API, transaction amendments, Create Offers — and
 *      this adapter is read-only at v0.1. The client rejects any non-GET
 *      method BEFORE any network call goes out. A future contributor must
 *      consciously remove the throw to enable writes.
 *
 *   2. Rate limiter (mandatory). Awin enforces a HARD limit of 20 API calls
 *      per minute per user. Breaching the limit returns 429 and, on sustained
 *      breach, gets the token throttled at the edge. The client implements a
 *      token-bucket rate limiter at 20 requests per 60 seconds, keyed per
 *      token (so a process configured with multiple tokens — currently not
 *      possible but cheap to support — does not have one user's budget eaten
 *      by another). Calls in excess of the budget QUEUE (await + retry) rather
 *      than fail fast. Rationale: the wizard fan-out (verify + listBrands +
 *      per-brand probe) and the agency-side reporting workflows are bursty by
 *      nature; users would rather wait a few seconds than see the operation
 *      flap with `rate_limited` errors that they can't act on. The queueing
 *      respects the resilience layer's outer timeout — if the budget is so
 *      saturated that the call can't be served inside the operation's
 *      timeoutMs, the outer timeout fires and surfaces as a `timeout` envelope.
 *
 * The rate-limiter state is PROCESS-WIDE at v0.1 (a module-level Map). That is
 * sufficient because a) Awin's rate limit is per-user / per-token, and b) the
 * MCP server runs as a single Node process. If we ever fan out to workers we
 * will need to centralise the bucket state — leave a TODO for that.
 *
 * Hard rules for future contributors:
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else.
 *   2. Do NOT bypass the bucket. Every call goes through `awinAdvRequest`.
 *   3. Do NOT lift the read-only guard. The throw is intentional defence-in-
 *      depth; removing it requires a separate PR and an explicit credential
 *      tier change.
 *   4. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly (PRD §15.5).
 *   5. Preserve the raw response body verbatim on failure (PRD principle 4.1).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { bearerAuthHeader, SLUG } from './auth.js';

const log = createLogger('awin-advertiser.client');

export const AWIN_ADVERTISER_BASE_URL = 'https://api.awin.com';

/** Awin's documented rate limit: 20 calls per minute per user. */
export const AWIN_RATE_LIMIT_REQUESTS = 20;
export const AWIN_RATE_LIMIT_WINDOW_MS = 60_000;

export interface AwinAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and on error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to `AWIN_ADVERTISER_BASE_URL`. */
  path: string;
  /** OAuth bearer token. */
  token: string;
  /** Method. Always `GET` at v0.1; passing anything else throws BEFORE any wire I/O. */
  method?: 'GET';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs. Per-op profile lives in adapter.ts. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * The token bucket. Tracks the timestamps of recent requests per token. We
 * keep a sliding window — anything older than `AWIN_RATE_LIMIT_WINDOW_MS` is
 * pruned on every check. This is more memory-efficient than a strict 60-bin
 * histogram and gives the same answer.
 */
const bucketsByToken = new Map<string, number[]>();

/**
 * Test seam — clears every token's window. Public so unit tests can reset
 * state between cases without leaking buckets across describe blocks.
 */
export function _resetRateLimiter(): void {
  bucketsByToken.clear();
}

/** Test seam — read current bucket size (for assertions). */
export function _rateLimiterBucketSize(token: string): number {
  return bucketsByToken.get(token)?.length ?? 0;
}

/**
 * Wait for a slot in the rate-limit budget for `token`, then record the slot.
 *
 * Strategy: prune timestamps older than the window. If the resulting bucket
 * has < AWIN_RATE_LIMIT_REQUESTS entries, record `now` and return immediately.
 * Otherwise compute how long until the oldest entry falls out of the window
 * (`oldest + windowMs - now`), sleep that long, and retry.
 *
 * The loop is bounded by the outer `withResilience` timeoutMs — if the budget
 * is saturated for longer than the operation's timeout, the resilience layer
 * surfaces a `timeout` envelope. This is the right user-visible behaviour:
 * "we waited as long as you allowed, the upstream is too busy".
 *
 * Exported so tests can drive the bucket without going via fetch.
 */
export async function acquireRateLimitSlot(
  token: string,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  // Defence in depth: cap the number of wait cycles. In practice the loop
  // terminates after one sleep because the oldest slot must fall out of the
  // window within `windowMs`. We cap at 2x window/slot just in case clock
  // skew or test mocking does something funny.
  const maxCycles = AWIN_RATE_LIMIT_REQUESTS * 2;
  for (let i = 0; i < maxCycles; i++) {
    const t = now();
    const window = bucketsByToken.get(token) ?? [];
    // Prune entries older than (t - windowMs). They no longer count.
    const cutoff = t - AWIN_RATE_LIMIT_WINDOW_MS;
    const live = window.filter((ts) => ts > cutoff);
    if (live.length < AWIN_RATE_LIMIT_REQUESTS) {
      live.push(t);
      bucketsByToken.set(token, live);
      return;
    }
    // Bucket is full. Sleep until the oldest entry falls out of the window.
    const oldest = live[0] as number;
    const waitMs = Math.max(1, oldest + AWIN_RATE_LIMIT_WINDOW_MS - t);
    log.debug({ waitMs, bucketSize: live.length }, 'awin-advertiser rate-limit queue');
    // Persist the pruned bucket so a parallel acquire reads the current state.
    bucketsByToken.set(token, live);
    await sleep(waitMs);
  }
  // Fallback: should be unreachable in practice. Surface as a config_error so
  // the user sees something actionable rather than a silent stall.
  throw new NetworkError(
    buildErrorEnvelope({
      type: 'rate_limit',
      network: SLUG,
      operation: 'rate_limit_acquire',
      message:
        'Awin advertiser rate limiter could not acquire a slot after the maximum number of cycles.',
      hint:
        'This indicates a bug or a clock skew. The Awin limit is 20 calls per minute per user; ' +
        'back off and retry, and if the problem persists report it as a bug.',
    }),
  );
}

/**
 * Issue a single Awin advertiser API request under the resilience policy AND
 * the rate-limit budget.
 *
 * Order of operations is deliberate:
 *   1. Read-only guard — fail fast on non-GET before any work.
 *   2. Resilience wrapper — once per call, applies timeout/retry/breaker.
 *   3. Rate-limit acquire — waits for a slot in the 20-per-minute window.
 *   4. fetch().
 *   5. Status handling — non-2xx throws HttpStatusError, 2xx with non-JSON
 *      throws a NetworkError with the verbatim body.
 *
 * The rate-limit acquire happens INSIDE the resilience callback so each retry
 * consumes its own slot — this is correct behaviour: a retry is a fresh API
 * call from Awin's point of view.
 */
export async function awinAdvRequest<T>(input: AwinAdvRequestInput): Promise<T> {
  // (1) Hard read-only guard. Runs BEFORE any wire I/O so a mis-edited adapter
  // method never reaches Awin. This is defence-in-depth referenced in the
  // adapter's network.json `known_limitations`.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Awin advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must rotate to a token authorised for the relevant ' +
          'Awin write surface (Conversion API, transaction amendment, etc.).',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      // (3) Block until we have a slot in Awin's 20-per-minute budget.
      await acquireRateLimitSlot(input.token);

      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: bearerAuthHeader(input.token),
          Accept: 'application/json',
        },
      };
      if (input.signal) init.signal = input.signal;

      log.debug({ url, operation: input.operation }, 'awin-advertiser request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Awin advertiser ${input.operation} GET ${url} → HTTP ${res.status}`,
        );
      }

      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') return {} as T;

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Awin advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the absolute URL with query string. Exported (and tested) because
 * the `/advertisers/{id}/...` path shape is the single most error-prone piece
 * of the adapter — every data endpoint is parameterised on the brand id.
 */
export function buildUrl(
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(
    pathname.startsWith('/') ? pathname : `/${pathname}`,
    AWIN_ADVERTISER_BASE_URL,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
