import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AFFILIATE_ENTRY_KEY,
  AFFILIATE_ENTRY_VALUE,
  MalformedDesktopConfigError,
  addAffiliateEntry,
  buildAffiliateEntryValue,
  removeAffiliateEntry,
  resolveDesktopConfigPath,
} from '../../../src/cli/install/claude-desktop.js';

let tmp: string;
const fixedDate = new Date(2026, 4, 28, 11, 45, 23); // 2026-05-28 11:45:23

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-cd-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmp, 'claude_desktop_config.json');
}

function readJSON(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('resolveDesktopConfigPath', () => {
  it('returns the macOS Application Support path on darwin', () => {
    const p = resolveDesktopConfigPath('darwin', {});
    expect(p).toMatch(/Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  });

  it('returns the APPDATA path on win32', () => {
    const p = resolveDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\bob\\AppData\\Roaming' });
    expect(p).toContain('Claude');
    expect(p).toContain('claude_desktop_config.json');
  });

  it('returns null on win32 when APPDATA is missing', () => {
    expect(resolveDesktopConfigPath('win32', {})).toBeNull();
  });

  it('returns null on linux', () => {
    expect(resolveDesktopConfigPath('linux', {})).toBeNull();
  });
});

describe('buildAffiliateEntryValue — env', () => {
  it('attaches a non-empty env only to the bundled-runtime entry', () => {
    expect(
      buildAffiliateEntryValue({
        nodePath: '/app/affiliate-mcp',
        serverPath: '/app/server.cjs',
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
    ).toEqual({
      command: '/app/affiliate-mcp',
      args: ['/app/server.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('omits env when it is empty', () => {
    const entry = buildAffiliateEntryValue({
      nodePath: '/app/affiliate-mcp',
      serverPath: '/app/server.cjs',
      env: {},
    });
    expect(entry).toEqual({ command: '/app/affiliate-mcp', args: ['/app/server.cjs'] });
    expect('env' in entry).toBe(false);
  });

  it('never attaches env to the npx fallback', () => {
    const entry = buildAffiliateEntryValue({ env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(entry).toEqual({
      command: AFFILIATE_ENTRY_VALUE.command,
      args: [...AFFILIATE_ENTRY_VALUE.args],
    });
  });
});

describe('addAffiliateEntry — env is written and round-trips', () => {
  it('writes the complete entry (command, args, env) in one pass', async () => {
    const cp = configPath();
    const entryValue = buildAffiliateEntryValue({
      nodePath: '/app/affiliate-mcp',
      serverPath: '/app/server.cjs',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const result = await addAffiliateEntry({ configPath: cp, entryValue });
    expect(result.action).toBe('created');
    expect(readJSON(cp)).toEqual({
      mcpServers: {
        [AFFILIATE_ENTRY_KEY]: {
          command: '/app/affiliate-mcp',
          args: ['/app/server.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    });
  });

  it('treats an env-only difference as a change worth rewriting (with backup)', async () => {
    const cp = configPath();
    // Existing entry has the same command/args but NO env.
    writeFileSync(
      cp,
      JSON.stringify({
        mcpServers: {
          [AFFILIATE_ENTRY_KEY]: { command: '/app/affiliate-mcp', args: ['/app/server.cjs'] },
        },
      }),
    );
    const entryValue = buildAffiliateEntryValue({
      nodePath: '/app/affiliate-mcp',
      serverPath: '/app/server.cjs',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const result = await addAffiliateEntry({ configPath: cp, entryValue, now: () => fixedDate });
    expect(result.action).toBe('updated');
    expect(result.backupPath).toBeDefined();
    expect((readJSON(cp) as { mcpServers: Record<string, unknown> }).mcpServers[AFFILIATE_ENTRY_KEY]).toEqual({
      command: '/app/affiliate-mcp',
      args: ['/app/server.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });
});

describe('addAffiliateEntry — file missing', () => {
  it('creates the file with mcpServers.affiliate', async () => {
    const cp = path.join(tmp, 'nested', 'claude_desktop_config.json');
    const result = await addAffiliateEntry({ configPath: cp });
    expect(result.action).toBe('created');
    expect(result.backupPath).toBeUndefined();
    expect(readJSON(cp)).toEqual({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
  });

  it('respects dry-run and writes nothing', async () => {
    const cp = configPath();
    const result = await addAffiliateEntry({ configPath: cp, dryRun: true });
    expect(result.action).toBe('would-create');
    expect(existsSync(cp)).toBe(false);
  });
});

describe('addAffiliateEntry — file present', () => {
  it('preserves unrelated mcpServers and adds affiliate', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      JSON.stringify({
        mcpServers: { other: { command: 'node', args: ['other.js'] } },
        unrelatedTopLevel: { keep: true },
      }),
    );
    const result = await addAffiliateEntry({ configPath: cp, now: () => fixedDate });
    expect(result.action).toBe('added');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    const written = readJSON(cp) as {
      mcpServers: Record<string, unknown>;
      unrelatedTopLevel: unknown;
    };
    expect(written.mcpServers).toEqual({
      other: { command: 'node', args: ['other.js'] },
      [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE,
    });
    expect(written.unrelatedTopLevel).toEqual({ keep: true });
    // Backup is byte-identical to the original we wrote.
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(
      JSON.stringify({
        mcpServers: { other: { command: 'node', args: ['other.js'] } },
        unrelatedTopLevel: { keep: true },
      }),
    );
  });

  it('no-ops when an identical affiliate entry already exists', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      JSON.stringify({
        mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
      }),
    );
    const before = readFileSync(cp, 'utf8');
    const result = await addAffiliateEntry({ configPath: cp });
    expect(result.action).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(cp, 'utf8')).toBe(before);
    expect(readdirSync(tmp).some((f) => f.includes('.bak.'))).toBe(false);
  });

  it('overwrites a divergent affiliate entry when onConflict approves', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      JSON.stringify({
        mcpServers: {
          [AFFILIATE_ENTRY_KEY]: { command: 'node', args: ['old.js'] },
        },
      }),
    );
    const result = await addAffiliateEntry({
      configPath: cp,
      onConflict: async () => true,
      now: () => fixedDate,
    });
    expect(result.action).toBe('updated');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    const written = readJSON(cp) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[AFFILIATE_ENTRY_KEY]).toEqual(AFFILIATE_ENTRY_VALUE);
  });

  it('leaves the file alone when onConflict declines', async () => {
    const cp = configPath();
    const original = JSON.stringify({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: { command: 'node', args: ['old.js'] } },
    });
    writeFileSync(cp, original);
    const result = await addAffiliateEntry({
      configPath: cp,
      onConflict: async () => false,
    });
    expect(result.action).toBe('unchanged');
    expect(readFileSync(cp, 'utf8')).toBe(original);
  });

  it('aborts on malformed JSON without writing', async () => {
    const cp = configPath();
    writeFileSync(cp, '{ this is not valid json');
    await expect(addAffiliateEntry({ configPath: cp })).rejects.toBeInstanceOf(
      MalformedDesktopConfigError,
    );
    expect(readFileSync(cp, 'utf8')).toBe('{ this is not valid json');
  });

  it('rewrites malformed JSON when forceOverwrite is set, after backing up', async () => {
    const cp = configPath();
    writeFileSync(cp, '{ this is not valid json');
    const result = await addAffiliateEntry({
      configPath: cp,
      forceOverwrite: true,
      now: () => fixedDate,
    });
    expect(result.action).toBe('updated');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(readJSON(cp)).toEqual({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
    expect(readFileSync(result.backupPath!, 'utf8')).toBe('{ this is not valid json');
  });

  it('dry-run with existing file leaves no changes', async () => {
    const cp = configPath();
    const original = JSON.stringify({ mcpServers: { other: { command: 'x' } } });
    writeFileSync(cp, original);
    const result = await addAffiliateEntry({ configPath: cp, dryRun: true });
    expect(result.action).toBe('would-add');
    expect(readFileSync(cp, 'utf8')).toBe(original);
    expect(readdirSync(tmp).some((f) => f.includes('.bak.'))).toBe(false);
  });
});

describe('removeAffiliateEntry', () => {
  it('returns absent when the file is missing', async () => {
    const result = await removeAffiliateEntry({ configPath: configPath() });
    expect(result.action).toBe('absent');
  });

  it('returns absent when the entry is not there', async () => {
    const cp = configPath();
    writeFileSync(cp, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const result = await removeAffiliateEntry({ configPath: cp });
    expect(result.action).toBe('absent');
  });

  it('removes the entry and preserves siblings', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      JSON.stringify({
        mcpServers: {
          other: { command: 'x' },
          [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE,
        },
        unrelated: 1,
      }),
    );
    const result = await removeAffiliateEntry({ configPath: cp, now: () => fixedDate });
    expect(result.action).toBe('removed');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(readJSON(cp)).toEqual({
      mcpServers: { other: { command: 'x' } },
      unrelated: 1,
    });
  });

  it('dry-run leaves the file untouched', async () => {
    const cp = configPath();
    const body = JSON.stringify({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
    writeFileSync(cp, body);
    const result = await removeAffiliateEntry({ configPath: cp, dryRun: true });
    expect(result.action).toBe('would-remove');
    expect(readFileSync(cp, 'utf8')).toBe(body);
  });
});
