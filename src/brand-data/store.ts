/**
 * Brand Data Layer — the local store (source of truth).
 *
 * Lives under `$AFFILIATE_MCP_CONFIG_DIR/brand-data/<slug>/` (default base
 * `~/.affiliate-mcp`), one directory per logical brand slug:
 *   - `snapshot.json`   the latest computed `BrandSnapshot`;
 *   - `rows-30d.jsonl`  the full (or aggregated) 30-day rows, one JSON per line;
 *   - `history.jsonl`   compact per-pull headlines, appended over time.
 *
 * Conventions mirror `src/shared/brands.ts` and `client-strategy.ts`: read
 * fresh on each call, atomic temp+rename writes at mode 0600 (dirs 0700), a
 * missing file is the empty/absent state (never an error), and only an
 * unreadable file throws. The Claude artifact caches a snapshot for render; this
 * store, not the artifact, is the source of truth.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { isValidBrandSlug } from '../shared/brands.js';
import type { BrandSnapshot } from './model.js';
import type { RowsCapResult } from './rows-cap.js';
import type { HistoryEntry } from './snapshot.js';

const SNAPSHOT_FILE = 'snapshot.json';
const ROWS_FILE = 'rows-30d.jsonl';
const HISTORY_FILE = 'history.jsonl';

function resolveConfigDir(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  return override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
}

function ensureValidSlug(slug: string): void {
  if (!isValidBrandSlug(slug)) {
    throw new Error(
      `Brand slug "${slug}" is invalid. Use lowercase letters, digits, and hyphens only.`,
    );
  }
}

/** `$CONFIG_DIR/brand-data/<slug>`. */
export function resolveBrandDataDir(slug: string): string {
  ensureValidSlug(slug);
  return path.join(resolveConfigDir(), 'brand-data', slug);
}

/** Atomic write at mode 0600, creating the brand dir at 0700 if needed. */
function writeAtomic(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

/** Write `snapshot.json` for a brand. */
export function saveSnapshot(slug: string, snapshot: BrandSnapshot): void {
  writeAtomic(path.join(resolveBrandDataDir(slug), SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + '\n');
}

/** Load `snapshot.json`. Returns `null` when absent; throws if unreadable. */
export function loadSnapshot(slug: string): BrandSnapshot | null {
  const file = path.join(resolveBrandDataDir(slug), SNAPSHOT_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as BrandSnapshot;
}

/** Write `rows-30d.jsonl` (one row per line), replacing any prior file. */
export function saveRows(slug: string, rows: RowsCapResult): void {
  const lines = rows.rows.map((r) => JSON.stringify(r)).join('\n');
  writeAtomic(
    path.join(resolveBrandDataDir(slug), ROWS_FILE),
    lines.length > 0 ? lines + '\n' : '',
  );
}

/** Read `rows-30d.jsonl` back into objects. Returns `[]` when absent. */
export function loadRows(slug: string): unknown[] {
  const file = path.join(resolveBrandDataDir(slug), ROWS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Write a CSV export of the persisted rows to
 * `$CONFIG_DIR/brand-data/<slug>/exports/rows-30d.csv` and return its path and
 * byte size. The filename is stable and each export overwrites the previous
 * one atomically, so exports never accumulate unbounded; an operator who wants
 * to keep a copy moves or renames the file. Mode 0600 like the rest of the
 * store (decision 2026-07-03: the file stays on the user's machine).
 */
export function writeRowsExport(slug: string, csv: string): { path: string; bytes: number } {
  const file = path.join(resolveBrandDataDir(slug), 'exports', 'rows-30d.csv');
  writeAtomic(file, csv);
  return { path: file, bytes: Buffer.byteLength(csv, 'utf8') };
}

/** Append one headline to `history.jsonl`. Creates the dir/file if needed. */
export function appendHistory(slug: string, entry: HistoryEntry): void {
  const dir = resolveBrandDataDir(slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/** Read `history.jsonl` back into entries, oldest first. Returns `[]` when absent. */
export function loadHistory(slug: string): HistoryEntry[] {
  const file = path.join(resolveBrandDataDir(slug), HISTORY_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as HistoryEntry);
}

/** Persist a full snapshot result: snapshot, rows, and an appended headline. */
export function persistSnapshotResult(
  slug: string,
  result: { snapshot: BrandSnapshot; rows: RowsCapResult; history: HistoryEntry },
): void {
  saveSnapshot(slug, result.snapshot);
  saveRows(slug, result.rows);
  appendHistory(slug, result.history);
}
