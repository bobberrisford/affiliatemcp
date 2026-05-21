/**
 * Template: HTTP client for <NETWORK_NAME>.
 *
 * Wrap every outbound request in `withResilience` from `src/shared/resilience.ts`.
 * Throw `HttpStatusError` on non-2xx so retry policy applies uniformly.
 * Never call `fetch` directly outside this file.
 */

// TODO: import { withResilience, HttpStatusError } from '../../src/shared/resilience.js';
// TODO: implement a small `request<T>(operation, init)` helper using fetch.
export {};
