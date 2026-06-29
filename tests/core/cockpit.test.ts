import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCockpit } from '../../src/core/cockpit.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { NetworkError, buildErrorEnvelope } from '../../src/shared/errors.js';
import type { NetworkAdapter, TransactionQuery } from '../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../src/shared/resilience.js';

/**
 * A controllable stub adapter. `computeCockpit` is a pure registry consumer, so
 * registering a stub under the default `awin` slug exercises the full flag
 * pipeline with no HTTP and no credentials. `setupSteps: []` means the
 * network-free "configured" pre-check passes straight through to the reads.
 */
function stubAdapter(overrides: Partial<NetworkAdapter> = {}): NetworkAdapter {
  const base: NetworkAdapter = {
    slug: 'awin',
    name: 'Awin',
    meta: {
      slug: 'awin',
      name: 'Awin',
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
    getEarningsSummary: async (query?: TransactionQuery) => {
      // Vary by window age so this-week vs prior-week differ deterministically.
      const from = query?.from ? new Date(query.from) : new Date('2000-01-01');
      const ageDays = Math.round((Date.now() - from.getTime()) / 86_400_000);
      const total = ageDays <= 10 ? 50 : 400; // this-week window is recent
      return {
        network: 'awin',
        totalEarnings: total,
        currency: 'GBP',
        byProgramme: [],
        byStatus: { pending: 300, approved: total, reversed: 0, paid: 0, other: 0, currency: 'GBP' },
        oldestUnpaidAgeDays: 120,
        periodFrom: query?.from ?? '',
        periodTo: query?.to ?? '',
      };
    },
    listClicks: async () => [],
    generateTrackingLink: async () => {
      throw new Error('nope');
    },
    verifyAuth: async () => ({ ok: true, identity: 'Acme Outdoors' }),
    listPublishers: async () => {
      throw new Error('nope');
    },
    listPublisherSectors: async () => {
      throw new Error('nope');
    },
    validateCredential: async () => ({ ok: true }),
    setupSteps: () => [],
    capabilitiesCheck: async () => ({
      network: 'awin',
      generatedAt: new Date().toISOString(),
      operations: {},
      knownLimitations: [],
    }),
  };
  return { ...base, ...overrides };
}

beforeEach(() => _clearRegistry());
afterEach(() => vi.restoreAllMocks());

describe('computeCockpit', () => {
  it('reports "not connected" when no adapter is registered', async () => {
    const summary = await computeCockpit({ slug: 'awin' });
    expect(summary.configured).toBe(false);
    expect(summary.flags).toHaveLength(1);
    expect(summary.flags[0]?.kind).toBe('health');
    expect(summary.headline).toBeUndefined();
  });

  it('reports unconfigured without any network read when credentials are missing', async () => {
    const getEarnings = vi.fn();
    registerAdapter(
      stubAdapter({
        setupSteps: () => [
          { field: 'AWIN_API_TOKEN', label: 'token', description: '', type: 'password' },
        ],
        getEarningsSummary: getEarnings as unknown as NetworkAdapter['getEarningsSummary'],
      }),
    );
    const summary = await computeCockpit();
    expect(summary.configured).toBe(false);
    expect(summary.flags[0]?.title).toMatch(/connect/i);
    // The fast path must not touch the network.
    expect(getEarnings).not.toHaveBeenCalled();
  });

  it('computes the unpaid, week-over-week, pending and health flags', async () => {
    registerAdapter(stubAdapter({ listProgrammes: async () => [programme(), programme()] }));
    const summary = await computeCockpit();

    expect(summary.configured).toBe(true);
    expect(summary.headline?.totalEarnings).toBe(400);

    const kinds = summary.flags.map((f) => f.kind);
    expect(kinds).toContain('unpaid_over_threshold');
    expect(kinds).toContain('wow_swing');
    expect(kinds).toContain('pending_applications');

    const wow = summary.flags.find((f) => f.kind === 'wow_swing');
    expect(wow?.title).toMatch(/down/i); // 400 -> 50 is a fall

    const pending = summary.flags.find((f) => f.kind === 'pending_applications');
    expect(pending?.title).toMatch(/2 pending/);

    const health = summary.flags.find((f) => f.kind === 'health');
    expect(health?.severity).toBe('info');
  });

  it('folds a config_error into a health flag instead of throwing', async () => {
    registerAdapter(
      stubAdapter({
        getEarningsSummary: async () => {
          throw new NetworkError(
            buildErrorEnvelope({
              type: 'config_error',
              network: 'awin',
              operation: 'getEarningsSummary',
              message: 'Missing required credential AWIN_API_TOKEN.',
            }),
          );
        },
      }),
    );
    const summary = await computeCockpit();
    expect(summary.configured).toBe(false);
    expect(summary.flags.some((f) => f.kind === 'health' && f.severity === 'error')).toBe(true);
    // No duplicate "connect" spam from the later reads.
    expect(summary.flags).toHaveLength(1);
  });
});

function programme() {
  return {
    id: 'p1',
    name: 'Acme',
    network: 'awin',
    status: 'pending' as const,
    rawNetworkData: {},
  };
}
