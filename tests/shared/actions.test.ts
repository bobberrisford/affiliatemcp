import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_READ_ACTIONS,
  assembleActionMap,
} from '../../src/shared/actions.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import type { NetworkAdapter } from '../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../src/shared/resilience.js';

function fakeAdapter(slug: string): NetworkAdapter {
  return {
    slug,
    name: slug,
    meta: {
      slug,
      name: slug,
      baseUrl: 'https://example.com',
      authModel: 'bearer',
      adapterVersion: '0.0.1',
      claimStatus: 'experimental',
      knownLimitations: [],
      supportsBrandOps: false,
      setupTimeEstimateMinutes: 1,
      setupRequiresApproval: false,
      side: 'publisher',
      credentialScope: 'single-brand',
    },
    resilienceConfig: { default: DEFAULT_RESILIENCE },
    listProgrammes: async () => [],
    getProgramme: async () => {
      throw new Error('nope');
    },
    listTransactions: async () => [],
    getEarningsSummary: async () => ({
      network: slug,
      totalEarnings: 0,
      currency: 'GBP',
      byProgramme: [],
      byStatus: { pending: 0, approved: 0, reversed: 0, paid: 0, other: 0, currency: 'GBP' },
      periodFrom: '2026-01-01',
      periodTo: '2026-01-02',
    }),
    listClicks: async () => [],
    generateTrackingLink: async () => {
      throw new Error('nope');
    },
    verifyAuth: async () => ({ ok: true }),
    listPublishers: async () => {
      throw new Error('nope');
    },
    listPublisherSectors: async () => {
      throw new Error('nope');
    },
    validateCredential: async () => ({ ok: true }),
    setupSteps: () => [],
    capabilitiesCheck: async () => ({
      network: slug,
      generatedAt: new Date().toISOString(),
      operations: {},
      knownLimitations: [],
    }),
  };
}

beforeEach(() => _clearRegistry());

describe('CANONICAL_READ_ACTIONS', () => {
  it('declares exactly the seven canonical reads, all api/read/Tier 0', () => {
    expect(CANONICAL_READ_ACTIONS).toHaveLength(7);
    expect(CANONICAL_READ_ACTIONS.map((a) => a.action)).toEqual([
      'listProgrammes',
      'getProgramme',
      'listTransactions',
      'getEarningsSummary',
      'listClicks',
      'generateTrackingLink',
      'verifyAuth',
    ]);
    for (const descriptor of CANONICAL_READ_ACTIONS) {
      expect(descriptor.channel).toBe('api');
      expect(descriptor.effect).toBe('read');
      expect(descriptor.defaultTier).toBe(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it('excludes advertiser-only reads so the map invents no capability', () => {
    const names = CANONICAL_READ_ACTIONS.map((a) => a.action);
    expect(names).not.toContain('listMediaPartners');
    expect(names).not.toContain('getProgrammePerformance');
  });
});

describe('assembleActionMap', () => {
  it('binds each canonical read to every registered adapter as available', () => {
    registerAdapter(fakeAdapter('alpha'));
    registerAdapter(fakeAdapter('beta'));

    const map = assembleActionMap();

    expect(map).toHaveLength(7 * 2);
    expect(map.every((e) => e.available)).toBe(true);
    expect(new Set(map.map((e) => e.network))).toEqual(new Set(['alpha', 'beta']));
    expect(map.filter((e) => e.network === 'alpha')).toHaveLength(7);
  });

  it('scopes to a single network when asked', () => {
    registerAdapter(fakeAdapter('alpha'));
    registerAdapter(fakeAdapter('beta'));

    const map = assembleActionMap(undefined, { network: 'beta' });

    expect(map).toHaveLength(7);
    expect(map.every((e) => e.network === 'beta')).toBe(true);
  });

  it('returns an empty map when no adapters are registered', () => {
    expect(assembleActionMap()).toEqual([]);
  });

  it('accepts an explicit adapter set without touching the registry', () => {
    const map = assembleActionMap([fakeAdapter('gamma')]);
    expect(map).toHaveLength(7);
    expect(map.every((e) => e.network === 'gamma')).toBe(true);
  });
});
