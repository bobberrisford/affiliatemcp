/**
 * Action audit — a structured, redacted audit trail for the DOING surface.
 *
 * Fixes the audit event VOCABULARY once, before its two consumers exist, so
 * they cannot diverge. Referenced by the accepted decisions:
 *  - docs/decisions/2026-06-12-impact-contracts-actions.md — every successful
 *    write emits a structured audit line (brand, programme, before/after, tier).
 *  - docs/decisions/2026-06-12-browser-handoff-contract.md — a distinct
 *    `handoff_emitted` event, and NEVER `succeeded` for a handoff (success is
 *    only ever claimed for an outcome the server itself observed).
 *
 * Events are emitted via a dedicated audit logger to stderr (append-only by
 * nature, and key-redacted by the logger). Audit is LOCAL-FIRST: it records the
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
 * There is deliberately no generic `succeeded`: per the browser-handoff
 * decision, success is only ever claimed for an outcome the server observed
 * (`applied`), never for a handoff whose downstream mutation the server cannot
 * see. A handoff records only that it was emitted; a future verify step closes
 * the arc with its own events.
 */
export type ActionAuditEvent =
  | 'proposed' // an advisement plan was produced; no network side effect (Tier 1)
  | 'dry_run' // a write was validated and rendered but DELIBERATELY not sent
  | 'applied' // a write the server performed AND observed succeed
  | 'apply_failed' // a write the server attempted and observed fail
  | 'handoff_emitted'; // a browser handoff was produced and shown; outcome unknown to the server

export interface ActionAuditEntry {
  event: ActionAuditEvent;
  /** Stable action identifier, e.g. "impact-advertiser.proposeContract". */
  action: string;
  network: string;
  /** Operator's logical brand slug (local-first context, not a secret). */
  brand?: string;
  programmeId?: string;
  contractId?: string;
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
  /** Free-form detail, e.g. an upstream error message on `apply_failed`. */
  detail?: string;
}

/** The structured shape handed to the logger. Pure; exposed for testing. */
export function toAuditLine(entry: ActionAuditEntry): { msg: string; audit: ActionAuditEntry } {
  return { msg: `action_audit:${entry.event}`, audit: entry };
}

/**
 * Record one audit event via the dedicated audit logger (stderr). Never throws:
 * auditing must not break the operation it describes, so a logging failure is
 * swallowed.
 */
export function recordActionAudit(entry: ActionAuditEntry): void {
  const line = toAuditLine(entry);
  try {
    auditLog.info({ audit: line.audit }, line.msg);
  } catch {
    // Best-effort: never let an audit failure break the action it records.
  }
}
