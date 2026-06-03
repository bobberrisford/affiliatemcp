import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CODEX_AFFILIATE_BLOCK,
  addAffiliateCodexEntry,
  removeAffiliateCodexEntry,
  resolveCodexConfigPath,
} from '../../../src/cli/install/codex.js';

let tmp: string;
const fixedDate = new Date(2026, 4, 28, 11, 45, 23); // 2026-05-28 11:45:23

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-codex-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmp, '.codex', 'config.toml');
}

function readConfig(): string {
  return readFileSync(configPath(), 'utf8');
}

function writeConfig(body: string): void {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), body);
}

function affiliateBlockCount(body: string): number {
  return [...body.matchAll(/^\[mcp_servers\.affiliate\]$/gm)].length;
}

describe('resolveCodexConfigPath', () => {
  it('uses HOME without checking whether Codex is installed', () => {
    expect(resolveCodexConfigPath({ HOME: tmp })).toBe(configPath());
  });
});

describe('addAffiliateCodexEntry — file missing', () => {
  it('creates ~/.codex/config.toml with the affiliate MCP server', async () => {
    const result = await addAffiliateCodexEntry({ configPath: configPath() });

    expect(result.action).toBe('created');
    expect(result.backupPath).toBeUndefined();
    expect(readConfig()).toBe(`${CODEX_AFFILIATE_BLOCK}\n`);
  });

  it('respects dry-run and writes nothing', async () => {
    const result = await addAffiliateCodexEntry({ configPath: configPath(), dryRun: true });

    expect(result.action).toBe('would-create');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('addAffiliateCodexEntry — file present', () => {
  it('preserves unrelated existing config and adds the affiliate block', async () => {
    const cp = configPath();
    const original = 'model = "gpt-5.3-codex"\n\n[mcp_servers.other]\ncommand = "node"\n';
    writeConfig(original);

    const result = await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(result.action).toBe('added');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(readConfig()).toBe(`${original}\n${CODEX_AFFILIATE_BLOCK}\n`);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(String(result.backupPath), 'utf8')).toBe(original);
  });

  it('updates an existing affiliate block idempotently', async () => {
    const cp = configPath();
    writeConfig(
      'model = "gpt-5.3-codex"\n\n[mcp_servers.affiliate]\ncommand = "node"\nargs = ["old.js"]\n\n[mcp_servers.other]\ncommand = "node"\n',
    );

    const first = await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });
    const afterFirst = readConfig();
    const second = await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(first.action).toBe('updated');
    expect(second.action).toBe('unchanged');
    expect(readConfig()).toBe(afterFirst);
    expect(affiliateBlockCount(afterFirst)).toBe(1);
    expect(afterFirst).toContain(CODEX_AFFILIATE_BLOCK);
    expect(afterFirst).toContain('[mcp_servers.other]');
  });

  it('does not duplicate the affiliate block when run twice', async () => {
    const cp = configPath();
    writeConfig('approval_policy = "on-request"\n');

    await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });
    await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(affiliateBlockCount(readConfig())).toBe(1);
  });

  it('creates a backup when modifying an existing config', async () => {
    const cp = configPath();
    writeConfig('approval_policy = "on-request"\n');

    const result = await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(String(result.backupPath), 'utf8')).toBe('approval_policy = "on-request"\n');
    expect(readdirSync(path.dirname(cp)).filter((f) => f.includes('.bak.'))).toHaveLength(1);
  });

  it('cleans up duplicate existing affiliate blocks', async () => {
    const cp = configPath();
    writeConfig(
      '[mcp_servers.affiliate]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "node"\n\n[mcp_servers.affiliate]\ncommand = "older"\n',
    );

    await addAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(affiliateBlockCount(readConfig())).toBe(1);
    expect(readConfig()).toContain('[mcp_servers.other]');
  });
});

describe('removeAffiliateCodexEntry', () => {
  it('removes the affiliate block and preserves other config', async () => {
    const cp = configPath();
    writeConfig(`model = "gpt-5.3-codex"\n\n${CODEX_AFFILIATE_BLOCK}\n\n[mcp_servers.other]\ncommand = "node"\n`);

    const result = await removeAffiliateCodexEntry({ configPath: cp, now: () => fixedDate });

    expect(result.action).toBe('removed');
    expect(readConfig()).toContain('model = "gpt-5.3-codex"');
    expect(readConfig()).toContain('[mcp_servers.other]');
    expect(readConfig()).not.toContain('[mcp_servers.affiliate]');
  });
});
