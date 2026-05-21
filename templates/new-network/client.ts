/**
 * Template: HTTP client for <NETWORK_NAME>.
 *
 * This file is the only sanctioned `fetch` site for this network. The rest of
 * the adapter goes through the helper exported here, which wraps every call
 * in `withResilience` from `src/shared/resilience.ts`. That wrapper enforces
 * the project's timeout / retry / circuit-breaker policy uniformly.
 *
 * Reference: src/networks/awin/client.ts (bearer token, REST);
 *            src/networks/cj/client.ts (GraphQL + REST helpers);
 *            src/networks/impact/client.ts (Basic auth + path prefixing).
 *
 * What this file should export:
 *
 *   1. `<network>Request<T>({ operation, path, token, query?, method?, body?, resilience? })`
 *      — the only public helper. Returns the parsed response body of type T.
 *
 *   2. Re-export `HttpStatusError` from `src/shared/resilience.ts` so the
 *      adapter can identify HTTP failures by status without re-importing.
 *
 * Implementation requirements:
 *
 *   - Wrap the `fetch` call inside `withResilience(operation, resilience, async () => { ... })`.
 *   - On non-2xx, throw `new HttpStatusError(status, rawBody, message)`. The
 *     resilience layer's retry policy applies based on `status`. Do NOT
 *     retry on 4xx other than 429 — DEFAULT_RESILIENCE.retryOn enforces this.
 *   - Always read the response body before returning, even on success, so
 *     a verbatim copy can travel with any error envelope downstream.
 *   - Set `Accept: application/json` if the network can return XML by
 *     default (Impact, older Rakuten endpoints).
 *
 * API behaviour to verify:
 *   - What headers are required? Bearer? Basic? Custom?
 *   - Does the API return JSON by default or XML? Force JSON via `Accept`.
 *   - Does the API rate-limit and how is the limit communicated? (`Retry-After`?)
 *   - Are there per-endpoint quirks (Impact: paths prefixed
 *     `/Mediapartners/{accountSid}`; CJ: separate GraphQL hostnames for
 *     commissions vs ads)? Centralise the quirks here so the adapter stays
 *     readable.
 *
 * Error handling:
 *   Throwing `HttpStatusError(status, rawBody, ...)` is the canonical path —
 *   the resilience layer + the adapter's catch site translate it into a
 *   NetworkErrorEnvelope. Never silently swallow a non-2xx.
 */

// TODO: import { withResilience, HttpStatusError, DEFAULT_RESILIENCE } from '../../src/shared/resilience.js';
// TODO: import type { ResilienceConfig } from '../../src/shared/types.js';
// TODO: import { createLogger } from '../../src/shared/logging.js';
// TODO: export async function <network>Request<T>(opts: { ... }): Promise<T> { ... }
// TODO: export { HttpStatusError };
export {};
