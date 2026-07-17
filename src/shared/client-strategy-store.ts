/**
 * Client-strategy store interface (hosted workstream H1,
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Mirrors `src/shared/brand-store.ts`: extracts the operations
 * `src/shared/client-strategy.ts` already exposes into an interface, and
 * binds the existing file-backed functions as the default implementation
 * (`localFileClientStrategyStore`). Behaviour is unchanged: nothing in
 * `client-strategy.ts` is modified, and `getActiveClientStrategyStore()`
 * returns `localFileClientStrategyStore` whenever no request context
 * supplies an override, which is every call today.
 *
 * A hosted per-tenant store is out of scope for this slice (H3); this file
 * only defines the seam.
 */

import {
  type ClientStrategySummary,
  isOrphan,
  listClientStrategies,
  loadClientStrategy,
  loadKpi,
  loadStrategy,
  saveKpi,
  saveStrategy,
} from './client-strategy.js';
import { getRequestContext } from './request-context.js';
import type { ClientStrategy, ClientStrategyFile, KpiParseResult } from './types.js';

export interface ClientStrategyStore {
  loadStrategy(slug: string): ClientStrategyFile;
  loadKpi(slug: string): ClientStrategyFile & { parsed?: KpiParseResult };
  saveStrategy(slug: string, markdown: string): void;
  saveKpi(slug: string, markdown: string): void;
  isOrphan(slug: string): boolean;
  loadClientStrategy(slug: string): ClientStrategy;
  listClientStrategies(): ClientStrategySummary[];
}

/** The current, and only, implementation: `clients/<slug>/*.md` on the local filesystem. */
export const localFileClientStrategyStore: ClientStrategyStore = {
  loadStrategy,
  loadKpi,
  saveStrategy,
  saveKpi,
  isOrphan,
  loadClientStrategy,
  listClientStrategies,
};

/**
 * The store to use for the active request. Falls back to
 * `localFileClientStrategyStore` when no request context is active, or the
 * active context does not override it — the local path today.
 */
export function getActiveClientStrategyStore(): ClientStrategyStore {
  return getRequestContext()?.clientStrategyStore ?? localFileClientStrategyStore;
}
