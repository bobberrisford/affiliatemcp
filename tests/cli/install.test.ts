/**
 * End-to-end tests for the install orchestrator.
 *
 * Drives `runInstall` against a tmpdir Claude Desktop config and a fake
 * `claude mcp` spawn, with a `FakePrompter` for the interactive paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runInstall, runUninstall } from '../../src/cli/install.js';
import { AFFILIATE_ENTRY_KEY, AFFILIATE_ENTRY_VALUE } from '../../src/cli/install/claude-desktop.js';
import type { SpawnFn, SpawnResult } from '../../src/cli/install/claude-code.js';
import { FakePrompter } from './fakes.js';

let tmp: string;
let stdoutWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-install-'));
  stdoutWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function out(): string {
  return stdoutWrites.join('');
}

function fakeSpawn(scripted: SpawnResult[]): SpawnFn {
  let i = 0;
  return async () => {
    const next = scripted[i++];
    if (!next) throw new Error('fakeSpawn exhausted');
    return next;
  };
}

function ok(stdout = ''): SpawnResult {
  return { code: 0, stdout, stderr: '' };
}

describe('runInstall — auto mode, both present', () => {
  it('installs to both when user picks "both"', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const prompter = new FakePrompter(['all']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
      spawnClaudeCode: fakeSpawn([
        ok(JSON.stringify({ mcpServers: {} })),
        ok('added'),
      ]),
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(desktopPath, 'utf8'))).toEqual({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
    expect(out()).toContain("Claude Desktop: created");
    expect(out()).toContain("Claude Code: added 'affiliate'");
    expect(out()).toContain('Restart Claude Desktop');
  });

  it('prompts when Desktop and Codex are detected, then installs both when selected', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const codexPath = path.join(tmp, '.codex', 'config.toml');
    const prompter = new FakePrompter(['all']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'absent', codex: 'present' },
      desktopConfigPathOverride: desktopPath,
      codexConfigPathOverride: codexPath,
      spawnClaudeCode: fakeSpawn([]), // should never be called
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(desktopPath, 'utf8'))).toEqual({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
    expect(readFileSync(codexPath, 'utf8')).toContain('[mcp_servers.affiliate]');
    expect(out()).toContain('Claude Desktop: created');
    expect(out()).toContain('Codex: created');
    expect(out()).not.toContain('Claude Code:');
  });

  it('lets the user pick Desktop only', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const prompter = new FakePrompter(['desktop']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
      spawnClaudeCode: fakeSpawn([]), // should never be called
    });
    expect(code).toBe(0);
    expect(out()).toContain('Claude Desktop: created');
    expect(out()).not.toContain('Claude Code:');
  });

  it('cancel option exits with no changes', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const prompter = new FakePrompter(['cancel']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(0);
    expect(out()).not.toContain('Claude Desktop:');
  });
});

describe('runInstall — auto mode, single client', () => {
  it('skips prompting when only Code is present', async () => {
    const code = await runInstall({
      detection: { desktop: 'absent', desktopConfigPath: '/nope', code: 'present' },
      spawnClaudeCode: fakeSpawn([ok(JSON.stringify({ mcpServers: {} })), ok('added')]),
    });
    expect(code).toBe(0);
    expect(out()).toContain("Claude Code: added 'affiliate'");
    expect(out()).not.toContain('Claude Desktop:');
  });

  it('skips prompting when only Desktop is present', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const code = await runInstall({
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'absent' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(0);
    expect(out()).toContain('Claude Desktop: created');
    expect(out()).not.toContain('Claude Code:');
  });
});

describe('runInstall — no clients detected', () => {
  it('offers Cowork; declining shows guidance and exits 0 (Linux)', async () => {
    const prompter = new FakePrompter(['cancel']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'notSupported', desktopConfigPath: null, code: 'absent' },
    });
    expect(code).toBe(0);
    expect(out()).toContain('Claude Desktop is not supported');
  });

  it('offers Cowork; declining shows guidance and exits 0 (macOS, nothing installed)', async () => {
    const prompter = new FakePrompter(['cancel']);
    const code = await runInstall({
      prompter,
      detection: { desktop: 'absent', desktopConfigPath: path.join(tmp, 'x.json'), code: 'absent' },
    });
    expect(code).toBe(0);
    expect(out()).toContain('No Claude, Codex, or Copilot client detected.');
  });

  it('routes to the Cowork mirror when accepted', async () => {
    const prompter = new FakePrompter(['cowork']);
    let called = false;
    const code = await runInstall({
      prompter,
      detection: { desktop: 'absent', desktopConfigPath: path.join(tmp, 'x.json'), code: 'absent' },
      coworkMirror: async () => {
        called = true;
        return {
          action: 'created',
          backend: 'gh',
          targetFullName: 'octocat/affiliatemcp-internal',
          targetUrl: 'https://github.com/octocat/affiliatemcp-internal.git',
          upstream: 'bobberrisford/affiliatemcp',
        };
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
  });
});

describe('runInstall — explicit targets', () => {
  it('--desktop ignores Code even when detected', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const code = await runInstall({
      target: 'desktop',
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(0);
    expect(out()).toContain('Claude Desktop: created');
    expect(out()).not.toContain('Claude Code:');
  });

  it('--code ignores Desktop even when detected', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const code = await runInstall({
      target: 'code',
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      spawnClaudeCode: fakeSpawn([ok(JSON.stringify({ mcpServers: {} })), ok('added')]),
    });
    expect(code).toBe(0);
    expect(out()).toContain("Claude Code: added 'affiliate'");
    expect(out()).not.toContain('Claude Desktop:');
  });

  it('--codex writes Codex config and does not require the Codex CLI', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const codexPath = path.join(tmp, '.codex', 'config.toml');
    const code = await runInstall({
      target: 'codex',
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      codexConfigPathOverride: codexPath,
      spawnClaudeCode: fakeSpawn([]), // must never be called
    });
    expect(code).toBe(0);
    expect(readFileSync(codexPath, 'utf8')).toContain('[mcp_servers.affiliate]');
    expect(readFileSync(codexPath, 'utf8')).toContain('args = ["-y", "affiliate-networks-mcp"]');
    expect(out()).toContain('Codex: created');
    expect(out()).not.toContain('Claude Desktop:');
    expect(out()).not.toContain('Claude Code:');
  });

  it('--copilot writes the VS Code mcp.json and does not require VS Code', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const copilotPath = path.join(tmp, 'Code', 'User', 'mcp.json');
    const code = await runInstall({
      target: 'copilot',
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      copilotConfigPathOverride: copilotPath,
      spawnClaudeCode: fakeSpawn([]), // must never be called
    });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(copilotPath, 'utf8')) as {
      servers: Record<string, unknown>;
    };
    expect(written.servers['affiliate']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'affiliate-networks-mcp'],
    });
    expect(out()).toContain('GitHub Copilot: created');
    expect(out()).toContain('Agent mode');
    expect(out()).not.toContain('Claude Desktop:');
    expect(out()).not.toContain('Claude Code:');
  });

  it('--all includes Codex and Copilot and still excludes Cowork', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const codexPath = path.join(tmp, '.codex', 'config.toml');
    const copilotPath = path.join(tmp, 'Code', 'User', 'mcp.json');
    let mirrorCalled = false;
    const code = await runInstall({
      target: 'all',
      detection: {
        desktop: 'present',
        desktopConfigPath: desktopPath,
        code: 'present',
        codex: 'absent',
        copilot: 'absent',
      },
      desktopConfigPathOverride: desktopPath,
      codexConfigPathOverride: codexPath,
      copilotConfigPathOverride: copilotPath,
      spawnClaudeCode: fakeSpawn([ok(JSON.stringify({ mcpServers: {} })), ok('added')]),
      coworkMirror: async () => {
        mirrorCalled = true;
        throw new Error('must not run Cowork from --all');
      },
    });
    expect(code).toBe(0);
    expect(out()).toContain('Claude Desktop: created');
    expect(out()).toContain("Claude Code: added 'affiliate'");
    expect(out()).toContain('Codex: created');
    expect(out()).toContain('GitHub Copilot: created');
    expect(readFileSync(codexPath, 'utf8')).toContain('[mcp_servers.affiliate]');
    expect(readFileSync(copilotPath, 'utf8')).toContain('"affiliate"');
    expect(mirrorCalled).toBe(false);
  });

  it('--cowork runs only the mirror, never touches Desktop/Code', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    let mirrorArgs: unknown;
    const code = await runInstall({
      target: 'cowork',
      dryRun: true,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
      spawnClaudeCode: fakeSpawn([]), // must never be called
      coworkMirror: async (o) => {
        mirrorArgs = o;
        return {
          action: 'dry-run',
          backend: 'pat',
          targetFullName: 'octocat/affiliatemcp-internal',
          targetUrl: 'https://github.com/octocat/affiliatemcp-internal.git',
          upstream: 'bobberrisford/affiliatemcp',
        };
      },
    });
    expect(code).toBe(0);
    expect((mirrorArgs as { dryRun?: boolean }).dryRun).toBe(true);
    expect(() => readFileSync(desktopPath, 'utf8')).toThrow(); // no desktop write
  });

  it('returns 1 when the mirror fails', async () => {
    const { CoworkMirrorError } = await import('../../src/cli/install/cowork-mirror.js');
    const code = await runInstall({
      target: 'cowork',
      coworkMirror: async () => {
        throw new CoworkMirrorError('push the mirror', 'boom');
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("Couldn't push the mirror");
  });
});

describe('runInstall — malformed Desktop config', () => {
  it('surfaces the malformed-JSON error and returns 1', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    writeFileSync(desktopPath, '{ broken');
    const code = await runInstall({
      target: 'desktop',
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'absent' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(1);
    expect(out()).toContain('is not valid JSON');
    expect(readFileSync(desktopPath, 'utf8')).toBe('{ broken');
  });

  it('--force-overwrite backs up and rewrites', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    writeFileSync(desktopPath, '{ broken');
    const code = await runInstall({
      target: 'desktop',
      forceOverwrite: true,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'absent' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(desktopPath, 'utf8'))).toEqual({
      mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
    });
  });
});

describe('runUninstall', () => {
  it('removes from both targets symmetrically', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    writeFileSync(
      desktopPath,
      JSON.stringify({
        mcpServers: { other: { command: 'x' }, [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE },
      }),
    );
    const prompter = new FakePrompter(['all']);
    const code = await runUninstall({
      prompter,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'present' },
      desktopConfigPathOverride: desktopPath,
      spawnClaudeCode: fakeSpawn([
        ok(JSON.stringify({ mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE } })),
        ok('removed'),
      ]),
    });
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(desktopPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers).toEqual({ other: { command: 'x' } });
    expect(out()).toContain("Claude Code: removed 'affiliate'");
  });

  it('--copilot removes the affiliate entry and preserves siblings', async () => {
    const copilotPath = path.join(tmp, 'Code', 'User', 'mcp.json');
    mkdirSync(path.dirname(copilotPath), { recursive: true });
    writeFileSync(
      copilotPath,
      JSON.stringify({
        servers: {
          other: { command: 'x' },
          affiliate: { type: 'stdio', command: 'npx', args: ['-y', 'affiliate-networks-mcp'] },
        },
      }),
    );
    const code = await runUninstall({
      target: 'copilot',
      detection: { desktop: 'absent', desktopConfigPath: null, code: 'absent' },
      copilotConfigPathOverride: copilotPath,
    });
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(copilotPath, 'utf8')) as {
      servers: Record<string, unknown>;
    };
    expect(after.servers).toEqual({ other: { command: 'x' } });
    expect(out()).toContain("GitHub Copilot: removed 'affiliate'");
  });

  it('--cowork prints manual removal instructions', async () => {
    const code = await runUninstall({
      target: 'cowork',
      detection: { desktop: 'absent', desktopConfigPath: null, code: 'absent' },
    });
    expect(code).toBe(0);
    expect(out()).toContain('To remove from Cowork');
    expect(out()).toContain('Organization settings → Plugins');
  });
});

describe('runInstall — dry-run', () => {
  it('does not write to Desktop config', async () => {
    const desktopPath = path.join(tmp, 'claude_desktop_config.json');
    const code = await runInstall({
      target: 'desktop',
      dryRun: true,
      detection: { desktop: 'present', desktopConfigPath: desktopPath, code: 'absent' },
      desktopConfigPathOverride: desktopPath,
    });
    expect(code).toBe(0);
    expect(out()).toContain('dry-run');
    expect(() => readFileSync(desktopPath, 'utf8')).toThrow();
  });
});
