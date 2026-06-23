/**
 * Action audit — a structured, redacted audit trail for the DOING surface.
 *
 * Fixes the audit event VOCABULARY once, before its two consumers exist, so
 * they cannot diverge. Referenced by the accepted decisions:
 *  - docs/decisions/2026-06-12-impact-contracts-actions.md — every write
 *    attempt emits a structured audit line (brand, programme, before/after,
 *    tier, and an outcome that preserves uncertainty).
 *  - docs/decisions/2026-06-12-browser-handoff-contract.md — a distinct
 *    `handoff_emitted` event, and NEVER `succeeded` for a handoff (success is
 *    only ever claimed for an outcome the server itself observed).
 *
 * Events are emitted via a dedicated audit logger to stderr and key-redacted
 * by the logger. Stderr is a local structured audit line, not durable or
 * append-only storage. Audit is LOCAL-FIRST: it records the
 * operator's own actions on their own machine, so it MAY carry brand /
 * programme / contract identifiers — unlike telemetry (PRIVACY.md), which is
 * aggregate-only and never carries identifiers. It never carries credential
 * values; the logger redacts any key matching token/secret/key/password.
 *
 * DELIBERATELY NOT built here: persistent storage, retention, and per-day
 * consent caps. Those remain the action-authority Phase-1 open questions
 * (docs/decisions/2026-06-12-action-authority-layer.md). A future persistent
 * store can sit behind `recordActionAudit` without changing any caller.
 */

import { createLogger } from './logging.js';

const auditLog = createLogger('audit');

/**
 * The fixed audit event vocabulary.
 *
 * There is deliberately no generic `succeeded` or ambiguous `apply_failed`:
 * - `write_denied` means a local gate stopped dispatch;
 * - `write_dispatched` means the request left the local pre-dispatch boundary;
 * - `write_rejected` means rejection before mutation was confirmed;
 * - `write_unknown` means dispatch may have mutated state and needs a re-read;
 * - `write_verified` means the server re-read and observed the intended state;
 * - `handoff_emitted` claims only that a handoff was produced and shown;
 * - `verified` means a previously emitted handoff was confirmed by revisiting
 *   its verify target and finding the expected state present;
 * - `verify_failed` means the verify target was revisited and the expected
 *   state was not present.
 *
 * `verified` and `verify_failed` are the consumer's report-back closing the
 * handoff arc `handoff_emitted -> verified | verify_failed`
 * (docs/decisions/2026-06-12-browser-handoff-contract.md, decision 2). They do
 * not relax the rule that `succeeded` is never recorded for a handoff: a
 * handoff is only ever closed by an outcome a consumer actually observed at the
 * verify target, recorded as `verified` or `verify_failed`.
 */
export const ACTION_AUDIT_EVENTS = [
  'proposed',
  'dry_run',
  'write_denied',
  'write_dispatched',
  'write_rejected',
  'write_unknown',
  'write_verified',
  'handoff_emitted',
  'verified',
  'verify_failed',
] as const;

export type ActionAuditEvent = (typeof ACTION_AUDIT_EVENTS)[number];

export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

export interface ActionAuditEntry {
  event: ActionAuditEvent;
  /** Stable action identifier, e.g. "impact-advertiser.proposeContract". */
  action: string;
  network: string;
  /** Operator's logical brand slug (local-first context, not a secret). */
  brand?: string;
  programmeId?: string;
  contractId?: string;
  /** Default/effective authority tier that governed this event. */
  authorityTier?: 0 | 1 | 2 | 3;
  /**
   * Which credential tier authorised a write. Named to avoid the logger's
   * token-redaction (a key containing "token" would be redacted), since the
   * tier itself is not a secret.
   */
  credentialTier?: 'read-only' | 'write';
  /** Short, human-readable summary of what was proposed, sent, or emitted. */
  summary?: string;
  /**
   * The plan/apply pinning hash (a sha256 digest, NOT a secret). Named
   * `planHash` rather than `confirmationToken` so the logger does not redact it,
   * keeping plan -> apply correlation auditable.
   */
  planHash?: string;
  /** Normalised snapshots only. Never pass raw network payloads or credentials. */
  beforeState?: AuditJsonValue;
  intendedAfterState?: AuditJsonValue;
  /** Structured failure evidence; raw upstream bodies stay in the error envelope. */
  errorType?: string;
  httpStatus?: number;
  /** Bounded reason code, not a free-form upstream response or credential-bearing message. */
  reasonCode?: string;
  /**
   * ISO-8601 instant the event occurred. Optional, and never a secret. Carried
   * so a read-back can attribute an entry to a calendar day, which the per-day
   * consent-cap basis needs (see `countMutatingHandoffsOn`). The logger stamps
   * its own emission time; this is the entry's own record for later reads.
   */
  occurredAt?: string;
}

/** The structured shape handed to the logger. Pure; exposed for testing. */
export function toAuditLine(entry: ActionAuditEntry): { msg: string; audit: ActionAuditEntry } {
  return { msg: `action_audit:${entry.event}`, audit: entry };
}

/**
 * Record one audit event via the dedicated audit logger (stderr). Logging
 * failures are allowed to surface: a caller must not report an audited action
 * as successful when the required audit line was not accepted by the sink.
 */
export function recordActionAudit(entry: ActionAuditEntry): void {
  const line = toAuditLine(entry);
  auditLog.info({ audit: line.audit }, line.msg);
}

/**
 * True when an audit entry represents a mutating handoff: a `handoff_emitted`
 * event whose handoff intended to change state. There is deliberately no
 * `mutates` flag on the entry; the minimal existing signal is the presence of
 * an `intendedAfterState`, which a mutating handoff records and a read-only
 * one (an API gap exposing data only) does not.
 */
function isMutatingHandoff(entry: ActionAuditEntry): boolean {
  return entry.event === 'handoff_emitted' && entry.intendedAfterState !== undefined;
}

/**
 * Count the mutating `handoff_emitted` entries that occurred on a given
 * calendar day, the basis for the per-day consent cap
 * (docs/decisions/2026-06-12-browser-handoff-contract.md, decision 2: a
 * mutating handoff consumes the day's allowance, the conservative basis a
 * handoff that may have mutated state must use).
 *
 * Pure and deterministic: the day is supplied as an ISO date (`YYYY-MM-DD`),
 * never read from the clock. An entry is on that day when its `occurredAt`
 * instant falls on it (compared by the leading `YYYY-MM-DD` of the ISO string).
 * Entries with no `occurredAt`, non-mutating handoffs, and any other event are
 * not counted. This counts the basis only; it does not enforce any cap.
 */
export function countMutatingHandoffsOn(entries: ActionAuditEntry[], isoDate: string): number {
  return entries.filter(
    (entry) =>
      isMutatingHandoff(entry) &&
      typeof entry.occurredAt === 'string' &&
      entry.occurredAt.slice(0, 10) === isoDate,
  ).length;
}
