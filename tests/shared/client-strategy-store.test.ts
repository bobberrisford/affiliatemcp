/**
 * Client-strategy store interface (hosted workstream H1).
 *
 * Mirrors `tests/shared/brand-store.test.ts`:
 *   - `localFileClientStrategyStore` has parity with calling
 *     `client-strategy.ts` directly;
 *   - `getActiveClientStrategyStore()` returns the local file store when no
 *     request context is active, or the active context does not override it;
 *   - a request-context override is honoured, and does not touch the local
 *     files at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  listClientStrategies,
  loadClientStrategy,
  loadStrategy,
  saveStrategy,
} from '../../src/shared/client-strategy.js';
import {
  getActiveClientStrategyStore,
  localFileClientStrategyStore,
  type ClientStrategyStore,
} from '../../src/shared/client-strategy-store.js';
import { runInRequestContext } from '../../src/shared/request-context.js';
import type { ClientStrategy, ClientStrategyFile } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-client-strategy-store-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

describe('localFileClientStrategyStore — parity with client-strategy.ts', () => {
  it('saveStrategy + loadStrategy through the store matches calling client-strategy.ts directly', () => {
    localFileClientStrategyStore.saveStrategy('acme', '# Acme strategy\n');
    expect(localFileClientStrategyStore.loadStrategy('acme')).toEqual(loadStrategy('acme'));
  });

  it('loadClientStrategy through the store matches the direct function', () => {
    saveStrategy('acme', '# Acme strategy\n');
    expect(localFileClientStrategyStore.loadClientStrategy('acme')).toEqual(
      loadClientStrategy('acme'),
    );
  });

  it('a missing client is present:false through both paths', () => {
    const direct: ClientStrategyFile = loadStrategy('never-recorded');
    const viaStore = localFileClientStrategyStore.loadStrategy('never-recorded');
    expect(viaStore).toEqual(direct);
    expect(viaStore.present).toBe(false);
  });

  it('listClientStrategies through the store matches the direct function', () => {
    saveStrategy('acme', '# Acme\n');
    expect(localFileClientStrategyStore.listClientStrategies()).toEqual(listClientStrategies());
  });
});

describe('getActiveClientStrategyStore()', () => {
  it('returns the local file store when no request context is active', () => {
    expect(getActiveClientStrategyStore()).toBe(localFileClientStrategyStore);
  });

  it('returns the local file store when the active context does not override it', () => {
    const store = runInRequestContext({ identity: 'tenant-a' }, () =>
      getActiveClientStrategyStore(),
    );
    expect(store).toBe(localFileClientStrategyStore);
  });

  it('returns a request-context override in place of the local file store', () => {
    const calls: string[] = [];
    const fakeStrategy: ClientStrategy = {
      brand: 'acme',
      orphan: false,
      strategy: { present: false },
      kpi: { present: false },
    };
    const fakeStore: ClientStrategyStore = {
      loadStrategy: () => ({ present: false }),
      loadKpi: () => ({ present: false }),
      saveStrategy: () => calls.push('saveStrategy'),
      saveKpi: () => calls.push('saveKpi'),
      isOrphan: () => false,
      loadClientStrategy: (slug: string) => {
        calls.push(`loadClientStrategy:${slug}`);
        return fakeStrategy;
      },
      listClientStrategies: () => [],
    };

    const result = runInRequestContext(
      { identity: 'tenant-a', clientStrategyStore: fakeStore },
      () => getActiveClientStrategyStore().loadClientStrategy('acme'),
    );

    expect(result).toBe(fakeStrategy);
    expect(calls).toEqual(['loadClientStrategy:acme']);
    // The override never touched the local clients/ directory.
    expect(loadStrategy('acme').present).toBe(false);
  });
});
