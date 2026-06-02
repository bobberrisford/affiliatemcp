/**
 * consent-gate.ts — the dispatch-layer authorisation check for action tools.
 *
 * Sits between the MCP tool handler and the adapter invocation. For an
 * operation classified as an action (a write), it consults the consent layer
 * (`src/shared/consent.ts`) and decides whether to run the action, refuse it,
 * or ask the user to confirm first.
 *
 * Design: `docs/product/doing-layer.md`. Two principles shape this file:
 *
 *   - **Reads are never gated.** Only operations listed in
 *     `OPERATION_ACTION_CLASS` are actions; everything else passes straight
 *     through with no consent lookup.
 *   - **Opt-in, default off** (doing-layer.md principle 2). Even a classified
 *     action passes through unless consent enforcement is explicitly enabled
 *     via `AFFILIATE_MCP_ENFORCE_CONSENT`. So wiring this in changes no
 *     existing behaviour until an operator turns it on.
 *
 * A blocked action returns a structured result (never throws) that the calling
 * agent surfaces to the user — the same philosophy as PR #5's `ApiGapResponse`.
 */

import { assertAuthorised, type ActionClass } from '../shared/consent.js';
import { actionFingerprint, issueConfirmation, redeemConfirmation } from './confirmation.js';
import { appendAudit, countAppliedToday } from '../shared/audit.js';
import { createLogger } from '../shared/logging.js';

const log = createLogger('consent-gate');

/**
 * Maps mutating operations to a coarse consent action class. An operation
 * absent from this map is treated as a read and is never gated. Keyed by
 * operation name (a string), so it covers both the canonical adapter operations
 * and off-interface actions such as Impact's `applyToProgram`.
 *
 * `generateTrackingLink` is the single quasi-write among the canonical ops; it
 * is idempotent and low-risk. `applyToProgram` is the first genuinely mutating
 * action (a browser handoff, since Impact exposes no API write endpoint).
 */
export const OPERATION_ACTION_CLASS: Record<string, ActionClass> = {
  generateTrackingLink: 'link.generate',
  applyToProgram: 'programme.apply',
};

/**
 * Subject for publisher-side actions. The publisher addresses their own single
 * account from env credentials, so there is no client brand to key consent on;
 * `self` is the reserved subject for "the operator's own account".
 */
export const SELF_SUBJECT = 'self';

/** True if an operation is a gated action (vs a read that passes straight through). */
export function isGatedOperation(operation: string): boolean {
  return operation in OPERATION_ACTION_CLASS;
}

export interface ConfirmationRequired {
  kind: 'confirmation_required';
  network: string;
  operation: string;
  actionClass: ActionClass;
  subject: string;
  reason: string;
  /** Single-use token the caller passes back as `confirmationToken` to proceed. */
  confirmationToken: string;
  /** ISO expiry after which the token is rejected and a fresh confirmation is needed. */
  expiresAt: string;
  /** A sentence the calling agent shows the user before re-running with confirmation. */
  message: string;
}

export interface ActionDenied {
  kind: 'action_denied';
  network: string;
  operation: string;
  actionClass: ActionClass;
  subject: string;
  reason: string;
}

export interface AuditActionContext {
  network: string;
  operation: string;
  subject: string;
  actionClass: ActionClass;
}

export type GateOutcome =
  | { allow: true; audit?: AuditActionContext }
  | { allow: false; result: ConfirmationRequired | ActionDenied };

export interface GateInput {
  operation: string;
  network: string;
  /** Brand slug for advertiser ops; `SELF_SUBJECT` for publisher ops. */
  subject: string;
  /** The action payload (tool args minus brand/confirmationToken). Bound into the confirmation token. */
  payload?: unknown;
  /** A confirmation token from a prior `confirmation_required`, passed back to proceed. */
  confirmationToken?: string;
  /** Magnitude of this action, checked against a grant's `maxMagnitude` bound. */
  magnitude?: number;
  /** Count of this action class already applied today (from the audit log) for per-day caps. */
  usedToday?: number;
}

/**
 * Whether consent enforcement is active. Off by default: a classified action
 * runs exactly as it does today unless an operator opts in. Read on every call
 * so tests (and operators) can toggle it without a restart.
 */
export function consentEnforcementEnabled(): boolean {
  const v = process.env['AFFILIATE_MCP_ENFORCE_CONSENT'];
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Decide whether an action may run. Returns `{ allow: true }` for reads, for
 * unmapped operations, when enforcement is off, and when consent says proceed.
 * Otherwise returns `{ allow: false, result }` with a structured payload for
 * the caller to surface — a confirmation prompt or an explicit denial.
 */
export function consentGate(input: GateInput): GateOutcome {
  const actionClass = OPERATION_ACTION_CLASS[input.operation];
  if (!actionClass) return { allow: true }; // read or unmapped op
  if (!consentEnforcementEnabled()) return { allow: true }; // opt-in, default off

  const base = {
    network: input.network,
    operation: input.operation,
    subject: input.subject,
    actionClass,
  };

  const evaluation = assertAuthorised({
    brand: input.subject,
    network: input.network,
    actionClass,
    magnitude: input.magnitude,
    // Per-day caps read the running count from the audit log. If the caller
    // supplied one (tests), honour it. If the log is unreadable, fail closed:
    // an unknown count is treated as "cap reached" so a capped grant falls back
    // to a prompt rather than silently proceeding.
    usedToday: input.usedToday ?? appliedTodaySafe(base),
  });

  if (evaluation.decision === 'proceed') {
    log.info(base, 'consent: proceed');
    appendAudit({ event: 'applied', via: 'standing', ...base });
    return { allow: true, audit: base };
  }

  if (evaluation.decision === 'deny') {
    log.warn(base, 'consent: denied');
    appendAudit({ event: 'denied', reason: evaluation.reason, ...base });
    return {
      allow: false,
      result: {
        kind: 'action_denied',
        network: input.network,
        operation: input.operation,
        actionClass,
        subject: input.subject,
        reason: evaluation.reason,
      },
    };
  }

  // decision === 'prompt' — the action needs the user's say-so. Bind a token to
  // this exact action; if the caller already presented a valid one, proceed.
  const fingerprint = actionFingerprint({
    operation: input.operation,
    network: input.network,
    subject: input.subject,
    payload: input.payload,
  });

  if (input.confirmationToken) {
    const redeemed = redeemConfirmation(input.confirmationToken, fingerprint);
    if (redeemed.ok) {
      log.info(base, 'consent: confirmed via token');
      appendAudit({ event: 'applied', via: 'token', ...base });
      return { allow: true, audit: base };
    }
    // Bad token: issue a fresh one and say why the old one failed.
    const reissue = issueConfirmation(fingerprint);
    appendAudit({ event: 'proposed', reason: `token rejected: ${redeemed.reason}`, ...base });
    return {
      allow: false,
      result: {
        kind: 'confirmation_required',
        network: input.network,
        operation: input.operation,
        actionClass,
        subject: input.subject,
        reason: `${evaluation.reason} The token provided was rejected: ${redeemed.reason}.`,
        confirmationToken: reissue.token,
        expiresAt: reissue.expiresAt,
        message:
          `${input.network} ${input.operation} (${actionClass}) still needs confirmation: ${redeemed.reason}. ` +
          `Re-run with confirmationToken "${reissue.token}" to proceed.`,
      },
    };
  }

  const issued = issueConfirmation(fingerprint);
  appendAudit({ event: 'proposed', reason: evaluation.reason, ...base });
  return {
    allow: false,
    result: {
      kind: 'confirmation_required',
      network: input.network,
      operation: input.operation,
      actionClass,
      subject: input.subject,
      reason: evaluation.reason,
      confirmationToken: issued.token,
      expiresAt: issued.expiresAt,
      message:
        `${input.network} ${input.operation} (${actionClass}) needs your confirmation before it runs. ` +
        `${evaluation.reason} Show the user what will happen, then re-run with confirmationToken "${issued.token}" to proceed.`,
    },
  };
}

/**
 * Run a gated action through to execution and record its outcome.
 *
 * - Gate refused (`allow: false`): return the structured result for the agent
 *   to surface; nothing executes, no outcome is recorded.
 * - Gate allowed a read / enforcement-off call (no `audit`): just run it.
 * - Gate authorised an action (`audit` present): run it, then record
 *   `succeeded` or `failed` to the audit log. A thrown error is re-raised after
 *   recording so the server's error-envelope path is unchanged.
 *
 * Completes the plan -> apply -> outcome trail: the gate records `proposed` and
 * `applied`; this records the execution outcome.
 */
export async function dispatchAction(
  gate: GateOutcome,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!gate.allow) return gate.result;
  if (!gate.audit) return run();
  try {
    const out = await run();
    appendAudit({ event: 'succeeded', ...gate.audit });
    return out;
  } catch (err) {
    appendAudit({
      event: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      ...gate.audit,
    });
    throw err;
  }
}

/**
 * Read today's applied-action count from the audit log, failing closed: if the
 * log cannot be read, return a count high enough that any `maxPerDay` bound is
 * treated as reached, so a capped grant degrades to a prompt rather than
 * proceeding on an unknown count.
 */
function appliedTodaySafe(base: {
  network: string;
  subject: string;
  actionClass: string;
}): number {
  try {
    return countAppliedToday({
      subject: base.subject,
      network: base.network,
      actionClass: base.actionClass,
    });
  } catch (err) {
    log.warn({ ...base, err: (err as Error).message }, 'consent: audit log unreadable; failing closed on per-day cap');
    return Number.MAX_SAFE_INTEGER;
  }
}
