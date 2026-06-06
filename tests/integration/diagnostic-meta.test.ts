/**
 * Diagnostic meta-tool rehearsal — PRD §15.3 acceptance test.
 *
 * `runDiagnostic()` (no slug) drives `capabilitiesCheck()` across every
 * registered adapter and returns `DiagnosticResult` whose `results[]` has one
 * entry per network with `NetworkCapabilities`.
 *
 * Per-network capabilitiesCheck tests exist in the five adapter test files;
 * what's missing — and what this file adds — is the integration test of the
 * meta-tool against the populated registry. The acceptance shape is:
 *   - one entry per registered adapter
 *   - each entry has a populated `capabilities.operations` map
 *   - `knownLimitations` is preserved verbatim from the adapter manifest
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../src/networks/index.js';
import { runDiagnostic } from '../../src/shared/diagnostic.js';
import { getAdapters } from '../../src/shared/registry.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { _resetTokenCache } from '../../src/networks/rakuten/auth.js';
import { _resetTokenCache as _resetEbayTokenCache } from '../../src/networks/ebay/auth.js';

/**
 * The probe fetch mock: respond with a plausible success body for every
 * request. The point is not response fidelity — adapters' transformers are
 * exercised exhaustively in their own unit tests — but to confirm the meta
 * tool aggregates all four networks without one failing breaking the others.
 *
 * Rakuten uses a token-exchange call before any data call, and CJ may issue
 * either GraphQL or REST. We respond with a "generic-shaped" envelope that
 * adapter transformers tolerate: an object with empty/zero defaults.
 */
function mockUniversalSuccess(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Rakuten and eBay token exchanges — both POST to a `/token` path.
    if (url.includes('/token')) {
      return new Response(
        JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // eBay reporting / campaign endpoints — respond with empty envelopes
    // shaped per the adapter's transformer expectations.
    if (url.includes('api.ebay.com')) {
      if (url.includes('/affiliate/reporting/v1/transaction')) {
        return new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/affiliate/reporting/v1/click')) {
        return new Response(JSON.stringify({ clicks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/affiliate/campaign/v1/campaign')) {
        return new Response(JSON.stringify({ campaigns: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    // CJ GraphQL responses are envelope-shaped — `data` plus optional `errors`.
    if (url.includes('cj.com')) {
      // Return a generic `data` envelope that satisfies any query: every field
      // is an empty list / null. Adapters read defensively.
      return new Response(
        JSON.stringify({
          data: {
            me: { id: 'fake', companyId: '1234567', firstName: 'Test' },
            publisherCommissions: { count: 0, records: [], payloadComplete: true },
            advertisers: { count: 0, records: [] },
            advertiser: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Default: array body. Awin /publishers and /programmes are arrays;
    // Impact's wrappers are objects but their transformers tolerate either.
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const FIXTURE_ENV: Record<string, string> = {
  AWIN_API_TOKEN: 'fake-awin-token',
  AWIN_PUBLISHER_ID: '12345',
  CJ_API_TOKEN: 'fake-cj-token',
  CJ_COMPANY_ID: '1234567',
  IMPACT_ACCOUNT_SID: 'IRFAKESIDxxxxxxxxxxxxxxxxxxxxxxxxx',
  IMPACT_AUTH_TOKEN: 'fake-impact-token',
  RAKUTEN_CLIENT_ID: 'fake-rakuten-client',
  RAKUTEN_CLIENT_SECRET: 'fake-rakuten-secret',
  RAKUTEN_SID: '4567890',
  EBAY_CLIENT_ID: 'fake-ebay-client-id-12345',
  EBAY_CLIENT_SECRET: 'fake-ebay-client-secret',
  EBAY_CAMPAIGN_ID: '5338000001',
};

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  _resetEbayTokenCache();
  for (const [k, v] of Object.entries(FIXTURE_ENV)) {
    originalEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(FIXTURE_ENV)) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
  _resetBreakers();
  _resetTokenCache();
  _resetEbayTokenCache();
});

describe('runDiagnostic meta-tool (PRD §15.3)', () => {
  it('returns one capabilities entry per registered adapter', async () => {
    mockUniversalSuccess();
    const adapters = getAdapters();
    expect(adapters.length, 'expected all eighty-one adapters registered').toBe(81);

    const result = await runDiagnostic();

    expect(result.results.length).toBe(adapters.length);
    const slugsSeen = new Set(result.results.map((r) => r.network));
    for (const adapter of adapters) {
      expect(slugsSeen.has(adapter.slug)).toBe(true);
    }
  });

  it('every diagnostic entry carries a shaped NetworkCapabilities payload', async () => {
    mockUniversalSuccess();
    const result = await runDiagnostic();

    for (const entry of result.results) {
      expect(
        entry.capabilities,
        `expected capabilities for ${entry.network}; got error: ${entry.error?.message ?? '(none)'}`,
      ).toBeTruthy();
      const cap = entry.capabilities;
      if (!cap) continue;

      expect(cap.network).toBe(entry.network);
      expect(typeof cap.generatedAt).toBe('string');
      expect(Object.keys(cap.operations).length).toBeGreaterThan(0);
      expect(Array.isArray(cap.knownLimitations)).toBe(true);

      // Every operation must report a `supported` boolean — never undefined.
      for (const [opName, opCap] of Object.entries(cap.operations)) {
        expect(
          typeof opCap.supported,
          `${entry.network}/${opName} missing supported boolean`,
        ).toBe('boolean');
      }
    }
  });

  it('records knownLimitations verbatim from the manifest', async () => {
    mockUniversalSuccess();
    const result = await runDiagnostic();

    const adapters = getAdapters();
    for (const adapter of adapters) {
      const entry = result.results.find((r) => r.network === adapter.slug);
      expect(entry?.capabilities?.knownLimitations).toEqual(adapter.meta.knownLimitations);
    }
  });
});
