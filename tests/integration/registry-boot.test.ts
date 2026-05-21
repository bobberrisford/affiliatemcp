/**
 * Registry-boot integration smoke test.
 *
 * Confirms that importing the network aggregator (`src/networks/index.ts`)
 * actually populates the shared adapter registry — i.e. that every adapter's
 * top-level `registerAdapter(...)` side effect fires at module load.
 *
 * This is a wiring test, not an Awin re-test. It guards against the failure
 * mode where the aggregator exists but no entry point imports it, leaving
 * `affiliate_list_networks` / `affiliate_run_diagnostic` empty at runtime.
 */

import { describe, expect, it } from 'vitest';

import '../../src/networks/index.js';
import { getAdapter, getAdapters } from '../../src/shared/registry.js';

describe('network aggregator boot', () => {
  it('registers the awin adapter on import', () => {
    const awin = getAdapter('awin');
    expect(awin).toBeTruthy();
    expect(awin?.slug).toBe('awin');
    expect(awin?.name).toBe('Awin');
  });

  it('registers the impact adapter on import', () => {
    const impact = getAdapter('impact');
    expect(impact).toBeTruthy();
    expect(impact?.slug).toBe('impact');
    expect(impact?.name).toBe('Impact');
  });

  it('populates the registry with at least one adapter', () => {
    expect(getAdapters().length).toBeGreaterThanOrEqual(1);
  });
});
