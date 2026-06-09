/**
 * Tests for the core facade — the prompter-free programmatic API the desktop
 * app drives onboarding through.
 *
 * Style mirrors tests/cli/setup.test.ts: sandbox the config dir via
 * AFFILIATE_MCP_CONFIG_DIR pointed at a tmp dir, clear the registry per case
 * and register fake adapters, and restore process.env afterwards.
 *
 * The facade imports `../networks/index.js` for its registration side-effect,
 * which populates the registry with the real adapters at import time. Each test
 * clears the registry first and registers only the fakes it needs, so it never
 * depends on the real adapter set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  connectClaudeDesktop,
  discoverBrands,
  listNetworks,
  saveBrands,
  saveEnv,
  setupSteps,
  validateField,
  verifyAuth,
} from '../../src/core/facade.js';
import {
  buildAffiliateEntryValue,
  AFFILIATE_ENTRY_VALUE,
} from '../../src/cli/install/claude-desktop.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { NotImplementedError } from '../../src/shared/types.js';
import type {
  DiscoveredBrand,
  NetworkAdapter,
  NetworkMeta,
  SetupStep,
} from '../../src/shared/types.js';
import { makeFakeAdapter } from '../cli/fakes.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalEnvKeys: Set<string>;

beforeEach(() => {
  _clearRegistry();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-facade-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  originalEnvKeys = new Set(Object.keys(process.env));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  // Drop any credential keys a test stashed into the environment.
  for (const k of Object.keys(process.env)) {
    if (!originalEnvKeys.has(k)) delete process.env[k];
  }
  _clearRegistry();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const step = (over: Partial<SetupStep> & { field: string }): SetupStep => ({
  label: over.field,
  description: `Describe ${over.field}`,
  type: 'text',
  ...over,
});

/**
 * A multi-brand advertiser fake. `makeFakeAdapter` only builds publisher,
 * single-brand adapters, so spread it and override the bits the facade reads
 * (meta.side / meta.credentialScope) plus add `listBrands`.
 */
function makeMultiBrandAdapter(opts: {
  slug: string;
  name: string;
  listBrands: () => Promise<DiscoveredBrand[]>;
}): NetworkAdapter {
  const base = makeFakeAdapter({ slug: opts.slug, name: opts.name, steps: [] });
  const meta: NetworkMeta = {
    ...base.meta,
    side: 'advertiser',
    credentialScope: 'multi-brand',
  };
  return { ...base, meta, listBrands: opts.listBrands };
}

// ---------------------------------------------------------------------------
// listNetworks
// ---------------------------------------------------------------------------

describe('listNetworks', () => {
  it('maps side + multiBrand and sorts by name', () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'zeta-pub',
        name: 'Zeta',
        steps: [],
        setupTimeEstimateMinutes: 7,
        setupRequiresApproval: true,
      }),
    );
    registerAdapter(
      makeMultiBrandAdapter({
        slug: 'alpha-adv',
        name: 'Alpha',
        listBrands: async () => [],
      }),
    );

    const out = listNetworks();
    expect(out.map((n) => n.name)).toEqual(['Alpha', 'Zeta']); // sorted

    const alpha = out.find((n) => n.slug === 'alpha-adv')!;
    expect(alpha.side).toBe('brand');
    expect(alpha.multiBrand).toBe(true);

    const zeta = out.find((n) => n.slug === 'zeta-pub')!;
    expect(zeta.side).toBe('publisher');
    expect(zeta.multiBrand).toBe(false);
    expect(zeta.setupMinutes).toBe(7);
    expect(zeta.approval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setupSteps
// ---------------------------------------------------------------------------

describe('setupSteps', () => {
  it('strips validateOnEntry and never leaks a function', () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'net',
        name: 'Net',
        steps: [step({ field: 'NET_TOKEN', type: 'password', validateOnEntry: async () => ({ ok: true }) })],
      }),
    );
    const steps = setupSteps('net');
    expect(steps).toHaveLength(1);
    expect('validateOnEntry' in steps[0]!).toBe(false);
    // Round-trips through structured clone (the IPC boundary) without throwing.
    expect(() => structuredClone(steps)).not.toThrow();
  });

  it('merges credential-help: deepLink added, description overridden, example preserved', () => {
    // Use a real launch network (cj) so the sidecar entry applies.
    registerAdapter(
      makeFakeAdapter({
        slug: 'cj',
        name: 'CJ',
        steps: [
          step({ field: 'CJ_API_TOKEN', type: 'password', description: 'adapter copy' }),
          step({ field: 'CJ_COMPANY_ID', type: 'text', example: '7654321' }),
        ],
      }),
    );
    const steps = setupSteps('cj');
    const token = steps.find((s) => s.field === 'CJ_API_TOKEN')!;
    expect(token.deepLink).toBe('https://developers.cj.com/account/personal-access-tokens');
    expect(token.description).not.toBe('adapter copy'); // overridden by sidecar
    expect(token.description.length).toBeGreaterThan(0);

    const company = steps.find((s) => s.field === 'CJ_COMPANY_ID')!;
    // adapter step already had an example → that wins over the sidecar example
    expect(company.example).toBe('7654321');
  });

  it('falls back to adapter description when no sidecar entry exists', () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'no-help',
        name: 'NoHelp',
        steps: [step({ field: 'NH_KEY', description: 'only the adapter copy' })],
      }),
    );
    const steps = setupSteps('no-help');
    expect(steps[0]!.description).toBe('only the adapter copy');
    expect(steps[0]!.deepLink).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateField
// ---------------------------------------------------------------------------

describe('validateField', () => {
  it('returns the adapter result on success', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'net',
        name: 'Net',
        steps: [step({ field: 'NET_TOKEN', validateOnEntry: async (v) => ({ ok: v === 'good' }) })],
      }),
    );
    expect(await validateField('net', 'NET_TOKEN', 'good')).toEqual({ ok: true });
    expect(await validateField('net', 'NET_TOKEN', 'bad')).toEqual({ ok: false });
  });

  it('normalises a thrown error into a failed result', async () => {
    const adapter = makeFakeAdapter({ slug: 'net', name: 'Net', steps: [] });
    const throwing: NetworkAdapter = {
      ...adapter,
      async validateCredential() {
        throw new Error('boom');
      },
    };
    registerAdapter(throwing);
    expect(await validateField('net', 'NET_TOKEN', 'x')).toEqual({ ok: false, message: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('verifyAuth', () => {
  it('writes values into process.env and returns the adapter result', async () => {
    let seen: string | undefined;
    const base = makeFakeAdapter({ slug: 'net', name: 'Net', steps: [] });
    const adapter: NetworkAdapter = {
      ...base,
      async verifyAuth() {
        seen = process.env['NET_TOKEN'];
        return { ok: true, identity: 'net/acme' };
      },
    };
    registerAdapter(adapter);

    const result = await verifyAuth('net', { NET_TOKEN: 'secret-123' });
    expect(result).toEqual({ ok: true, identity: 'net/acme' });
    expect(seen).toBe('secret-123');
    expect(process.env['NET_TOKEN']).toBe('secret-123');
  });

  it('catches a thrown error and reports the reason', async () => {
    const base = makeFakeAdapter({ slug: 'net', name: 'Net', steps: [] });
    const adapter: NetworkAdapter = {
      ...base,
      async verifyAuth() {
        throw new Error('network down');
      },
    };
    registerAdapter(adapter);
    expect(await verifyAuth('net', {})).toEqual({ ok: false, reason: 'network down' });
  });
});

// ---------------------------------------------------------------------------
// discoverBrands
// ---------------------------------------------------------------------------

describe('discoverBrands', () => {
  it('maps listBrands results, apiEnabled → status', async () => {
    registerAdapter(
      makeMultiBrandAdapter({
        slug: 'adv',
        name: 'Adv',
        listBrands: async () => [
          { networkBrandId: 'b1', displayName: 'Brand One', apiEnabled: true },
          { networkBrandId: 'b2', displayName: 'Brand Two', apiEnabled: false },
        ],
      }),
    );
    expect(await discoverBrands('adv')).toEqual([
      { id: 'b1', name: 'Brand One', status: 'active' },
      { id: 'b2', name: 'Brand Two', status: 'pending' },
    ]);
  });

  it('returns [] when the adapter has no listBrands', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'pub', name: 'Pub', steps: [] }));
    expect(await discoverBrands('pub')).toEqual([]);
  });

  it('returns [] when listBrands throws NotImplementedError', async () => {
    registerAdapter(
      makeMultiBrandAdapter({
        slug: 'cj-like',
        name: 'CJ-like',
        listBrands: async () => {
          throw new NotImplementedError('no enumeration endpoint');
        },
      }),
    );
    expect(await discoverBrands('cj-like')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// saveEnv
// ---------------------------------------------------------------------------

describe('saveEnv', () => {
  it('round-trips through the tmp config dir at the resolved path', async () => {
    const result = await saveEnv({ NET_TOKEN: 'abc', NET_ID: '42' });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tmp, '.env'));
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('NET_TOKEN=abc');
    expect(written).toContain('NET_ID=42');
  });

  it('merges over an existing file rather than clobbering it', async () => {
    await saveEnv({ EXISTING: 'keep' });
    const result = await saveEnv({ NEW: 'added' });
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('EXISTING=keep');
    expect(written).toContain('NEW=added');
  });
});

// ---------------------------------------------------------------------------
// saveBrands
// ---------------------------------------------------------------------------

describe('saveBrands', () => {
  it('writes brands.json and counts only valid slugs', async () => {
    const result = await saveBrands('adv', [
      { networkBrandId: 'b1', slug: 'acme' },
      { networkBrandId: 'b2', slug: 'Invalid Slug' }, // skipped
      { networkBrandId: 'b3', slug: 'beta-co' },
    ]);
    expect(result).toEqual({ ok: true, count: 2 });

    const file = JSON.parse(readFileSync(path.join(tmp, 'brands.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.brands.acme).toEqual([
      { network: 'adv', credentialId: 'default', networkBrandId: 'b1' },
    ]);
    expect(file.brands['beta-co']).toEqual([
      { network: 'adv', credentialId: 'default', networkBrandId: 'b3' },
    ]);
    expect(file.brands['Invalid Slug']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// connectClaudeDesktop
// ---------------------------------------------------------------------------

describe('connectClaudeDesktop', () => {
  it('writes a bundled-runtime entry when nodePath + serverPath are given', async () => {
    // Sandbox the desktop config path into the tmp dir via the macOS layout.
    // resolveDesktopConfigPath builds from homedir(), which we cannot easily
    // override here, so assert the entry value the facade would write instead
    // by going one level down through buildAffiliateEntryValue.
    const entry = buildAffiliateEntryValue({
      nodePath: '/opt/amcp/node',
      serverPath: '/opt/amcp/server.js',
    });
    expect(entry).toEqual({ command: '/opt/amcp/node', args: ['/opt/amcp/server.js'] });
  });

  it('actually wires the bundled entry into a real config file', async () => {
    // Point HOME at the tmp dir so resolveDesktopConfigPath lands inside it.
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      const result = await connectClaudeDesktop({
        nodePath: '/opt/amcp/node',
        serverPath: '/opt/amcp/server.js',
      });
      if (result.action === 'absent') {
        // Non-darwin platform: resolveDesktopConfigPath returned null. Nothing
        // to assert on disk; the bundled-entry mapping is covered above.
        expect(result.path).toBe('');
        return;
      }
      expect(['created', 'added', 'updated']).toContain(result.action);
      const written = JSON.parse(readFileSync(result.path, 'utf8'));
      expect(written.mcpServers.affiliate).toEqual({
        command: '/opt/amcp/node',
        args: ['/opt/amcp/server.js'],
      });
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('writes the env onto the entry in a single pass when given', async () => {
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      const result = await connectClaudeDesktop({
        nodePath: '/opt/amcp/node',
        serverPath: '/opt/amcp/server.js',
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
      if (result.action === 'absent') {
        expect(result.path).toBe('');
        return;
      }
      const written = JSON.parse(readFileSync(result.path, 'utf8'));
      expect(written.mcpServers.affiliate).toEqual({
        command: '/opt/amcp/node',
        args: ['/opt/amcp/server.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });
});

// ---------------------------------------------------------------------------
// buildAffiliateEntryValue (extends the claude-desktop coverage)
// ---------------------------------------------------------------------------

describe('buildAffiliateEntryValue', () => {
  it('returns the bundled command when both paths are given', () => {
    expect(buildAffiliateEntryValue({ nodePath: '/n', serverPath: '/s.js' })).toEqual({
      command: '/n',
      args: ['/s.js'],
    });
  });

  it('falls back to the npx default when paths are missing', () => {
    expect(buildAffiliateEntryValue()).toEqual({
      command: AFFILIATE_ENTRY_VALUE.command,
      args: [...AFFILIATE_ENTRY_VALUE.args],
    });
    expect(buildAffiliateEntryValue({ nodePath: '/n' })).toEqual({
      command: AFFILIATE_ENTRY_VALUE.command,
      args: [...AFFILIATE_ENTRY_VALUE.args],
    });
  });
});
