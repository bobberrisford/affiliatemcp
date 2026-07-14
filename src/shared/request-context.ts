/**
 * Request-scoped identity seam (hosted workstream H1,
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Why this exists: the local server serves exactly one operator per process,
 * so every credential lookup, OAuth token cache, and file-backed store keys
 * itself implicitly on "the current process". A hosted deployment serves many
 * tenants from shared processes, so credential, token-cache, brand, and
 * client-strategy resolution need a per-call identity to key against instead.
 *
 * This module is the single seam: an `AsyncLocalStorage`-backed context that
 * follows one MCP tool call through every `await` it makes, without adapters
 * or shared helpers needing to thread a context object through every
 * function signature. `src/server.ts` establishes `localDefaultContext()`
 * around every `tools/call` dispatch — that is the "first consumer" this
 * slice wires up.
 *
 * Local-path parity is load-bearing: `localDefaultContext()` carries a fixed
 * identity and no credential overlay or store overrides, so
 * `getCredential`/`requireCredential` (`src/shared/config.ts`),
 * `getActiveBrandStore()` (`src/shared/brand-store.ts`), and
 * `getActiveClientStrategyStore()` (`src/shared/client-strategy-store.ts`)
 * all fall through to exactly what they did before this module existed.
 * Outside of any `runInRequestContext` call (e.g. the CLI, the setup wizard,
 * or a test that calls an adapter directly) `getRequestContext()` returns
 * `undefined` and every helper falls back the same way.
 *
 * Hosted (H2+) is expected to call `runInRequestContext` with a per-tenant
 * identity, a `credentials` overlay sourced from the encrypted vault (H3),
 * and vault-backed `brandStore` / `clientStrategyStore` implementations.
 * None of that exists yet — this module only defines the seam and the
 * local default.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { BrandStore } from './brand-store.js';
import type { ClientStrategyStore } from './client-strategy-store.js';

/** The identity used by the local, single-user server path. */
export const LOCAL_IDENTITY = 'local-default';

export interface RequestContext {
  /**
   * Keys OAuth token caches and any per-tenant store. The local default is
   * the constant `LOCAL_IDENTITY`, so the local path always resolves to the
   * same single cache entry it always has.
   */
  identity: string;
  /**
   * Credential overlay consulted before `process.env`. Absent for the local
   * path — `getCredential` falls back to `process.env` exactly as today.
   */
  credentials?: Readonly<Record<string, string>>;
  /** Per-request brand store override. Absent for the local path. */
  brandStore?: BrandStore;
  /** Per-request client-strategy store override. Absent for the local path. */
  clientStrategyStore?: ClientStrategyStore;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` active for its entire async lifetime (every
 * `await` inside it, and inside anything it calls, observes the same
 * context). Returns whatever `fn` returns, so callers can `await` the
 * result normally.
 */
export function runInRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active context, or `undefined` outside any `runInRequestContext` call. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The active identity, or `LOCAL_IDENTITY` outside any request context. */
export function getRequestIdentity(): string {
  return storage.getStore()?.identity ?? LOCAL_IDENTITY;
}

/**
 * The context-overlay value for a credential name, or `undefined` when no
 * context is active or the context has no overlay for that name. Consumed by
 * `getCredential` (`src/shared/config.ts`) before it falls back to
 * `process.env`.
 */
export function getContextCredential(name: string): string | undefined {
  return storage.getStore()?.credentials?.[name];
}

/**
 * The context used for the local, single-user server path. A fixed identity,
 * no credential overlay, no store overrides — byte-identical behaviour to
 * running with no request context at all.
 */
export function localDefaultContext(): RequestContext {
  return { identity: LOCAL_IDENTITY };
}
