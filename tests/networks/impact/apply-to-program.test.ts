/**
 * Tests for Impact `applyToProgram` and its end-to-end consent-gate integration.
 *
 * Covers:
 *   - Plain unit tests: `applyToProgram` result shape (userMessage names Impact,
 *     mutates is true, verify is present, kind is browser_handoff).
 *   - End-to-end gated flow with `AFFILIATE_MCP_ENFORCE_CONSENT=1`:
 *       1. First call → `confirmation_required` with a token and `programme.apply`.
 *       2. Re-run with that token → `allow: true`.
 *       3. `dispatchAction` → returns the structured result AND the audit log
 *          contains `proposed`, `applied`, and `succeeded` entries.
 *
 * Deliberately does NOT call `grantConsent` — the gate's `prompt` branch is
 * exercised via the confirmation-token path instead.
 *
 * Pattern follows `tests/shared/brands.test.ts` for the tmp-dir + env setup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { impactAdapter } from '../../../src/networks/impact/adapter.js';
import { consentGate, dispatchAction } from '../../../src/tools/consent-gate.js';
import { readAudit } from '../../../src/shared/audit.js';
import { resetConfirmationStore } from '../../../src/tools/confirmation.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalEnforceConsent: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-apply-prog-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  originalEnforceConsent = process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  resetConfirmationStore();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  if (originalEnforceConsent === undefined) delete process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
  else process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = originalEnforceConsent;
  resetConfirmationStore();
});

// ---------------------------------------------------------------------------
// Unit tests — applyToProgram shape
// ---------------------------------------------------------------------------

describe('applyToProgram — result shape', () => {
  it('returns kind browser_handoff', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(result.kind).toBe('browser_handoff');
  });

  it('names the network as impact', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(result.network).toBe('impact');
  });

  it('names the operation as applyToProgram', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(result.operation).toBe('applyToProgram');
  });

  it('userMessage names Impact and mentions the campaign ID', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '999' });
    expect(result.userMessage).toMatch(/Impact/);
    expect(result.userMessage).toMatch(/999/);
  });

  it('browserHandoff.mutates is true', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(result.browserHandoff.mutates).toBe(true);
  });

  it('browserHandoff.verify is a non-empty string', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(typeof result.browserHandoff.verify).toBe('string');
    expect(result.browserHandoff.verify.length).toBeGreaterThan(0);
  });

  it('browserHandoff.startingUrl is a non-empty string', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(typeof result.browserHandoff.startingUrl).toBe('string');
    expect(result.browserHandoff.startingUrl.length).toBeGreaterThan(0);
  });

  it('browserHandoff.inputs includes the campaignId', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '42' });
    expect(result.browserHandoff.inputs['CampaignId']).toBe('42');
  });

  it('browserHandoff.inputs includes notes when provided', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '42', notes: 'We focus on tech.' });
    expect(result.browserHandoff.inputs['Notes']).toBe('We focus on tech.');
  });

  it('browserHandoff.inputs does not include Notes when notes is absent', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '42' });
    expect(result.browserHandoff.inputs['Notes']).toBeUndefined();
  });

  it('browserHandoff.constraints is a non-empty array of strings', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(Array.isArray(result.browserHandoff.constraints)).toBe(true);
    expect(result.browserHandoff.constraints.length).toBeGreaterThan(0);
    for (const c of result.browserHandoff.constraints) {
      expect(typeof c).toBe('string');
    }
  });

  it('apiGapReason mentions Impact and the absence of an API endpoint', () => {
    const result = impactAdapter.applyToProgram({ campaignId: '123' });
    expect(result.apiGapReason).toMatch(/Impact/);
    expect(result.apiGapReason).toMatch(/API/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end gated flow
// ---------------------------------------------------------------------------

describe('consent gate — applyToProgram end-to-end with AFFILIATE_MCP_ENFORCE_CONSENT=1', () => {
  const GATE_INPUT = {
    operation: 'applyToProgram',
    network: 'impact',
    subject: 'self',
    payload: { campaignId: '123' },
  } as const;

  beforeEach(() => {
    process.env['AFFILIATE_MCP_ENFORCE_CONSENT'] = '1';
  });

  it('first call returns confirmation_required with a token and actionClass programme.apply', () => {
    const gate = consentGate(GATE_INPUT);
    expect(gate.allow).toBe(false);
    if (gate.allow) return; // narrows type for TS
    expect(gate.result.kind).toBe('confirmation_required');
    if (gate.result.kind !== 'confirmation_required') return;
    expect(gate.result.actionClass).toBe('programme.apply');
    expect(typeof gate.result.confirmationToken).toBe('string');
    expect(gate.result.confirmationToken.length).toBeGreaterThan(0);
    expect(gate.result.network).toBe('impact');
    expect(gate.result.operation).toBe('applyToProgram');
  });

  it('re-running with the confirmation token returns allow: true', () => {
    const firstGate = consentGate(GATE_INPUT);
    expect(firstGate.allow).toBe(false);
    if (firstGate.allow) return;
    expect(firstGate.result.kind).toBe('confirmation_required');
    if (firstGate.result.kind !== 'confirmation_required') return;

    const token = firstGate.result.confirmationToken;
    const secondGate = consentGate({ ...GATE_INPUT, confirmationToken: token });
    expect(secondGate.allow).toBe(true);
  });

  it('dispatchAction with confirmed gate returns the structured result and writes the full audit trail', async () => {
    // Step 1: gate issues a confirmation_required (also writes proposed to audit).
    const firstGate = consentGate(GATE_INPUT);
    expect(firstGate.allow).toBe(false);
    if (firstGate.allow) return;
    expect(firstGate.result.kind).toBe('confirmation_required');
    if (firstGate.result.kind !== 'confirmation_required') return;

    const token = firstGate.result.confirmationToken;

    // Step 2: gate redeems the token (writes applied to audit).
    const confirmedGate = consentGate({ ...GATE_INPUT, confirmationToken: token });
    expect(confirmedGate.allow).toBe(true);

    // Step 3: dispatch runs the action and writes succeeded.
    const result = await dispatchAction(confirmedGate, () =>
      Promise.resolve(impactAdapter.applyToProgram({ campaignId: '123' })),
    );

    // The structured browser-handoff result must be returned.
    expect(result).toMatchObject({
      kind: 'browser_handoff',
      network: 'impact',
      operation: 'applyToProgram',
    });

    // Audit trail must contain proposed, applied, and succeeded.
    const log = readAudit();
    const relevant = log.filter((e) => e.actionClass === 'programme.apply');

    const events = relevant.map((e) => e.event);
    expect(events).toContain('proposed');
    expect(events).toContain('applied');
    expect(events).toContain('succeeded');

    // Every relevant entry must name the correct action class, network, and subject.
    for (const entry of relevant) {
      expect(entry.network).toBe('impact');
      expect(entry.subject).toBe('self');
      expect(entry.actionClass).toBe('programme.apply');
    }
  });
});

describe('isGatedOperation', () => {
  it('recognises applyToProgram as a gated operation', async () => {
    // Import dynamically so we get the module-level singleton.
    const { isGatedOperation } = await import('../../../src/tools/consent-gate.js');
    expect(isGatedOperation('applyToProgram')).toBe(true);
  });

  it('does not gate a plain read operation', async () => {
    const { isGatedOperation } = await import('../../../src/tools/consent-gate.js');
    expect(isGatedOperation('listProgrammes')).toBe(false);
  });
});
