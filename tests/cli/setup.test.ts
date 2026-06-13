/**
 * Integration tests for the setup wizard.
 *
 * Drives `runSetup` against mocked adapters via the registry. Covers PRD §15
 * quality bars:
 *   - §15.11 first-run path writes a clean .env
 *   - §15.12 validateCredential failure re-prompts
 *   - §15.13 reset path overwrites cleanly
 *   - §15.14 add-network path appends without clobbering other networks
 *   - §15.18 AFFILIATE_MCP_CONFIG_DIR honoured + path printed
 *
 * Also covers the duck-typed `derivedValues` merge (PRD principle 4.3 — the
 * canonical Awin / CJ derivation flow).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runSetup } from '../../src/cli/setup.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { _resetConfigForTests } from '../../src/shared/config.js';
import { FakePrompter, makeFakeAdapter } from './fakes.js';
import type { SetupStep } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalEnvKeys: Set<string>;
let stdoutWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;

beforeEach(() => {
  _clearRegistry();
  _resetConfigForTests();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-setup-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  originalEnvKeys = new Set(Object.keys(process.env));
  stdoutWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  // Strip any env vars the tests planted (e.g. ALPHA_TOKEN).
  for (const k of Object.keys(process.env)) {
    if (!originalEnvKeys.has(k)) delete process.env[k];
  }
});

function stdoutText(): string {
  return stdoutWrites.join('');
}

// ---------------------------------------------------------------------------
// Adapter fixtures
// ---------------------------------------------------------------------------

function buildAlphaSteps(validator?: (v: string) => Promise<{ ok: boolean; message?: string }>): SetupStep[] {
  const steps: SetupStep[] = [
    {
      field: 'ALPHA_TOKEN',
      label: 'Alpha API token',
      type: 'password',
      description: 'Paste your Alpha token.',
    },
  ];
  if (validator) steps[0]!.validateOnEntry = validator;
  return steps;
}

function buildBetaSteps(): SetupStep[] {
  return [
    {
      field: 'BETA_TOKEN',
      label: 'Beta token',
      type: 'password',
      description: 'Paste your Beta token.',
    },
    {
      field: 'BETA_ACCOUNT_ID',
      label: 'Beta account id',
      type: 'text',
      example: '12345',
      description: 'Beta account id; auto-derived from the token when possible.',
    },
  ];
}

// ---------------------------------------------------------------------------
// §15.11 first-run path
// ---------------------------------------------------------------------------

describe('runSetup — first-run path (PRD §15.11)', () => {
  it('writes a clean .env from a fresh install', async () => {
    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps() }),
    );
    const prompter = new FakePrompter([
      ['alpha'], // selectMany
      'tok-1234', // password
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);

    const envFile = path.join(tmp, '.env');
    expect(existsSync(envFile)).toBe(true);
    const text = readFileSync(envFile, 'utf8');
    expect(text).toMatch(/ALPHA_TOKEN=tok-1234/);

    // PRD §15.18 — the absolute path is printed in the wizard output.
    expect(stdoutText()).toContain(envFile);
  });
});

// ---------------------------------------------------------------------------
// §15.12 validation failure re-prompts
// ---------------------------------------------------------------------------

describe('runSetup — validateCredential failure (PRD §15.12)', () => {
  it('re-prompts and surfaces the verbatim reason', async () => {
    let callCount = 0;
    const validator = async (v: string): Promise<{ ok: boolean; message?: string }> => {
      callCount += 1;
      if (v === 'good-token') return { ok: true, message: 'verified as alpha/42' };
      return { ok: false, message: 'token rejected by upstream (401)' };
    };
    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps(validator) }),
    );

    const prompter = new FakePrompter([
      ['alpha'], // selectMany
      'bad-token', // password
      'retry', // menu after rejection
      'good-token', // password retry
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);
    expect(callCount).toBe(2);

    const out = stdoutText();
    // PRD §4.1 — network name, field name, verbatim reason.
    expect(out).toContain('Alpha');
    expect(out).toContain('ALPHA_TOKEN');
    expect(out).toContain('token rejected by upstream (401)');

    const envFile = path.join(tmp, '.env');
    expect(readFileSync(envFile, 'utf8')).toMatch(/ALPHA_TOKEN=good-token/);
  });

  it('allows the user to skip a failing field rather than retry forever', async () => {
    const validator = async (): Promise<{ ok: boolean; message?: string }> => ({
      ok: false,
      message: 'always fails',
    });
    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps(validator) }),
    );

    const prompter = new FakePrompter([
      ['alpha'],
      'bad-token',
      'skip', // menu after rejection — choose skip
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);
    const envFile = path.join(tmp, '.env');
    // File is still written (with no ALPHA_TOKEN entry).
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).not.toContain('ALPHA_TOKEN=bad');
  });
});

// ---------------------------------------------------------------------------
// §15.13 reset path
// ---------------------------------------------------------------------------

describe('runSetup — reset path (PRD §15.13)', () => {
  it('overwrites the existing entries for the chosen network', async () => {
    // Seed an existing .env with a stale value for ALPHA + a value for an
    // unrelated network we expect to keep.
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, '.env'),
      'ALPHA_TOKEN=stale\nUNRELATED_OTHER=keep-me\n',
    );

    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps() }),
    );

    const prompter = new FakePrompter([
      'reset', // top-level menu
      ['alpha'],
      'fresh-token',
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);

    const text = readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(text).toMatch(/ALPHA_TOKEN=fresh-token/);
    expect(text).not.toMatch(/ALPHA_TOKEN=stale/);
    expect(text).toMatch(/UNRELATED_OTHER=keep-me/);
  });
});

// ---------------------------------------------------------------------------
// §15.14 add-network path
// ---------------------------------------------------------------------------

describe('runSetup — add-network path (PRD §15.14)', () => {
  it('appends a new network without overwriting other networks', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, '.env'),
      'ALPHA_TOKEN=alpha-existing\n',
    );

    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps() }),
    );
    registerAdapter(
      makeFakeAdapter({ slug: 'beta', name: 'Beta', steps: buildBetaSteps() }),
    );

    const prompter = new FakePrompter([
      'add', // top-level menu
      ['beta'], // pick only beta
      'beta-tok', // BETA_TOKEN
      '987654', // BETA_ACCOUNT_ID
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);

    const text = readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(text).toMatch(/ALPHA_TOKEN=alpha-existing/);
    expect(text).toMatch(/BETA_TOKEN=beta-tok/);
    expect(text).toMatch(/BETA_ACCOUNT_ID=987654/);
  });
});

// ---------------------------------------------------------------------------
// derivedValues merge
// ---------------------------------------------------------------------------

describe('runSetup — derivedValues from verifyAuth', () => {
  it('merges derived values without re-prompting the user', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'beta',
        name: 'Beta',
        // Only one prompt — the second field would normally come from the
        // user but the adapter derives it.
        steps: [
          {
            field: 'BETA_TOKEN',
            label: 'Beta token',
            type: 'password',
            description: 'Paste your Beta token.',
          },
        ],
        verifyAuth: async () => ({
          ok: true,
          identity: 'beta/42',
          derivedValues: { BETA_ACCOUNT_ID: '42' },
        }),
      }),
    );

    const prompter = new FakePrompter([
      ['beta'],
      'beta-tok',
      false, // decline telemetry
      false, // decline "connect to Claude?" offer
    ]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);
    const text = readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(text).toMatch(/BETA_TOKEN=beta-tok/);
    expect(text).toMatch(/BETA_ACCOUNT_ID=42/);

    expect(stdoutText()).toContain('Derived BETA_ACCOUNT_ID');
  });
});

// ---------------------------------------------------------------------------
// §15.18 AFFILIATE_MCP_CONFIG_DIR
// ---------------------------------------------------------------------------

describe('runSetup — AFFILIATE_MCP_CONFIG_DIR (PRD §15.18)', () => {
  it('writes into the directory named by the env var and prints the path', async () => {
    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps() }),
    );
    const prompter = new FakePrompter([['alpha'], 'tok', false, false]);

    const code = await runSetup({ prompter });
    expect(code).toBe(0);

    const envFile = path.join(tmp, '.env');
    expect(existsSync(envFile)).toBe(true);
    expect(stdoutText()).toContain(envFile);
  });
});

// ---------------------------------------------------------------------------
// File mode
// ---------------------------------------------------------------------------

describe('runSetup — file permissions', () => {
  it('writes the .env with 0600 permissions', async () => {
    registerAdapter(
      makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: buildAlphaSteps() }),
    );
    const prompter = new FakePrompter([['alpha'], 'tok', false, false]);
    await runSetup({ prompter });

    const { statSync } = await import('node:fs');
    const stat = statSync(path.join(tmp, '.env'));
    // Mask off the file type bits; permission bits should be 0o600.
    // On Windows the mode includes the umask quirk, so we only assert
    // group/other are zero, which is the security-critical bit.
    const mode = stat.mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
