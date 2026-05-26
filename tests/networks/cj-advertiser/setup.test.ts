/**
 * CJ advertiser wizard setup tests.
 *
 * The wizard prompts for the PAT and runs a live verifyAuth probe (a cheap
 * commissionDetails query). We assert prompt shape, validator behaviour, the
 * paste-and-verify path, and the publisher-PAT reuse suggestion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateCredential } from '../../../src/networks/cj-advertiser/auth.js';
import { setupSteps } from '../../../src/networks/cj-advertiser/setup.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

beforeEach(() => {
  _resetBreakers();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CJ_ADVERTISER_API_TOKEN'];
  delete process.env['CJ_API_TOKEN'];
});

describe('setupSteps', () => {
  it('prompts for CJ_ADVERTISER_API_TOKEN exactly once', () => {
    const steps = setupSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.field).toBe('CJ_ADVERTISER_API_TOKEN');
    expect(steps[0]?.type).toBe('password');
  });

  it('mentions the read-only stance in the description', () => {
    const desc = (setupSteps()[0]?.description ?? '').toLowerCase();
    expect(desc).toContain('read-only');
  });

  it('suggests reusing CJ_API_TOKEN when the publisher PAT is already set', () => {
    process.env['CJ_API_TOKEN'] = 'publisher-pat';
    const desc = setupSteps()[0]?.description ?? '';
    expect(desc).toContain('CJ_API_TOKEN');
    expect(desc.toLowerCase()).toContain('reuse');
    // We do NOT auto-copy; the suggestion must say so.
    expect(desc.toLowerCase()).toContain('not auto-copy');
  });

  it('omits the reuse suggestion when no publisher PAT is configured', () => {
    delete process.env['CJ_API_TOKEN'];
    const desc = setupSteps()[0]?.description ?? '';
    expect(desc).not.toMatch(/already have a CJ publisher PAT/);
  });
});

describe('validateCredential', () => {
  it('rejects an empty token', async () => {
    const r = await validateCredential('CJ_ADVERTISER_API_TOKEN', '');
    expect(r.ok).toBe(false);
  });

  it('paste-and-verify: runs the live commissionDetails probe and reports verified', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { commissionDetails: { payloadComplete: true, count: 0 } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const r = await validateCredential('CJ_ADVERTISER_API_TOKEN', 'fresh-pat');
    expect(r.ok).toBe(true);
    expect(r.message ?? '').toMatch(/verified/i);
  });

  it('paste-and-verify: reports failure on 401', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('unauthorized', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const r = await validateCredential('CJ_ADVERTISER_API_TOKEN', 'bad-pat');
    expect(r.ok).toBe(false);
  });

  it('returns an unknown-field error for any other field', async () => {
    const r = await validateCredential('UNRELATED_FIELD', 'value');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown credential field/);
  });
});
