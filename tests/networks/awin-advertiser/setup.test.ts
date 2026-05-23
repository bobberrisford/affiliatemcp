/**
 * Awin advertiser wizard setup tests.
 *
 * The wizard prompts for a single OAuth bearer token and runs a live
 * verifyAuth probe (`GET /accounts`). We assert prompt shape, validator
 * behaviour, the paste-and-verify path, and the publisher-token reuse
 * suggestion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateCredential } from '../../../src/networks/awin-advertiser/auth.js';
import { setupSteps } from '../../../src/networks/awin-advertiser/setup.js';
import { _resetRateLimiter } from '../../../src/networks/awin-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

beforeEach(() => {
  _resetBreakers();
  _resetRateLimiter();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetRateLimiter();
  delete process.env['AWIN_ADVERTISER_API_TOKEN'];
  delete process.env['AWIN_API_TOKEN'];
});

describe('setupSteps', () => {
  it('prompts for AWIN_ADVERTISER_API_TOKEN exactly once', () => {
    const steps = setupSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.field).toBe('AWIN_ADVERTISER_API_TOKEN');
    expect(steps[0]?.type).toBe('password');
  });

  it('mentions the read-only stance and the rate limit in the description', () => {
    const desc = (setupSteps()[0]?.description ?? '').toLowerCase();
    expect(desc).toContain('read-only');
    expect(desc).toMatch(/20[- ]calls[- ]per[- ]minute|20 calls per minute/);
  });

  it('mentions the Accelerate / Advanced plan gate', () => {
    const desc = (setupSteps()[0]?.description ?? '').toLowerCase();
    expect(desc).toMatch(/accelerate|advanced|entry/);
  });

  it('suggests reusing AWIN_API_TOKEN when the publisher token is already set', () => {
    process.env['AWIN_API_TOKEN'] = 'publisher-token';
    const desc = setupSteps()[0]?.description ?? '';
    expect(desc).toContain('AWIN_API_TOKEN');
    expect(desc.toLowerCase()).toContain('reuse');
    // We do NOT auto-copy; the suggestion must say so.
    expect(desc.toLowerCase()).toContain('not auto-copy');
  });

  it('omits the reuse suggestion when no publisher token is configured', () => {
    delete process.env['AWIN_API_TOKEN'];
    const desc = setupSteps()[0]?.description ?? '';
    expect(desc).not.toMatch(/already have an Awin publisher token/);
  });
});

describe('validateCredential', () => {
  it('rejects an empty token', async () => {
    const r = await validateCredential('AWIN_ADVERTISER_API_TOKEN', '');
    expect(r.ok).toBe(false);
  });

  it('paste-and-verify: runs the live /accounts probe and reports verified', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { accountId: 1, accountName: 'A', type: 'advertiser' },
            { accountId: 2, accountName: 'P', type: 'publisher' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const r = await validateCredential('AWIN_ADVERTISER_API_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
    expect(r.message ?? '').toMatch(/verified/i);
    // The message should mention the advertiser-account count, not the total.
    expect(r.message ?? '').toMatch(/1-advertiser-account/);
  });

  it('paste-and-verify: reports failure on 401', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('unauthorized', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const r = await validateCredential('AWIN_ADVERTISER_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
  });

  it('returns an unknown-field error for any other field', async () => {
    const r = await validateCredential('UNRELATED_FIELD', 'value');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown credential field/);
  });
});
