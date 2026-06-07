/**
 * Safe-edit for Claude Desktop's MCP config file.
 *
 * Claude Desktop stores its MCP server list at a platform-specific path
 * (resolved by `resolveDesktopConfigPath`). The file may already contain
 * other MCP servers the user cares about, so this module:
 *
 *   - reads + parses the existing JSON,
 *   - merges our `affiliate` entry into `mcpServers` (never replaces siblings),
 *   - takes a timestamped backup before any write,
 *   - writes atomically via `atomicWriteJSON` (write-tmp → rename),
 *   - skips the write if the existing entry already matches byte-for-byte,
 *   - aborts loudly when the existing JSON is malformed unless the caller
 *     passes `forceOverwrite: true` (which backs up first, then rewrites).
 *
 * Linux is not a supported target for Claude Desktop. `resolveDesktopConfigPath`
 * returns `null` on Linux so the orchestrator can surface a clear message
 * rather than silently writing a file no client will read.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { atomicWriteJSON, timestampedBackup } from './atomic-write.js';

export const AFFILIATE_ENTRY_KEY = 'affiliate';
export const AFFILIATE_ENTRY_VALUE = {
  command: 'npx',
  args: ['affiliate-networks-mcp'],
} as const;

/** A Claude Desktop MCP server entry: a command plus its argument vector. */
export interface AffiliateEntryValue {
  command: string;
  args: string[];
}

/**
 * Build the `mcpServers.affiliate` entry value.
 *
 * When both `nodePath` and `serverPath` are supplied (the desktop app's
 * bundled-runtime case, D9), the entry spawns that exact Node binary against
 * that exact server entrypoint — no reliance on a globally-installed `npx`.
 * Otherwise it falls back to the `npx affiliate-networks-mcp` default, byte-for-byte
 * identical to `AFFILIATE_ENTRY_VALUE`, preserving back-compat for the CLI installer.
 */
export function buildAffiliateEntryValue(opts: {
  nodePath?: string;
  serverPath?: string;
} = {}): AffiliateEntryValue {
  const { nodePath, serverPath } = opts;
  if (nodePath && serverPath) {
    return { command: nodePath, args: [serverPath] };
  }
  return { command: AFFILIATE_ENTRY_VALUE.command, args: [...AFFILIATE_ENTRY_VALUE.args] };
}

export type DesktopAction =
  | 'created'
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'removed'
  | 'absent'
  | 'would-create'
  | 'would-add'
  | 'would-update'
  | 'would-remove';

export interface DesktopEditResult {
  path: string;
  action: DesktopAction;
  backupPath?: string;
}

/**
 * Resolve the Claude Desktop MCP config path for the current platform.
 * Returns `null` on platforms where Claude Desktop is not supported.
 */
export function resolveDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (!appData || appData.trim() === '') return null;
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

export interface AddOptions {
  configPath: string;
  dryRun?: boolean;
  forceOverwrite?: boolean;
  /**
   * Called when an existing `affiliate` entry differs from what we'd write.
   * Returning `true` overwrites; `false` leaves the file alone (action stays
   * 'unchanged'). When omitted, the existing entry is overwritten — the
   * orchestrator is expected to prompt the user up front when interactive.
   */
  onConflict?: () => Promise<boolean>;
  /**
   * The entry value to write under `mcpServers.affiliate`. Defaults to
   * `AFFILIATE_ENTRY_VALUE` (the `npx affiliate-networks-mcp` default) when
   * omitted, so existing callers and tests are unaffected. The desktop app
   * passes a bundled-runtime value here (see `buildAffiliateEntryValue`, D9).
   */
  entryValue?: AffiliateEntryValue;
  /** Injected for tests. */
  now?: () => Date;
}

export async function addAffiliateEntry(opts: AddOptions): Promise<DesktopEditResult> {
  const {
    configPath,
    dryRun = false,
    forceOverwrite = false,
    entryValue = AFFILIATE_ENTRY_VALUE,
    now = () => new Date(),
  } = opts;

  const fileExists = existsSync(configPath);

  if (!fileExists) {
    if (dryRun) {
      return { path: configPath, action: 'would-create' };
    }
    mkdirSync(path.dirname(configPath), { recursive: true });
    const fresh = { mcpServers: { [AFFILIATE_ENTRY_KEY]: entryValue } };
    atomicWriteJSON(configPath, fresh);
    return { path: configPath, action: 'created' };
  }

  const rawText = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = rawText.trim() === '' ? {} : JSON.parse(rawText);
  } catch (err) {
    if (!forceOverwrite) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MalformedDesktopConfigError(configPath, reason);
    }
    if (dryRun) {
      return { path: configPath, action: 'would-update' };
    }
    const backupPath = timestampedBackup(configPath, now());
    const fresh = { mcpServers: { [AFFILIATE_ENTRY_KEY]: entryValue } };
    atomicWriteJSON(configPath, fresh);
    return { path: configPath, action: 'updated', backupPath };
  }

  const root = isObject(parsed) ? { ...parsed } : {};
  const servers: Record<string, unknown> = isObject(root['mcpServers'])
    ? { ...(root['mcpServers'] as Record<string, unknown>) }
    : {};

  const existingEntry = servers[AFFILIATE_ENTRY_KEY];
  const desired = entryValue;

  if (existingEntry !== undefined) {
    if (entriesMatch(existingEntry, desired)) {
      return { path: configPath, action: 'unchanged' };
    }
    if (opts.onConflict) {
      const overwrite = await opts.onConflict();
      if (!overwrite) {
        return { path: configPath, action: 'unchanged' };
      }
    }
    if (dryRun) {
      return { path: configPath, action: 'would-update' };
    }
    const backupPath = timestampedBackup(configPath, now());
    servers[AFFILIATE_ENTRY_KEY] = desired;
    root['mcpServers'] = servers;
    atomicWriteJSON(configPath, root);
    return { path: configPath, action: 'updated', backupPath };
  }

  // Fresh add.
  if (dryRun) {
    return { path: configPath, action: 'would-add' };
  }
  const backupPath = timestampedBackup(configPath, now());
  servers[AFFILIATE_ENTRY_KEY] = desired;
  root['mcpServers'] = servers;
  atomicWriteJSON(configPath, root);
  return { path: configPath, action: 'added', backupPath };
}

export interface RemoveOptions {
  configPath: string;
  dryRun?: boolean;
  now?: () => Date;
}

export async function removeAffiliateEntry(opts: RemoveOptions): Promise<DesktopEditResult> {
  const { configPath, dryRun = false, now = () => new Date() } = opts;

  if (!existsSync(configPath)) {
    return { path: configPath, action: 'absent' };
  }

  const rawText = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = rawText.trim() === '' ? {} : JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MalformedDesktopConfigError(configPath, reason);
  }

  if (!isObject(parsed) || !isObject(parsed['mcpServers'])) {
    return { path: configPath, action: 'absent' };
  }
  const servers = parsed['mcpServers'] as Record<string, unknown>;
  if (!(AFFILIATE_ENTRY_KEY in servers)) {
    return { path: configPath, action: 'absent' };
  }

  if (dryRun) {
    return { path: configPath, action: 'would-remove' };
  }
  const backupPath = timestampedBackup(configPath, now());
  const nextServers = { ...servers };
  delete nextServers[AFFILIATE_ENTRY_KEY];
  const nextRoot = { ...parsed, mcpServers: nextServers };
  atomicWriteJSON(configPath, nextRoot);
  return { path: configPath, action: 'removed', backupPath };
}

export class MalformedDesktopConfigError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly reason: string,
  ) {
    super(
      `Claude Desktop config at ${configPath} is not valid JSON: ${reason}. ` +
        'Fix the file by hand, or re-run with --force-overwrite (which backs up the file first).',
    );
    this.name = 'MalformedDesktopConfigError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entriesMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
