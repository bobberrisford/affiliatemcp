import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COPILOT_ENTRY_KEY,
  COPILOT_ENTRY_VALUE,
  MalformedCopilotConfigError,
  addAffiliateCopilotEntry,
  removeAffiliateCopilotEntry,
  resolveCopilotConfigPath,
} from '../../../src/cli/install/copilot.js';

let tmp: string;
const fixedDate = new Date(2026, 4, 28, 11, 45, 23); // 2026-05-28 11:45:23

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-copilot-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmp, 'mcp.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
}

describe('resolveCopilotConfigPath', () => {
  it('resolves the VS Code user mcp.json on macOS', () => {
    const p = resolveCopilotConfigPath('darwin', { HOME: '/Users/x' });
    expect(p).toBe('/Users/x/Library/Application Support/Code/User/mcp.json');
  });

  it('resolves under APPDATA on Windows', () => {
    const p = resolveCopilotConfigPath('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
    expect(p).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'Code', 'User', 'mcp.json'));
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    const p = resolveCopilotConfigPath('linux', { XDG_CONFIG_HOME: '/home/x/.config' });
    expect(p).toBe('/home/x/.config/Code/User/mcp.json');
  });

  it('falls back to ~/.config on Linux without XDG_CONFIG_HOME', () => {
    const p = resolveCopilotConfigPath('linux', { HOME: '/home/x' });
    expect(p).toBe('/home/x/.config/Code/User/mcp.json');
  });
});

describe('addAffiliateCopilotEntry — file missing', () => {
  it('creates mcp.json with the affiliate server under "servers"', async () => {
    const result = await addAffiliateCopilotEntry({ configPath: configPath() });

    expect(result.action).toBe('created');
    expect(result.backupPath).toBeUndefined();
    expect(readConfig()).toEqual({ servers: { [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE } });
  });

  it('respects dry-run and writes nothing', async () => {
    const result = await addAffiliateCopilotEntry({ configPath: configPath(), dryRun: true });

    expect(result.action).toBe('would-create');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('addAffiliateCopilotEntry — file present', () => {
  it('preserves unrelated existing servers and adds the affiliate entry', async () => {
    const cp = configPath();
    const original = { servers: { other: { type: 'stdio', command: 'node' } } };
    writeFileSync(cp, `${JSON.stringify(original, null, 2)}\n`);

    const result = await addAffiliateCopilotEntry({ configPath: cp, now: () => fixedDate });

    expect(result.action).toBe('added');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(readConfig()).toEqual({
      servers: {
        other: { type: 'stdio', command: 'node' },
        [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE,
      },
    });
  });

  it('is idempotent — an already-matching entry is unchanged', async () => {
    const cp = configPath();
    await addAffiliateCopilotEntry({ configPath: cp });
    const second = await addAffiliateCopilotEntry({ configPath: cp });
    expect(second.action).toBe('unchanged');
    expect(second.backupPath).toBeUndefined();
  });

  it('overwrites a differing entry and backs up first', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      `${JSON.stringify({ servers: { [COPILOT_ENTRY_KEY]: { command: 'old' } } }, null, 2)}\n`,
    );

    const result = await addAffiliateCopilotEntry({ configPath: cp, now: () => fixedDate });

    expect(result.action).toBe('updated');
    expect(result.backupPath).toBe(`${cp}.bak.20260528-114523`);
    expect(readConfig()).toEqual({ servers: { [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE } });
    expect(readdirSync(tmp).filter((f) => f.includes('.bak.'))).toHaveLength(1);
  });

  it('leaves a differing entry alone when onConflict declines', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      `${JSON.stringify({ servers: { [COPILOT_ENTRY_KEY]: { command: 'old' } } }, null, 2)}\n`,
    );

    const result = await addAffiliateCopilotEntry({
      configPath: cp,
      onConflict: async () => false,
    });

    expect(result.action).toBe('unchanged');
    expect(readConfig()).toEqual({ servers: { [COPILOT_ENTRY_KEY]: { command: 'old' } } });
  });

  it('throws on malformed JSON unless force-overwrite is set', async () => {
    const cp = configPath();
    writeFileSync(cp, '{ broken');

    await expect(addAffiliateCopilotEntry({ configPath: cp })).rejects.toBeInstanceOf(
      MalformedCopilotConfigError,
    );
    expect(readFileSync(cp, 'utf8')).toBe('{ broken');

    const result = await addAffiliateCopilotEntry({
      configPath: cp,
      forceOverwrite: true,
      now: () => fixedDate,
    });
    expect(result.action).toBe('updated');
    expect(readConfig()).toEqual({ servers: { [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE } });
  });
});

describe('removeAffiliateCopilotEntry', () => {
  it('removes the affiliate entry and preserves siblings', async () => {
    const cp = configPath();
    writeFileSync(
      cp,
      `${JSON.stringify(
        {
          servers: { other: { command: 'node' }, [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE },
        },
        null,
        2,
      )}\n`,
    );

    const result = await removeAffiliateCopilotEntry({ configPath: cp, now: () => fixedDate });

    expect(result.action).toBe('removed');
    expect(readConfig()).toEqual({ servers: { other: { command: 'node' } } });
  });

  it('reports absent when the file does not exist', async () => {
    const result = await removeAffiliateCopilotEntry({ configPath: configPath() });
    expect(result.action).toBe('absent');
  });
});
