/**
 * Tests for `src/cli/consent.ts`.
 *
 * Covers:
 *   - parseConsentArgs: valid grant, revoke, list; bad action; missing flags;
 *     bad mode; bad --max-per-day; bad --expires format.
 *   - runConsent grant: records a grant, prints confirmation.
 *   - runConsent revoke: removes a grant, prints count; no-op when absent.
 *   - runConsent list: prints table; empty message when none.
 *   - runConsent list --subject: filters output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import { parseConsentArgs, runConsent } from '../../src/cli/consent.js';
import { grantConsent, listGrants } from '../../src/shared/consent.js';

let tmp: string;
let originalConfigDir: string | undefined;
let stdoutWrites: string[];
let stderrWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-consent-cli-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  stdoutWrites = [];
  stderrWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

function stdout(): string {
  return stdoutWrites.join('');
}

function stderr(): string {
  return stderrWrites.join('');
}

// ---------------------------------------------------------------------------
// parseConsentArgs
// ---------------------------------------------------------------------------

describe('parseConsentArgs', () => {
  it('parses a full grant command', () => {
    const opts = parseConsentArgs([
      'grant',
      '--subject', 'acme',
      '--network', 'awin',
      '--action', 'transaction.read',
      '--mode', 'standing',
      '--max-per-day', '10',
      '--expires', '2030-01-01T00:00:00.000Z',
      '--note', 'approved by ops',
    ]);
    expect(opts.action).toBe('grant');
    expect(opts.subject).toBe('acme');
    expect(opts.network).toBe('awin');
    expect(opts.actionClass).toBe('transaction.read');
    expect(opts.mode).toBe('standing');
    expect(opts.maxPerDay).toBe(10);
    expect(opts.expires).toBe('2030-01-01T00:00:00.000Z');
    expect(opts.note).toBe('approved by ops');
  });

  it('parses a revoke command', () => {
    const opts = parseConsentArgs([
      'revoke',
      '--subject', 'acme',
      '--network', 'awin',
      '--action', 'transaction.read',
    ]);
    expect(opts.action).toBe('revoke');
    expect(opts.subject).toBe('acme');
  });

  it('parses a list command with no flags', () => {
    const opts = parseConsentArgs(['list']);
    expect(opts.action).toBe('list');
    expect(opts.subject).toBeUndefined();
  });

  it('parses list --subject', () => {
    const opts = parseConsentArgs(['list', '--subject', 'acme']);
    expect(opts.subject).toBe('acme');
  });

  it('throws on unknown action', () => {
    expect(() => parseConsentArgs(['bogus'])).toThrow(/Unknown consent action/);
  });

  it('throws on unknown flag', () => {
    expect(() => parseConsentArgs(['grant', '--unknown'])).toThrow(/Unknown flag/);
  });

  it('throws on --mode with invalid value', () => {
    expect(() =>
      parseConsentArgs(['grant', '--mode', 'maybe']),
    ).toThrow(/--mode must be/);
  });

  it('throws on --max-per-day with non-integer', () => {
    expect(() =>
      parseConsentArgs(['grant', '--max-per-day', 'abc']),
    ).toThrow(/positive integer/);
  });

  it('throws on --max-per-day with zero', () => {
    expect(() =>
      parseConsentArgs(['grant', '--max-per-day', '0']),
    ).toThrow(/positive integer/);
  });

  it('throws when a flag value is missing (next arg is another flag)', () => {
    expect(() =>
      parseConsentArgs(['grant', '--subject', '--network']),
    ).toThrow(/requires a value/);
  });
});

// ---------------------------------------------------------------------------
// runConsent grant
// ---------------------------------------------------------------------------

describe('runConsent grant', () => {
  it('records a grant and prints confirmation', async () => {
    const code = await runConsent({
      action: 'grant',
      subject: 'acme',
      network: 'awin',
      actionClass: 'transaction.read',
    });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/Consent standing grant recorded/);
    expect(stdout()).toMatch(/subject="acme"/);
    expect(listGrants()).toHaveLength(1);
  });

  it('uses "deny" mode when specified', async () => {
    const code = await runConsent({
      action: 'grant',
      subject: 'acme',
      network: 'awin',
      actionClass: 'transaction.read',
      mode: 'deny',
    });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/Consent deny grant recorded/);
  });

  it('returns 2 when --subject is missing', async () => {
    const code = await runConsent({ action: 'grant', network: 'awin', actionClass: 'transaction.read' });
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--subject is required/);
  });

  it('returns 2 when --network is missing', async () => {
    const code = await runConsent({ action: 'grant', subject: 'acme', actionClass: 'transaction.read' });
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--network is required/);
  });

  it('returns 2 when --action is missing', async () => {
    const code = await runConsent({ action: 'grant', subject: 'acme', network: 'awin' });
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--action is required/);
  });

  it('returns 2 when subject is invalid', async () => {
    const code = await runConsent({
      action: 'grant',
      subject: 'Bad Subject!',
      network: 'awin',
      actionClass: 'transaction.read',
    });
    expect(code).toBe(2);
    expect(stderr()).toMatch(/Invalid subject/);
  });

  it('returns 2 when action class is invalid', async () => {
    const code = await runConsent({
      action: 'grant',
      subject: 'acme',
      network: 'awin',
      actionClass: 'notvalid',
    });
    expect(code).toBe(2);
    expect(stderr()).toMatch(/Invalid action class/);
  });

  it('accepts subject = "self" and network = "*"', async () => {
    const code = await runConsent({
      action: 'grant',
      subject: 'self',
      network: '*',
      actionClass: 'transaction.read',
    });
    expect(code).toBe(0);
    const grants = listGrants();
    expect(grants[0]?.subject).toBe('self');
    expect(grants[0]?.network).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// runConsent revoke
// ---------------------------------------------------------------------------

describe('runConsent revoke', () => {
  it('removes a grant and prints the count', async () => {
    grantConsent({ subject: 'acme', network: 'awin', actionClass: 'transaction.read', mode: 'standing' });
    const code = await runConsent({
      action: 'revoke',
      subject: 'acme',
      network: 'awin',
      actionClass: 'transaction.read',
    });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/Removed 1 consent grant/);
    expect(listGrants()).toHaveLength(0);
  });

  it('prints a no-op message when nothing matched', async () => {
    const code = await runConsent({
      action: 'revoke',
      subject: 'acme',
      network: 'awin',
      actionClass: 'transaction.read',
    });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/No matching consent grant found/);
  });

  it('returns 2 when --subject is missing', async () => {
    const code = await runConsent({ action: 'revoke', network: 'awin', actionClass: 'transaction.read' });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runConsent list
// ---------------------------------------------------------------------------

describe('runConsent list', () => {
  it('prints a message when no grants exist', async () => {
    const code = await runConsent({ action: 'list' });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/No consent grants recorded/);
  });

  it('prints a table when grants exist', async () => {
    grantConsent({ subject: 'acme', network: 'awin', actionClass: 'transaction.read', mode: 'standing' });
    grantConsent({ subject: 'globex', network: 'cj', actionClass: 'link.generate', mode: 'deny' });
    const code = await runConsent({ action: 'list' });
    expect(code).toBe(0);
    const output = stdout();
    expect(output).toContain('acme');
    expect(output).toContain('globex');
    expect(output).toContain('transaction.read');
    expect(output).toContain('link.generate');
  });

  it('filters by subject when --subject is given', async () => {
    grantConsent({ subject: 'acme', network: 'awin', actionClass: 'transaction.read', mode: 'standing' });
    grantConsent({ subject: 'globex', network: 'cj', actionClass: 'link.generate', mode: 'standing' });
    const code = await runConsent({ action: 'list', subject: 'acme' });
    expect(code).toBe(0);
    const output = stdout();
    expect(output).toContain('acme');
    expect(output).not.toContain('globex');
  });
});
