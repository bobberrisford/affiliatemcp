/**
 * Integration: brands.json → brand-resolver → tool dispatch → adapter.
 *
 * Confirms that the seam closed in PR 3 actually threads `networkBrandId` all
 * the way from the operator-supplied `brand` slug down to the adapter call.
 * The adapter under test is the real Impact advertiser adapter; we mock fetch
 * to assert the URL shape includes the expected BrandSID.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import '../../src/networks/impact-advertiser/adapter.js';
import { generateToolsFor } from '../../src/tools/generate.js';
import { getAdapter } from '../../src/shared/registry.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { _resetCredentialCache } from '../../src/networks/impact-advertiser/auth.js';
import { saveBrands } from '../../src/shared/brands.js';
import { BrandNotRegistered } from '../../src/shared/errors.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  _resetBreakers();
  _resetCredentialCache();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-brand-thread-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'IRA-AGENCY-1';
  process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  _resetCredentialCache();
});

describe('brand context threading (PR 3 seam)', () => {
  it('a brand bound in brands.json reaches the adapter as networkBrandId in the URL path', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1001' },
        ],
      },
    });

    // Mock fetch: first call is the shape-detection probe (return agency
    // success), second call is the listProgrammes API call.
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      // shape detection probe
      if (url.endsWith('/Agencies/IRA-AGENCY-1')) {
        return new Response(JSON.stringify({ Id: 'IRA-AGENCY-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ Campaigns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const adapter = getAdapter('impact-advertiser');
    expect(adapter, 'impact-advertiser adapter must be registered').toBeTruthy();
    const tools = generateToolsFor(adapter!);
    const listProgrammes = tools.find(
      (t) => t.name === 'affiliate_impact-advertiser_list_programmes',
    );
    expect(listProgrammes, 'list_programmes tool generated for advertiser adapter').toBeTruthy();

    await listProgrammes!.handle({ brand: 'acme' });

    // The 2nd URL is the actual API call — must contain the resolved BrandSID.
    expect(urls.length).toBeGreaterThanOrEqual(2);
    const apiCallUrl = urls[urls.length - 1]!;
    expect(apiCallUrl).toContain('/Advertisers/IA-1001/Campaigns');
    // Agency-tier credentials → the agency prefix is present.
    expect(apiCallUrl).toContain('/Agencies/IRA-AGENCY-1/');
  });

  it('a brand not in brands.json fails with BrandNotRegistered before any network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const adapter = getAdapter('impact-advertiser');
    const tools = generateToolsFor(adapter!);
    const listProgrammes = tools.find(
      (t) => t.name === 'affiliate_impact-advertiser_list_programmes',
    )!;

    await expect(listProgrammes.handle({ brand: 'unknown-brand' })).rejects.toBeInstanceOf(
      BrandNotRegistered,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('advertiser-only operations (listMediaPartners, getProgrammePerformance) are exposed as tools', () => {
    const adapter = getAdapter('impact-advertiser');
    const tools = generateToolsFor(adapter!);
    const names = tools.map((t) => t.name);
    expect(names).toContain('affiliate_impact-advertiser_list_media_partners');
    expect(names).toContain('affiliate_impact-advertiser_get_programme_performance');
  });

  it('publisher adapters never expose advertiser-only operations', async () => {
    // Import the publisher Impact adapter and confirm its tools do not include
    // the advertiser-only operations.
    await import('../../src/networks/impact/adapter.js');
    const adapter = getAdapter('impact');
    const tools = generateToolsFor(adapter!);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('affiliate_impact_list_media_partners');
    expect(names).not.toContain('affiliate_impact_get_programme_performance');
  });
});
