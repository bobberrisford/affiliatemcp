/**
 * Read / merge / write the wizard's .env file.
 *
 * Behaviour:
 *   - Reads existing entries via the shared `parseEnvFile` parser (single
 *     source of truth on syntax).
 *   - Merges new entries on top, preserving any unrelated entries (used by
 *     the "add network" flow so we don't clobber the user's existing
 *     networks).
 *   - Writes back as a sorted, commented block, with file mode 0600.
 *
 * We deliberately do NOT preserve comments or ordering from the user's
 * existing file. The wizard owns the file; if a user has heavily customised
 * it by hand they'd be editing it by hand from now on anyway.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { parseEnvFile } from '../../shared/config.js';

export function readEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, 'utf8');
  return parseEnvFile(text);
}

export function mergeEnv(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  return { ...existing, ...incoming };
}

export function writeEnv(filePath: string, entries: Record<string, string>): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = Object.keys(entries).sort();
  const lines: string[] = [
    '# affiliate-mcp configuration — managed by the setup wizard.',
    '# Hand-edits are preserved as long as KEY=value formatting is kept.',
    '',
  ];
  for (const k of keys) {
    const v = entries[k] ?? '';
    // Quote if value contains whitespace or '#'.
    const needsQuote = /[\s#]/.test(v) || v === '';
    const out = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
    lines.push(`${k}=${out}`);
  }
  lines.push('');
  writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
  // Belt-and-braces — some platforms ignore the mode on writeFileSync if the
  // file already exists.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort; chmod can fail on filesystems that don't support modes
    // (e.g. some Windows mounts). The wizard surface still works.
  }
}

/**
 * Filter env-vars to those belonging to a given network. Used by the
 * "reset" path so we drop only the affected entries.
 */
export function filterOutKeys(
  existing: Record<string, string>,
  keysToRemove: string[],
): Record<string, string> {
  const set = new Set(keysToRemove);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!set.has(k)) out[k] = v;
  }
  return out;
}
