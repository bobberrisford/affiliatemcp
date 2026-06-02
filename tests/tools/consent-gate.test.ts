/**
 * Tests for `src/tools/consent-gate.ts`.
 *
 * Covers:
 *   - reads / unmapped ops always pass through (no consent lookup)
 *   - enforcement off (default) lets a classified action through unchanged
 *   - enforcement on: proceed / prompt / deny outcomes for a standing grant,
 *     no grant, and an explicit deny grant
 *   - the `self` subject for publisher actions vs a brand subject
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { consentGate, dispatchAction, SELF_SUBJECT } from '../../src/tools/consent-gate.js';
import { grantConsent } from '../../src/shared/consent.js';
import { resetConfirmationStore } from '../../src/tools/confirmation.js';
import { readAudit } from '../../src/shared/audit.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalEnforce: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-gate-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  originalEnforce = process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  resetConfirmationStore();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  if (originalEnforce === undefined) delete process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
  else process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = originalEnforce;
});

describe('consentGate — pass-through cases', () => {
  it('allows a read operation regardless of enforcement', () => {
    process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = '1';
    expect(
      consentGate({ operation: 'listTransactions', network: 'awin', subject: SELF_SUBJECT }),
    ).toEqual({ allow: true });
  });

  it('allows a classified action when enforcement is off (default)', () => {
    delete process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
    expect(
      consentGate({ operation: 'generateTrackingLink', network: 'awin', subject: SELF_SUBJECT }),
    ).toEqual({ allow: true });
  });
});

describe('consentGate — enforcement on', () => {
  beforeEach(() => {
    process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = '1';
  });

  it('asks for confirmation when no grant exists', () => {
    const outcome = consentGate({
      operation: 'generateTrackingLink',
      network: 'awin',
      subject: SELF_SUBJECT,
    });
    expect(outcome.allow).toBe(false);
    if (outcome.allow) return; // narrow
    expect(outcome.result.kind).toBe('confirmation_required');
    expect(outcome.result.actionClass).toBe('link.generate');
    if (outcome.result.kind === 'confirmation_required') {
      expect(outcome.result.message).toMatch(/confirmation/i);
    }
  });

  it('proceeds when a standing grant covers the action (self subject)', () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    expect(
      consentGate({ operation: 'generateTrackingLink', network: 'awin', subject: SELF_SUBJECT }).allow,
    ).toBe(true);
  });

  it('keeps the self grant scoped to the self subject, not a brand', () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    // An advertiser-style call keyed on a brand is not covered by the self grant.
    const outcome = consentGate({
      operation: 'generateTrackingLink',
      network: 'awin',
      subject: 'acme',
    });
    expect(outcome.allow).toBe(false);
  });

  it('denies when an explicit deny grant matches', () => {
    grantConsent({ subject: SELF_SUBJECT, network: '*', actionClass: 'link.generate', mode: 'deny' });
    const outcome = consentGate({
      operation: 'generateTrackingLink',
      network: 'awin',
      subject: SELF_SUBJECT,
    });
    expect(outcome.allow).toBe(false);
    if (outcome.allow) return; // narrow
    expect(outcome.result.kind).toBe('action_denied');
  });
});

describe('consentGate — confirmation token round-trip', () => {
  beforeEach(() => {
    process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = '1';
  });

  const action = (over: Record<string, unknown> = {}) => ({
    operation: 'generateTrackingLink' as const,
    network: 'awin',
    subject: SELF_SUBJECT,
    payload: { programmeId: '1', destinationUrl: 'https://shop.example/p' },
    ...over,
  });

  it('issues a token on first call and proceeds when it is presented back', () => {
    const first = consentGate(action());
    expect(first.allow).toBe(false);
    if (first.allow) return;
    expect(first.result.kind).toBe('confirmation_required');
    if (first.result.kind !== 'confirmation_required') return;
    const token = first.result.confirmationToken;
    expect(token).toBeTruthy();

    const second = consentGate(action({ confirmationToken: token }));
    expect(second.allow).toBe(true);
  });

  it('does not let a token authorise a different action (payload changed)', () => {
    const first = consentGate(action());
    if (first.allow || first.result.kind !== 'confirmation_required') throw new Error('expected prompt');
    const token = first.result.confirmationToken;

    // Same token, different destination → rejected, fresh token issued.
    const tampered = consentGate(
      action({ confirmationToken: token, payload: { programmeId: '1', destinationUrl: 'https://evil.example' } }),
    );
    expect(tampered.allow).toBe(false);
    if (tampered.allow || tampered.result.kind !== 'confirmation_required') return;
    expect(tampered.result.reason).toMatch(/request changed/);
    expect(tampered.result.confirmationToken).not.toBe(token);
  });

  it('is single use — replaying a redeemed token re-prompts', () => {
    const first = consentGate(action());
    if (first.allow || first.result.kind !== 'confirmation_required') throw new Error('expected prompt');
    const token = first.result.confirmationToken;
    expect(consentGate(action({ confirmationToken: token })).allow).toBe(true);
    // Replay
    const replay = consentGate(action({ confirmationToken: token }));
    expect(replay.allow).toBe(false);
  });

  it('a standing grant proceeds with no token at all', () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    expect(consentGate(action()).allow).toBe(true);
  });
});

describe('dispatchAction — pass-through branches', () => {
  it('returns the gate result without executing when the gate refused', async () => {
    let ran = false;
    const result = { kind: 'action_denied' as const, network: 'awin', operation: 'x', actionClass: 'a.b', subject: 'self', reason: 'no' };
    const out = await dispatchAction({ allow: false, result }, async () => {
      ran = true;
      return 'nope';
    });
    expect(out).toBe(result);
    expect(ran).toBe(false);
    expect(readAudit()).toHaveLength(0);
  });

  it('runs without recording an outcome for an allow with no audit context (read / enforcement off)', async () => {
    const out = await dispatchAction({ allow: true }, async () => 'data');
    expect(out).toBe('data');
    expect(readAudit()).toHaveLength(0);
  });
});

describe('consentGate — audit recording', () => {
  beforeEach(() => {
    process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = '1';
  });

  const action = () => ({
    operation: 'generateTrackingLink' as const,
    network: 'awin',
    subject: SELF_SUBJECT,
    payload: { programmeId: '1', destinationUrl: 'https://shop.example/p' },
  });

  it('records a proposed entry on first prompt', () => {
    consentGate(action());
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('proposed');
  });

  it('records an applied entry (via token) on confirmation', () => {
    const first = consentGate(action());
    if (first.allow || first.result.kind !== 'confirmation_required') throw new Error('expected prompt');
    consentGate({ ...action(), confirmationToken: first.result.confirmationToken });
    const applied = readAudit().filter((e) => e.event === 'applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.via).toBe('token');
  });

  it('records an applied entry (via standing) when a grant covers it', () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    consentGate(action());
    const applied = readAudit().filter((e) => e.event === 'applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.via).toBe('standing');
  });

  it('records a denied entry on an explicit deny grant', () => {
    grantConsent({ subject: SELF_SUBJECT, network: '*', actionClass: 'link.generate', mode: 'deny' });
    consentGate(action());
    expect(readAudit().filter((e) => e.event === 'denied')).toHaveLength(1);
  });

  it('records succeeded when the dispatched action resolves', async () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    const gate = consentGate(action());
    const out = await dispatchAction(gate, async () => ({ trackingUrl: 'https://x' }));
    expect(out).toEqual({ trackingUrl: 'https://x' });
    expect(readAudit().filter((e) => e.event === 'succeeded')).toHaveLength(1);
  });

  it('records failed and re-raises when the dispatched action throws', async () => {
    grantConsent({ subject: SELF_SUBJECT, network: 'awin', actionClass: 'link.generate', mode: 'standing' });
    const gate = consentGate(action());
    await expect(
      dispatchAction(gate, async () => {
        throw new Error('network 500');
      }),
    ).rejects.toThrow('network 500');
    const failed = readAudit().filter((e) => e.event === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatch(/network 500/);
  });

  it('enforces a per-day cap from the audit log: prompts once the cap is reached', () => {
    grantConsent({
      subject: SELF_SUBJECT,
      network: 'awin',
      actionClass: 'link.generate',
      mode: 'standing',
      bounds: { maxPerDay: 2 },
    });
    // Two standing-grant proceeds, each writing an `applied` entry.
    expect(consentGate(action()).allow).toBe(true);
    expect(consentGate(action()).allow).toBe(true);
    // Third is over the cap → falls back to prompt.
    const third = consentGate(action());
    expect(third.allow).toBe(false);
    if (third.allow) return;
    expect(third.result.kind).toBe('confirmation_required');
    expect(readAudit().filter((e) => e.event === 'applied')).toHaveLength(2);
  });
});
