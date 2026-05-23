import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearRegistry,
  getAdapter,
  getAdapters,
  registerAdapter,
} from '../../src/shared/registry.js';
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

describe('registry', () => {
  it('round-trips a registered adapter', () => {
    const a = fakeAdapter('test');
    registerAdapter(a);
    expect(getAdapter('test')).toBe(a);
    expect(getAdapters()).toEqual([a]);
  });

  it('refuses double registration', () => {
    const a = fakeAdapter('dup');
    registerAdapter(a);
    expect(() => registerAdapter(fakeAdapter('dup'))).toThrow();
  });

  it('returns undefined for unknown slug', () => {
    expect(getAdapter('missing')).toBeUndefined();
  });
});
