/**
 * audit.ts — the append-only audit log for the doing layer.
 *
 * Every consent decision the gate makes is recorded here: a proposal awaiting
 * the user's confirmation, an authorised action, or a refusal. The log is what
 * lets an operator (or a client whose brand was acted on) see what was done on
 * their behalf, and it is the source of the per-day usage counts that back the
 * `maxPerDay` consent bound.
 *
 * Design: `docs/product/doing-layer.md` → "Append-only audit". JSON Lines, one
 * record per line, append-only, local-first at
 * `$AFFILIATE_MCP_CONFIG_DIR/audit.log` (default `~/.affiliate-mcp/audit.log`),
 * mode 0600. Mirrors the file conventions in `src/shared/brands.ts` and
 * `src/shared/consent.ts`.
 *
 * The trail records the full plan -> apply -> outcome arc: `proposed` (a plan
 * awaiting confirmation), `applied` (authorised and dispatched), and the
 * execution outcome `succeeded` / `failed`, plus `denied` for a refusal. The
 * per-day cap counts `applied`, the conservative basis: a dispatched-but-failed
 * action still consumes the day's budget. The gate records `proposed`,
 * `applied`, and `denied`; the dispatch helper records `succeeded` / `failed`.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type AuditEvent = 'proposed' | 'applied' | 'succeeded' | 'failed' | 'denied';

export interface AuditEntry {
  /** ISO timestamp. */
  timestamp: string;
  event: AuditEvent;
  network: string;
  operation: string;
  /** Brand slug, or `self` for the operator's own account. */
  subject: string;
  actionClass: string;
  /** How an `applied` action was authorised. */
  via?: 'standing' | 'token';
  /** Why a `proposed` or `denied` decision was reached. */
  reason?: string;
}

/** Resolve the active audit.log path. Honours `AFFILIATE_MCP_CONFIG_DIR`. */
export function resolveAuditLog(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const dir = override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
  return path.join(dir, 'audit.log');
}

/** Append one record. Stamps `timestamp` when absent. Creates the file at 0600. */
export function appendAudit(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: string }): void {
  const file = resolveAuditLog();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record: AuditEntry = { timestamp: entry.timestamp ?? new Date().toISOString(), ...entry };
  appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

/**
 * Read every record. Returns `[]` when the log is missing. Throws on a
 * malformed line (naming the line number) rather than silently dropping
 * history — a corrupt audit trail is a problem the operator must see.
 */
export function readAudit(): AuditEntry[] {
  const file = resolveAuditLog();
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const out: AuditEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch (err) {
      throw new Error(`audit.log at ${file} line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Count `applied` actions for `(subject, network, actionClass)` on the UTC
 * calendar day of `now`. Backs the `maxPerDay` consent bound. Counts per
 * network: a wildcard grant's cap is therefore enforced per network, which is
 * the simpler and more predictable semantic.
 */
export function countAppliedToday(input: {
  subject: string;
  network: string;
  actionClass: string;
  now?: Date;
}): number {
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  return readAudit().filter(
    (e) =>
      e.event === 'applied' &&
      e.subject === input.subject &&
      e.network === input.network &&
      e.actionClass === input.actionClass &&
      e.timestamp.slice(0, 10) === day,
  ).length;
}
