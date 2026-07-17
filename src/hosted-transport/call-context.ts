/**
 * Per-HTTP-request identity carrier for the hosted MCP transport (H4).
 *
 * This is deliberately a SEPARATE `AsyncLocalStorage` from
 * `src/shared/request-context.ts` (H1's seam), not an extension of it.
 * H1's `RequestContext` is the seam adapters and shared helpers read
 * (`getCredential`, brand/client-strategy stores); it is a stable, reviewed
 * contract this workstream should not casually widen. This module only needs
 * to carry the raw bearer token from the outer HTTP handler down to the
 * `CallToolRequestSchema` handler (`dispatch.ts`), so it can call the vault
 * with the caller's own token — a hosted-transport-only concern that has
 * nothing to do with what an adapter sees. The two `AsyncLocalStorage`
 * instances nest over the same request without conflict: `http-server.ts`
 * wraps `transport.handleRequest(...)` in this module's context, and
 * `dispatch.ts` separately wraps the adapter call in H1's
 * `runInRequestContext` once it has resolved the credential overlay.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface HostedCallInfo {
  userId: string;
  bearerToken: string;
}

const storage = new AsyncLocalStorage<HostedCallInfo>();

export function runWithHostedCallInfo<T>(info: HostedCallInfo, fn: () => T): T {
  return storage.run(info, fn);
}

export function getHostedCallInfo(): HostedCallInfo | undefined {
  return storage.getStore();
}
