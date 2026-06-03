/**
 * Safe updater for Codex MCP configuration.
 *
 * Codex reads local stdio MCP servers from `~/.codex/config.toml`. We only need
 * to manage one table, `[mcp_servers.affiliate]`, so this module deliberately
 * avoids a TOML dependency and edits that table as text. Unrelated config is
 * preserved byte-for-byte outside the managed block.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { timestampedBackup } from './atomic-write.js';

export const CODEX_CONFIG_RELATIVE_PATH = '.codex/config.toml';
export const CODEX_AFFILIATE_TABLE = '[mcp_servers.affiliate]';
export const CODEX_AFFILIATE_BLOCK = `${CODEX_AFFILIATE_TABLE}
command = "npx"
args = ["-y", "affiliate-networks-mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"`;

export type CodexAction =
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

export interface CodexEditResult {
  path: string;
  action: CodexAction;
  backupPath?: string;
}

export interface CodexEditOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  now?: () => Date;
}

export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir();
  return path.join(home, CODEX_CONFIG_RELATIVE_PATH);
}

export async function addAffiliateCodexEntry(
  opts: CodexEditOptions = {},
): Promise<CodexEditResult> {
  const configPath = opts.configPath ?? resolveCodexConfigPath(opts.env);
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? (() => new Date());

  if (!existsSync(configPath)) {
    if (dryRun) return { path: configPath, action: 'would-create' };
    mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteText(configPath, `${CODEX_AFFILIATE_BLOCK}\n`);
    return { path: configPath, action: 'created' };
  }

  const original = readFileSync(configPath, 'utf8');
  const { text: next, found } = upsertAffiliateBlock(original);
  if (next === original) {
    return { path: configPath, action: 'unchanged' };
  }

  if (dryRun) return { path: configPath, action: found ? 'would-update' : 'would-add' };
  const backupPath = timestampedBackup(configPath, now());
  atomicWriteText(configPath, next);
  return { path: configPath, action: found ? 'updated' : 'added', backupPath };
}

export async function removeAffiliateCodexEntry(
  opts: CodexEditOptions = {},
): Promise<CodexEditResult> {
  const configPath = opts.configPath ?? resolveCodexConfigPath(opts.env);
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? (() => new Date());

  if (!existsSync(configPath)) return { path: configPath, action: 'absent' };

  const original = readFileSync(configPath, 'utf8');
  const { text: next, found } = removeAffiliateBlocks(original);
  if (!found) return { path: configPath, action: 'absent' };

  if (dryRun) return { path: configPath, action: 'would-remove' };
  const backupPath = timestampedBackup(configPath, now());
  atomicWriteText(configPath, next);
  return { path: configPath, action: 'removed', backupPath };
}

function upsertAffiliateBlock(original: string): { text: string; found: boolean } {
  const ranges = findAffiliateBlockRanges(original);
  const normalisedBlock = `${CODEX_AFFILIATE_BLOCK}\n`;
  if (ranges.length === 0) {
    const separator = original.length === 0 || original.endsWith('\n') ? '' : '\n';
    const spacer = original.trim() === '' ? '' : '\n';
    return { text: `${original}${separator}${spacer}${normalisedBlock}`, found: false };
  }

  const firstRange = ranges[0];
  if (!firstRange) return { text: original, found: false };

  let next = original.slice(0, firstRange.start);
  next += normalisedBlock;
  next += original.slice(firstRange.end);

  // Remove any pre-existing duplicate affiliate blocks. The installer should
  // never create duplicates, but cleaning them up here keeps future runs stable.
  const duplicateRanges = findAffiliateBlockRanges(next).slice(1).reverse();
  for (const range of duplicateRanges) {
    next = `${next.slice(0, range.start)}${next.slice(range.end)}`;
  }
  return { text: next, found: true };
}

function removeAffiliateBlocks(original: string): { text: string; found: boolean } {
  const ranges = findAffiliateBlockRanges(original).reverse();
  if (ranges.length === 0) return { text: original, found: false };
  let next = original;
  for (const range of ranges) {
    next = `${next.slice(0, range.start)}${next.slice(range.end)}`;
  }
  return { text: next, found: true };
}

function findAffiliateBlockRanges(text: string): Array<{ start: number; end: number }> {
  const lines = text.match(/^.*(?:\n|$)/gm) ?? [];
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let activeStart: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isTomlTableHeader(trimmed)) {
      if (activeStart !== null) {
        ranges.push({ start: activeStart, end: offset });
        activeStart = null;
      }
      if (trimmed === CODEX_AFFILIATE_TABLE) {
        activeStart = offset;
      }
    }
    offset += line.length;
  }

  if (activeStart !== null) {
    ranges.push({ start: activeStart, end: text.length });
  }
  return ranges;
}

function isTomlTableHeader(trimmedLine: string): boolean {
  return /^(\[[^\]]+\]|\[\[[^\]]+\]\])$/.test(trimmedLine);
}

function atomicWriteText(targetPath: string, body: string): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `${base}.tmp.${process.pid}`);
  writeFileSync(tmp, body, { encoding: 'utf8' });
  renameSync(tmp, targetPath);
}
