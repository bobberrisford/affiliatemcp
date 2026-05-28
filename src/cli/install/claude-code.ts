/**
 * Wrapper for `claude mcp ...` shell commands.
 *
 * Claude Code stores its MCP server list inside its own config — we don't try
 * to touch that file directly. The CLI is the supported surface, so we just
 * shell out and let it manage on-disk state.
 *
 * We expose a `spawn` injection point so tests can stub the subprocess; the
 * real implementation uses `child_process.spawn` and captures stdout/stderr.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import { AFFILIATE_ENTRY_KEY, AFFILIATE_ENTRY_VALUE } from './claude-desktop.js';

export type CodeAction = 'added' | 'unchanged' | 'updated' | 'removed' | 'absent' | 'would-add' | 'would-update' | 'would-remove';

export interface CodeResult {
  action: CodeAction;
  rawOutput: string;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (args: string[]) => Promise<SpawnResult>;

export const defaultSpawn: SpawnFn = (args) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

export interface AddCodeOptions {
  spawn?: SpawnFn;
  dryRun?: boolean;
}

/**
 * Add (or refresh) the affiliate MCP server in Claude Code.
 *
 * Behaviour:
 *   - Run `claude mcp list --json` to see what's already there.
 *   - If `affiliate` is absent → run `claude mcp add affiliate -- npx affiliate-networks-mcp`.
 *   - If `affiliate` is present and identical → no-op, action='unchanged'.
 *   - If `affiliate` is present but differs → `claude mcp remove affiliate` then add, action='updated'.
 *
 * Claude Code's `mcp list --json` is the documented machine-readable format
 * for this kind of inspection; we degrade gracefully if it's missing
 * (treat unparsable output as "absent" and let the add command surface the
 * real error).
 */
export async function addToClaudeCode(opts: AddCodeOptions = {}): Promise<CodeResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const dryRun = opts.dryRun ?? false;

  const list = await listClaudeCodeServers(spawn);
  const existing = list[AFFILIATE_ENTRY_KEY];

  if (existing && entryMatches(existing)) {
    return { action: 'unchanged', rawOutput: '' };
  }

  if (existing) {
    if (dryRun) return { action: 'would-update', rawOutput: '' };
    const removeRes = await spawn(['mcp', 'remove', AFFILIATE_ENTRY_KEY]);
    if (removeRes.code !== 0) {
      throw new ClaudeCodeError('remove', removeRes);
    }
    const addRes = await spawn(['mcp', 'add', AFFILIATE_ENTRY_KEY, '--', 'npx', 'affiliate-networks-mcp']);
    if (addRes.code !== 0) {
      throw new ClaudeCodeError('add', addRes);
    }
    return { action: 'updated', rawOutput: `${removeRes.stdout}\n${addRes.stdout}`.trim() };
  }

  if (dryRun) return { action: 'would-add', rawOutput: '' };
  const addRes = await spawn(['mcp', 'add', AFFILIATE_ENTRY_KEY, '--', 'npx', 'affiliate-networks-mcp']);
  if (addRes.code !== 0) {
    throw new ClaudeCodeError('add', addRes);
  }
  return { action: 'added', rawOutput: addRes.stdout.trim() };
}

export interface RemoveCodeOptions {
  spawn?: SpawnFn;
  dryRun?: boolean;
}

export async function removeFromClaudeCode(opts: RemoveCodeOptions = {}): Promise<CodeResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const dryRun = opts.dryRun ?? false;

  const list = await listClaudeCodeServers(spawn);
  if (!(AFFILIATE_ENTRY_KEY in list)) {
    return { action: 'absent', rawOutput: '' };
  }
  if (dryRun) return { action: 'would-remove', rawOutput: '' };
  const removeRes = await spawn(['mcp', 'remove', AFFILIATE_ENTRY_KEY]);
  if (removeRes.code !== 0) {
    throw new ClaudeCodeError('remove', removeRes);
  }
  return { action: 'removed', rawOutput: removeRes.stdout.trim() };
}

/**
 * Run `claude mcp list --json` and return a parsed map of server-name → entry.
 * Unknown shapes return `{}` — the caller treats that as "not present" and
 * lets the add path produce the actual error message.
 */
async function listClaudeCodeServers(spawn: SpawnFn): Promise<Record<string, unknown>> {
  const res = await spawn(['mcp', 'list', '--json']);
  if (res.code !== 0) return {};
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Claude Code's shape: { mcpServers: { name: { command, args } } } or
      // a flat { name: { command, args } }. Accept either.
      const obj = parsed as Record<string, unknown>;
      const servers = obj['mcpServers'];
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        return servers as Record<string, unknown>;
      }
      return obj;
    }
    return {};
  } catch {
    return {};
  }
}

function entryMatches(existing: unknown): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const e = existing as { command?: unknown; args?: unknown };
  if (e.command !== AFFILIATE_ENTRY_VALUE.command) return false;
  if (!Array.isArray(e.args)) return false;
  const want = AFFILIATE_ENTRY_VALUE.args;
  if (e.args.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (e.args[i] !== want[i]) return false;
  }
  return true;
}

export class ClaudeCodeError extends Error {
  constructor(
    public readonly step: 'add' | 'remove',
    public readonly result: SpawnResult,
  ) {
    super(
      `claude mcp ${step} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || '<no output>'}`,
    );
    this.name = 'ClaudeCodeError';
  }
}
