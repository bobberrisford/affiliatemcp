/**
 * Tests for `src/tools/confirmation.ts`.
 *
 * Covers:
 *   - fingerprint stability (key order) and sensitivity (payload changes)
 *   - issue/redeem happy path
 *   - single-use (a token redeems once)
 *   - expiry
 *   - fingerprint mismatch (the request changed)
 *   - unknown token
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  actionFingerprint,
  issueConfirmation,
  redeemConfirmation,
  resetConfirmationStore,
} from '../../src/tools/confirmation.js';

beforeEach(() => resetConfirmationStore());
afterEach(() => resetConfirmationStore());

const fp = (payload: unknown): string =>
  actionFingerprint({ operation: 'generateTrackingLink', network: 'awin', subject: 'self', payload });

describe('actionFingerprint', () => {
  it('is stable regardless of object key order', () => {
    expect(fp({ a: 1, b: 2 })).toBe(fp({ b: 2, a: 1 }));
  });

  it('changes when the payload changes', () => {
    expect(fp({ destinationUrl: 'https://x.example' })).not.toBe(
      fp({ destinationUrl: 'https://y.example' }),
    );
  });

  it('changes when the subject changes', () => {
    const self = actionFingerprint({ operation: 'o', network: 'n', subject: 'self', payload: {} });
    const acme = actionFingerprint({ operation: 'o', network: 'n', subject: 'acme', payload: {} });
    expect(self).not.toBe(acme);
  });
});

describe('issue + redeem', () => {
  it('redeems a fresh token for the matching fingerprint', () => {
    const f = fp({ programmeId: '1' });
    const { token } = issueConfirmation(f);
    expect(redeemConfirmation(token, f)).toEqual({ ok: true });
  });

  it('is single use — a second redeem fails', () => {
    const f = fp({ programmeId: '1' });
    const { token } = issueConfirmation(f);
    redeemConfirmation(token, f);
    expect(redeemConfirmation(token, f)).toEqual({
      ok: false,
      reason: expect.stringMatching(/unknown or already used/),
    });
  });

  it('rejects an unknown token', () => {
    expect(redeemConfirmation('nope', fp({}))).toEqual({
      ok: false,
      reason: expect.stringMatching(/unknown or already used/),
    });
  });

  it('rejects a token whose fingerprint no longer matches', () => {
    const { token } = issueConfirmation(fp({ programmeId: '1' }));
    const res = redeemConfirmation(token, fp({ programmeId: '2' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/request changed/);
  });

  it('does not consume a token on a fingerprint mismatch — the right action can still confirm', () => {
    const f = fp({ programmeId: '1' });
    const { token } = issueConfirmation(f);
    redeemConfirmation(token, fp({ programmeId: '2' })); // mismatch, should not consume
    expect(redeemConfirmation(token, f)).toEqual({ ok: true });
  });

  it('rejects an expired token', () => {
    const f = fp({ programmeId: '1' });
    const issuedAt = new Date('2026-06-01T00:00:00Z');
    const { token } = issueConfirmation(f, issuedAt);
    const later = new Date(issuedAt.getTime() + 6 * 60 * 1000); // default TTL is 5 min
    const res = redeemConfirmation(token, f, later);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/expired/);
  });

  it('honours AFFILIATE_MCP_CONFIRMATION_TTL_MS', () => {
    const original = process.env['AFFILIATE_MCP_CONFIRMATION_TTL_MS'];
    process.env['AFFILIATE_MCP_CONFIRMATION_TTL_MS'] = '1000';
    try {
      const f = fp({ programmeId: '1' });
      const t0 = new Date('2026-06-01T00:00:00Z');
      const { token, expiresAt } = issueConfirmation(f, t0);
      expect(new Date(expiresAt).getTime()).toBe(t0.getTime() + 1000);
      expect(redeemConfirmation(token, f, new Date(t0.getTime() + 2000)).ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIRMATION_TTL_MS'];
      else process.env['AFFILIATE_MCP_CONFIRMATION_TTL_MS'] = original;
    }
  });
});
