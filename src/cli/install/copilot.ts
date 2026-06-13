/**
 * Safe-edit for GitHub Copilot's MCP config file in VS Code.
 *
 * VS Code's Copilot agent mode reads local stdio MCP servers from a dedicated
 * `mcp.json` file in the user profile (the file you get from the
 * "MCP: Open User Configuration" command). The top-level shape is
 * `{ "servers": { ... } }`, mirroring Claude Desktop's `mcpServers` but under a
 * different key, so this module follows the same safe-edit contract:
 *
 *   - reads + parses the existing JSON,
 *   - merges our `affiliate` entry into `servers` (never replaces siblings),
 *   - takes a timestamped backup before any write,
 *   - writes atomically via `atomicWriteJSON` (write-tmp → rename),
 *   - skips the write if the existing entry already matches byte-for-byte,
 *   - aborts loudly when the existing JSON is malformed unless the caller
 *     passes `forceOverwrite: true` (which backs up first, then rewrites).
 *
 * Unlike Claude Desktop, VS Code is supported on Linux, so
 * `resolveCopilotConfigPath` returns a path on all three platforms.
 *
 * Note: VS Code treats `mcp.json` as JSONC (comments / trailing commas are
 * legal). We parse it as strict JSON — a freshly-created file is plain JSON, so
 * the common case is fine, but a hand-commented file will hit the malformed-
 * config path and require `--force-overwrite` (which backs up first). We prefer
 * erroring loudly over silently rewriting and dropping the user's comments. The
 * `code --add-mcp '{...}'` CLI is the JSONC-safe manual alternative, but it is
 * add-only (no remove / dry-run), so it can't back the uninstall path.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { atomicWriteJSON, timestampedBackup } from './atomic-write.js';

export const COPILOT_ENTRY_KEY = 'affiliate';
export const COPILOT_ENTRY_VALUE = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'affiliate-networks-mcp'],
} as const;

export type CopilotAction =
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

export interface CopilotEditResult {
  path: string;
  action: CopilotAction;
  backupPath?: string;
}

/**
 * Resolve the VS Code Copilot MCP user-config path for the current platform.
 *
 * This is the `mcp.json` that lives next to VS Code's user `settings.json`,
 * surfaced by the "MCP: Open User Configuration" command. VS Code is supported
 * on every platform, so this always returns a path.
 */
export function resolveCopilotConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCopilotUserDir(platform, env), 'mcp.json');
}

/** The VS Code "User" config directory that holds `settings.json` / `mcp.json`. */
export function resolveCopilotUserDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base = appData && appData.trim() !== '' ? appData : path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Code', 'User');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  // Linux and others: honour XDG_CONFIG_HOME, fall back to ~/.config.
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(home, '.config');
  return path.join(base, 'Code', 'User');
}

export interface CopilotAddOptions {
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
  /** Injected for tests. */
  now?: () => Date;
}

export async function addAffiliateCopilotEntry(opts: CopilotAddOptions): Promise<CopilotEditResult> {
  const { configPath, dryRun = false, forceOverwrite = false, now = () => new Date() } = opts;

  const fileExists = existsSync(configPath);

  if (!fileExists) {
    if (dryRun) {
      return { path: configPath, action: 'would-create' };
    }
    mkdirSync(path.dirname(configPath), { recursive: true });
    const fresh = { servers: { [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE } };
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
      throw new MalformedCopilotConfigError(configPath, reason);
    }
    if (dryRun) {
      return { path: configPath, action: 'would-update' };
    }
    const backupPath = timestampedBackup(configPath, now());
    const fresh = { servers: { [COPILOT_ENTRY_KEY]: COPILOT_ENTRY_VALUE } };
    atomicWriteJSON(configPath, fresh);
    return { path: configPath, action: 'updated', backupPath };
  }

  const root = isObject(parsed) ? { ...parsed } : {};
  const servers: Record<string, unknown> = isObject(root['servers'])
    ? { ...(root['servers'] as Record<string, unknown>) }
    : {};

  const existingEntry = servers[COPILOT_ENTRY_KEY];
  const desired = COPILOT_ENTRY_VALUE;

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
    servers[COPILOT_ENTRY_KEY] = desired;
    root['servers'] = servers;
    atomicWriteJSON(configPath, root);
    return { path: configPath, action: 'updated', backupPath };
  }

  // Fresh add.
  if (dryRun) {
    return { path: configPath, action: 'would-add' };
  }
  const backupPath = timestampedBackup(configPath, now());
  servers[COPILOT_ENTRY_KEY] = desired;
  root['servers'] = servers;
  atomicWriteJSON(configPath, root);
  return { path: configPath, action: 'added', backupPath };
}

export interface CopilotRemoveOptions {
  configPath: string;
  dryRun?: boolean;
  now?: () => Date;
}

export async function removeAffiliateCopilotEntry(
  opts: CopilotRemoveOptions,
): Promise<CopilotEditResult> {
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
    throw new MalformedCopilotConfigError(configPath, reason);
  }

  if (!isObject(parsed) || !isObject(parsed['servers'])) {
    return { path: configPath, action: 'absent' };
  }
  const servers = parsed['servers'] as Record<string, unknown>;
  if (!(COPILOT_ENTRY_KEY in servers)) {
    return { path: configPath, action: 'absent' };
  }

  if (dryRun) {
    return { path: configPath, action: 'would-remove' };
  }
  const backupPath = timestampedBackup(configPath, now());
  const nextServers = { ...servers };
  delete nextServers[COPILOT_ENTRY_KEY];
  const nextRoot = { ...parsed, servers: nextServers };
  atomicWriteJSON(configPath, nextRoot);
  return { path: configPath, action: 'removed', backupPath };
}

export class MalformedCopilotConfigError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly reason: string,
  ) {
    super(
      `GitHub Copilot config at ${configPath} is not valid JSON: ${reason}. ` +
        'Fix the file by hand, or re-run with --force-overwrite (which backs up the file first).',
    );
    this.name = 'MalformedCopilotConfigError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entriesMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
