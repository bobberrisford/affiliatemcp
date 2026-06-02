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

import type { AdapterOperation } from '../shared/types.js';
import { assertAuthorised, type ActionClass } from '../shared/consent.js';
import { actionFingerprint, issueConfirmation, redeemConfirmation } from './confirmation.js';
import { createLogger } from '../shared/logging.js';

const log = createLogger('consent-gate');

/**
 * Maps mutating adapter operations to a coarse consent action class. An
 * operation absent from this map is treated as a read and is never gated.
 *
 * Only `generateTrackingLink` is wired today, as the worked example. It is the
 * single quasi-write the adapters implement. (See the open question below: it
 * is arguably idempotent and low-risk, so it may not be the right long-term
 * gated path — a genuinely mutating op like an application or a commission
 * change is.)
 */
export const OPERATION_ACTION_CLASS: Partial<Record<AdapterOperation, ActionClass>> = {
  generateTrackingLink: 'link.generate',
};

/**
 * Subject for publisher-side actions. The publisher addresses their own single
 * account from env credentials, so there is no client brand to key consent on;
 * `self` is the reserved subject for "the operator's own account".
 */
export const SELF_SUBJECT = 'self';

/** True if an operation is a gated action (vs a read that passes straight through). */
export function isGatedOperation(operation: AdapterOperation): boolean {
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

export type GateOutcome =
  | { allow: true }
  | { allow: false; result: ConfirmationRequired | ActionDenied };

export interface GateInput {
  operation: AdapterOperation;
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

  const evaluation = assertAuthorised({
    brand: input.subject,
    network: input.network,
    actionClass,
    magnitude: input.magnitude,
    usedToday: input.usedToday,
  });

  if (evaluation.decision === 'proceed') {
    log.info(
      { network: input.network, operation: input.operation, subject: input.subject, actionClass },
      'consent: proceed',
    );
    return { allow: true };
  }

  if (evaluation.decision === 'deny') {
    log.warn(
      { network: input.network, operation: input.operation, subject: input.subject, actionClass },
      'consent: denied',
    );
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
      log.info(
        { network: input.network, operation: input.operation, subject: input.subject, actionClass },
        'consent: confirmed via token',
      );
      return { allow: true };
    }
    // Bad token: issue a fresh one and say why the old one failed.
    const reissue = issueConfirmation(fingerprint);
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
