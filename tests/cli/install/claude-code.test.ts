import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_ENTRY_KEY,
  AFFILIATE_ENTRY_VALUE,
} from '../../../src/cli/install/claude-desktop.js';
import {
  ClaudeCodeError,
  addToClaudeCode,
  removeFromClaudeCode,
  type SpawnFn,
  type SpawnResult,
} from '../../../src/cli/install/claude-code.js';

function ok(stdout = '', stderr = ''): SpawnResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr = 'boom', code = 1): SpawnResult {
  return { code, stdout: '', stderr };
}

function recorder(scripted: SpawnResult[]): {
  spawn: SpawnFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawn: SpawnFn = async (args) => {
    calls.push(args);
    const next = scripted[i++];
    if (!next) throw new Error(`spawn called more times than scripted: ${args.join(' ')}`);
    return next;
  };
  return { spawn, calls };
}

describe('addToClaudeCode', () => {
  it('adds affiliate when not present', async () => {
    const { spawn, calls } = recorder([
      ok(JSON.stringify({ mcpServers: {} })),
      ok('added'),
    ]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('added');
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'add', AFFILIATE_ENTRY_KEY, '--', 'npx', 'affiliate-networks-mcp'],
    ]);
  });

  it('returns unchanged when an identical entry already exists', async () => {
    const { spawn, calls } = recorder([
      ok(JSON.stringify({ mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE } })),
    ]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('unchanged');
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });

  it('removes and re-adds when an entry differs', async () => {
    const { spawn, calls } = recorder([
      ok(
        JSON.stringify({
          mcpServers: { [AFFILIATE_ENTRY_KEY]: { command: 'node', args: ['old.js'] } },
        }),
      ),
      ok('removed'),
      ok('added'),
    ]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('updated');
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['mcp', 'list'],
      ['mcp', 'remove'],
      ['mcp', 'add'],
    ]);
  });

  it('accepts a flat list shape (without mcpServers wrapper)', async () => {
    const { spawn } = recorder([
      ok(JSON.stringify({ [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE })),
    ]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('unchanged');
  });

  it('treats unparseable list output as absent', async () => {
    const { spawn, calls } = recorder([
      ok('not json'),
      ok('added'),
    ]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('added');
    expect(calls).toHaveLength(2);
  });

  it('treats a failing list as absent (lets add surface the real error)', async () => {
    const { spawn, calls } = recorder([fail('list failed'), ok('added')]);
    const result = await addToClaudeCode({ spawn });
    expect(result.action).toBe('added');
    expect(calls).toHaveLength(2);
  });

  it('throws ClaudeCodeError when add fails', async () => {
    const { spawn } = recorder([
      ok(JSON.stringify({ mcpServers: {} })),
      fail('permission denied', 2),
    ]);
    await expect(addToClaudeCode({ spawn })).rejects.toBeInstanceOf(ClaudeCodeError);
  });

  it('respects dry-run on fresh add', async () => {
    const { spawn, calls } = recorder([ok(JSON.stringify({ mcpServers: {} }))]);
    const result = await addToClaudeCode({ spawn, dryRun: true });
    expect(result.action).toBe('would-add');
    expect(calls).toHaveLength(1);
  });

  it('respects dry-run on update', async () => {
    const { spawn, calls } = recorder([
      ok(
        JSON.stringify({
          mcpServers: { [AFFILIATE_ENTRY_KEY]: { command: 'node', args: ['old.js'] } },
        }),
      ),
    ]);
    const result = await addToClaudeCode({ spawn, dryRun: true });
    expect(result.action).toBe('would-update');
    expect(calls).toHaveLength(1);
  });
});

describe('removeFromClaudeCode', () => {
  it('returns absent when no entry exists', async () => {
    const { spawn } = recorder([ok(JSON.stringify({ mcpServers: {} }))]);
    const result = await removeFromClaudeCode({ spawn });
    expect(result.action).toBe('absent');
  });

  it('removes the entry when present', async () => {
    const { spawn, calls } = recorder([
      ok(JSON.stringify({ mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE } })),
      ok('removed'),
    ]);
    const result = await removeFromClaudeCode({ spawn });
    expect(result.action).toBe('removed');
    expect(calls[1]).toEqual(['mcp', 'remove', AFFILIATE_ENTRY_KEY]);
  });

  it('dry-run does not run remove', async () => {
    const { spawn, calls } = recorder([
      ok(JSON.stringify({ mcpServers: { [AFFILIATE_ENTRY_KEY]: AFFILIATE_ENTRY_VALUE } })),
    ]);
    const result = await removeFromClaudeCode({ spawn, dryRun: true });
    expect(result.action).toBe('would-remove');
    expect(calls).toHaveLength(1);
  });
});
