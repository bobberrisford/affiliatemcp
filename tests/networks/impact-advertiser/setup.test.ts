/**
 * Impact advertiser wizard setup tests.
 *
 * The wizard prompts SID then token; the token validator does the live shape
 * detection. We assert the prompt shape, the per-field validators, and the
 * credential-shape detection helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectCredentialShape,
  validateCredential,
  _resetCredentialCache,
} from '../../../src/networks/impact-advertiser/auth.js';
import { setupSteps } from '../../../src/networks/impact-advertiser/setup.js';

beforeEach(() => {
  _resetCredentialCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetCredentialCache();
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
});

describe('setupSteps', () => {
  it('prompts for IMPACT_ADVERTISER_ACCOUNT_SID then IMPACT_ADVERTISER_AUTH_TOKEN', () => {
    const steps = setupSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]?.field).toBe('IMPACT_ADVERTISER_ACCOUNT_SID');
    expect(steps[1]?.field).toBe('IMPACT_ADVERTISER_AUTH_TOKEN');
    expect(steps[1]?.type).toBe('password');
  });

  it('describes the agency vs brand-direct distinction in the SID prompt', () => {
    const steps = setupSteps();
    const sidDesc = steps[0]?.description ?? '';
    expect(sidDesc.toLowerCase()).toMatch(/agency/);
    expect(sidDesc.toLowerCase()).toMatch(/brand|advertiser/);
  });

  it('recommends a read-only token in the auth-token prompt', () => {
    const steps = setupSteps();
    const tokenDesc = steps[1]?.description ?? '';
    expect(tokenDesc.toLowerCase()).toContain('read-only');
  });
});

describe('detectCredentialShape', () => {
  it('returns agency when /Agencies/{SID} responds 2xx', async () => {
    const shape = await detectCredentialShape('IRA-1', 'tok', {
      probe: async () => ({ status: 200, body: '{"Id":"IRA-1"}' }),
    });
    expect(shape).toBe('agency');
  });

  it('returns brand-direct on 404 (not an agency SID)', async () => {
    const shape = await detectCredentialShape('IRA-1', 'tok', {
      probe: async () => ({ status: 404, body: '{"error":"not-found"}' }),
    });
    expect(shape).toBe('brand-direct');
  });

  it('returns brand-direct on 403 (some tenants forbid /Agencies for brand-direct creds)', async () => {
    const shape = await detectCredentialShape('IRA-1', 'tok', {
      probe: async () => ({ status: 403, body: '{"error":"IsNotAgency"}' }),
    });
    expect(shape).toBe('brand-direct');
  });

  it('throws an auth_error envelope on 401', async () => {
    await expect(
      detectCredentialShape('IRA-1', 'wrong', {
        probe: async () => ({ status: 401, body: 'unauthorized' }),
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('validateCredential', () => {
  it('rejects empty SID', async () => {
    const r = await validateCredential('IMPACT_ADVERTISER_ACCOUNT_SID', '');
    expect(r.ok).toBe(false);
  });

  it('accepts well-formed SID', async () => {
    const r = await validateCredential('IMPACT_ADVERTISER_ACCOUNT_SID', 'IRA-AGENCY-1');
    expect(r.ok).toBe(true);
  });

  it('rejects empty token', async () => {
    const r = await validateCredential('IMPACT_ADVERTISER_AUTH_TOKEN', '');
    expect(r.ok).toBe(false);
  });

  it('defers token validation when SID not yet set', async () => {
    const r = await validateCredential('IMPACT_ADVERTISER_AUTH_TOKEN', 'some-token');
    expect(r.ok).toBe(true);
    expect(r.message ?? '').toMatch(/deferred|Account SID/i);
  });

  it('paste-and-verify: with SID set, runs live shape detection and reports tier', async () => {
    process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'IRA-AGENCY-1';
    // Mock fetch — the shape detector calls /Agencies/{SID}.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ Id: 'IRA-AGENCY-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const r = await validateCredential('IMPACT_ADVERTISER_AUTH_TOKEN', 'tok');
    expect(r.ok).toBe(true);
    expect(r.message ?? '').toMatch(/agency-passthrough/);
  });

  it('returns an unknown-field error for any other field', async () => {
    const r = await validateCredential('UNRELATED_FIELD', 'value');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown credential field/);
  });
});
