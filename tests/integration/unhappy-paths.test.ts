/**
 * Integration: unhappy-path coverage for the advertiser-side stack.
 *
 * Four cases the reviewer (@offmann) flagged on PR #4:
 *
 *   1. **Brand missing from brands.json** — an advertiser tool is invoked with
 *      a slug that isn't registered; the brand-resolver throws
 *      `BrandNotRegistered` BEFORE any outbound network call.
 *
 *   2. **Ambiguous brand resolution** — the same logical brand is bound on
 *      two networks. Invoking the impact-advertiser tool resolves to the
 *      impact-advertiser `networkBrandId`, NOT the cj-advertiser one;
 *      invoking against a third network (where the slug isn't bound) raises
 *      `BrandNotRegistered`.
 *
 *   3. **Partial brand discovery** — a multi-brand adapter returns three
 *      brands, one of them with `apiEnabled: false`. The wizard registers all
 *      three, flags the false one in the transcript, and a subsequent tool
 *      invocation against the inaccessible brand surfaces the network's
 *      error envelope (not a silent success).
 *
 *   4. **Async report timeout** — Impact's `getProgrammePerformance` async
 *      path: initial POST returns `{ ResultUri }` but no completed_at within
 *      the documented 60s window. Adapter surfaces a `timeout` envelope.
 *
 * All tests are deterministic — fetch is mocked and time-sensitive paths use
 * `vi.useFakeTimers()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import '../../src/networks/impact-advertiser/adapter.js';
import '../../src/networks/cj-advertiser/adapter.js';
import '../../src/networks/awin-advertiser/adapter.js';

import { generateToolsFor } from '../../src/tools/generate.js';
import { getAdapter } from '../../src/shared/registry.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { _resetCredentialCache } from '../../src/networks/impact-advertiser/auth.js';
import { saveBrands } from '../../src/shared/brands.js';
import { BrandNotRegistered, NetworkError } from '../../src/shared/errors.js';
import {
  resolveBrandForNetwork,
  buildAdapterCallContext,
} from '../../src/shared/brand-resolver.js';
import { runBrandDiscovery } from '../../src/cli/wizard/brand-discovery.js';
import { FakePrompter, makeFakeAdapter } from '../cli/fakes.js';
import type {
  DiscoveredBrand,
  NetworkAdapter,
  NetworkMeta,
} from '../../src/shared/types.js';
import { impactAdvertiserAdapter } from '../../src/networks/impact-advertiser/adapter.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  _resetBreakers();
  _resetCredentialCache();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-unhappy-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'IRA-AGENCY-1';
  process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = 'fake-token';
  process.env['CJ_ADVERTISER_API_TOKEN'] = 'fake-cj-token';
  process.env['AWIN_ADVERTISER_API_TOKEN'] = 'fake-awin-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  delete process.env['CJ_ADVERTISER_API_TOKEN'];
  delete process.env['AWIN_ADVERTISER_API_TOKEN'];
  _resetCredentialCache();
  _resetBreakers();
});

// ---------------------------------------------------------------------------
// Case 1: brand missing from brands.json
// ---------------------------------------------------------------------------

describe('unhappy path 1 — brand missing from brands.json', () => {
  it('an advertiser tool invoked with an unknown slug throws BrandNotRegistered and never calls fetch', async () => {
    // No saveBrands() — brands.json is empty.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const adapter = getAdapter('impact-advertiser');
    const tools = generateToolsFor(adapter!);
    const tool = tools.find((t) => t.name === 'affiliate_impact-advertiser_list_programmes')!;

    await expect(tool.handle({ brand: 'ghost' })).rejects.toBeInstanceOf(BrandNotRegistered);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the BrandNotRegistered error names both the brand and the network', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(() => resolveBrandForNetwork('ghost', 'impact-advertiser')).toThrow(
      /Brand "ghost".*impact-advertiser/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 2: ambiguous resolution — same slug, two networks
// ---------------------------------------------------------------------------

describe('unhappy path 2 — ambiguous brand resolution across networks', () => {
  beforeEach(() => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1001' },
          { network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-7777777' },
        ],
      },
    });
  });

  it('resolves to the per-network id when the network is specified', () => {
    const impact = resolveBrandForNetwork('acme', 'impact-advertiser');
    const cj = resolveBrandForNetwork('acme', 'cj-advertiser');
    expect(impact.networkBrandId).toBe('IA-1001');
    expect(cj.networkBrandId).toBe('CJ-7777777');
    expect(impact.networkBrandId).not.toBe(cj.networkBrandId);
  });

  it('threads the correct per-network id into the adapter call context', () => {
    const impactCtx = buildAdapterCallContext('acme', 'impact-advertiser');
    const cjCtx = buildAdapterCallContext('acme', 'cj-advertiser');
    expect(impactCtx.networkBrandId).toBe('IA-1001');
    expect(cjCtx.networkBrandId).toBe('CJ-7777777');
  });

  it('throws BrandNotRegistered when a third network is queried with the same slug', () => {
    expect(() => resolveBrandForNetwork('acme', 'awin-advertiser')).toThrow(BrandNotRegistered);
  });
});

// ---------------------------------------------------------------------------
// Case 3: partial brand discovery — apiEnabled:false brand registered + later
// rejected by the network.
// ---------------------------------------------------------------------------

describe('unhappy path 3 — partial brand discovery (apiEnabled:false flagged then rejected)', () => {
  function multiBrandFake(brands: DiscoveredBrand[]): NetworkAdapter {
    const a = makeFakeAdapter({ slug: 'fake-adv', name: 'Fake Advertiser', steps: [] });
    const meta: NetworkMeta = {
      ...a.meta,
      side: 'advertiser',
      credentialScope: 'multi-brand',
    };
    (a as { meta: NetworkMeta }).meta = meta;
    a.listBrands = async () => brands;
    return a;
  }

  it('registers all three brands but flags the apiEnabled:false one in the transcript', async () => {
    const adapter = multiBrandFake([
      { networkBrandId: 'B-1', displayName: 'Acme', apiEnabled: true },
      { networkBrandId: 'B-2', displayName: 'Globex', apiEnabled: true },
      { networkBrandId: 'B-3', displayName: 'Initech (Entry tier)', apiEnabled: false },
    ]);

    // Operator ticks all three (overriding the default of only the two
    // api-enabled brands), accepts the suggested slugs.
    const prompter = new FakePrompter([
      ['B-1', 'B-2', 'B-3'],
      '', '', '',
    ]);
    const lines: string[] = [];
    const outcome = await runBrandDiscovery(adapter, prompter, { out: (l) => lines.push(l) });

    expect(outcome.registered.map((r) => r.networkBrandId).sort()).toEqual(['B-1', 'B-2', 'B-3']);
    // The third brand must be flagged in BOTH the offer line and the
    // registration confirmation as not-API-accessible.
    const text = lines.join('\n');
    expect(text).toMatch(/Initech.*not API-accessible/i);
    expect(text).toMatch(/Registered initech-entry-tier.*not API-accessible/i);
  });

  it('a tool invocation against an inaccessible brand surfaces the network rejection — never silent', async () => {
    // Bind acme to the real impact-advertiser network. We then mock the
    // network to 403 the data endpoint, mirroring an Entry-tier brand.
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-DENY' },
        ],
      },
    });
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      // Shape detection probe — return agency success so we proceed.
      if (url.endsWith('/Agencies/IRA-AGENCY-1')) {
        return new Response(JSON.stringify({ Id: 'IRA-AGENCY-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The actual /Advertisers/IA-DENY/... call: 403.
      return new Response('not authorised for this advertiser', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const adapter = getAdapter('impact-advertiser');
    const tools = generateToolsFor(adapter!);
    const tool = tools.find((t) => t.name === 'affiliate_impact-advertiser_list_programmes')!;

    let caught: unknown;
    try {
      await tool.handle({ brand: 'acme' });
    } catch (err) {
      caught = err;
    }
    expect(caught, 'tool must surface the network rejection — not silently succeed').toBeTruthy();
    // The error rounds-trips through NetworkErrorEnvelope (NetworkError wraps it).
    if (caught instanceof NetworkError) {
      expect(caught.envelope.network).toBe('impact-advertiser');
      expect(caught.envelope.operation).toBe('listProgrammes');
      expect(['network_api_error', 'auth_error']).toContain(caught.envelope.type);
    } else {
      expect(caught).toBeInstanceOf(NetworkError);
    }
    // Confirm an outbound call actually went out (we are not failing earlier
    // for an unrelated reason).
    expect(urls.some((u) => u.includes('IA-DENY'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4: async report timeout — Impact getProgrammePerformance ResultUri polling
// ---------------------------------------------------------------------------

describe('unhappy path 4 — Impact getProgrammePerformance async timeout', () => {
  beforeEach(() => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-TIMEOUT' },
        ],
      },
    });
  });

  it('surfaces a `timeout` envelope when the ResultUri never completes within the 60s window', async () => {
    // Fake timers — the adapter polls with 2s sleeps inside a 60s loop. We
    // queue responses that always look "still running" so the loop reaches
    // its timeout deterministically.
    vi.useFakeTimers();

    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      // Shape-detection probe: succeed as agency.
      if (url.endsWith('/Agencies/IRA-AGENCY-1')) {
        return new Response(JSON.stringify({ Id: 'IRA-AGENCY-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // First "POST" to the report endpoint: return a ResultUri so the
      // adapter switches to polling mode.
      if (url.includes('/Reports/adv_performance_by_media')) {
        return new Response(
          JSON.stringify({ ResultUri: '/Advertisers/IA-TIMEOUT/Reports/queued/42', Status: 'queued' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Every poll: still queued.
      return new Response(JSON.stringify({ Status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // Drive the adapter directly so we exercise the polling loop without
    // going through tool dispatch (the tool layer wraps errors).
    const promise = impactAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-01-01', to: '2026-01-31' },
      { networkBrandId: 'IA-TIMEOUT' },
    );
    // Capture rejection separately so we don't surface unhandled rejection.
    const settle = promise.catch((e) => e);

    // Advance clock past the documented 60s polling window. The adapter
    // sleeps in 2s steps; rolling 70s ensures we cross the boundary.
    await vi.advanceTimersByTimeAsync(70_000);

    const err = await settle;
    expect(err).toBeInstanceOf(NetworkError);
    if (err instanceof NetworkError) {
      expect(err.envelope.type).toBe('timeout');
      expect(err.envelope.network).toBe('impact-advertiser');
      expect(err.envelope.operation).toBe('getProgrammePerformance');
      // The message names the documented 60s budget (see adapter source).
      expect(err.envelope.message).toMatch(/60000ms|60s|exceeded/i);
    }
  });
});
