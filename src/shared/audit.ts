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
 * - `handoff_emitted` claims only that a handoff was produced and shown.
 *
 * A future browser verify step closes the handoff arc with its own events.
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
