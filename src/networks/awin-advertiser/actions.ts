/**
 * Awin advertiser publisher-decision EMITTERS — pure, side-effect-free.
 *
 * Awin's advertiser API has no public endpoint to approve or decline a pending
 * publisher application, so the operation is an API gap. Rather than throw, the
 * adapter returns an `ApiGapResponse` carrying a typed `BrowserHandoff` per the
 * accepted browser-handoff contract
 * (docs/decisions/2026-06-12-browser-handoff-contract.md): a human, or a future
 * out-of-scope consumer, carries out the handoff against the operator's own
 * authenticated Awin session.
 *
 * These functions are PURE. They build a plan; they never call `fetch`, the
 * `awin-advertiser` client, `auth.ts`, or `withResilience`, and they touch no
 * session, cookie, or DOM. The mutation risk lives entirely in the consumer
 * that carries out the handoff, never in this repo. The starting URL is a
 * fixed Awin-owned host/path TEMPLATE defined here; the only interpolated value
 * is the resolved advertiser account id, which the adapter selects from the
 * brand binding (it is NOT free caller input). A hostile caller cannot redirect
 * the operator to an arbitrary origin or path.
 *
 * Cardinal rules honoured:
 *   1. NEVER call fetch. These emitters call nothing.
 *   2. An API gap is an expected, documented condition — it returns an
 *      `ApiGapResponse`, never a `NetworkErrorEnvelope`.
 *   3. No secrets (token, cookie, session) ever reach the handoff `inputs`.
 *   4. UK English in user-visible strings.
 */

import { composeConstraints } from '../../shared/browser-handoff.js';
import { SLUG } from './auth.js';
import type {
  ActionDescriptor,
  ApiGapResponse,
  BrowserHandoff,
} from '../../shared/types.js';

/**
 * The Awin advertiser partnerships page, where the "Pending partners" section
 * carries the approve/decline controls. Verified against the new Awin UI
 * (`app.awin.com`). The host and path are a fixed Awin-owned template; only the
 * resolved advertiser account id is interpolated, and that id is adapter-
 * selected from the brand binding, not free caller input. A hostile caller can
 * therefore never redirect the operator off this origin/path.
 *
 * Note: this flow targets the NEW Awin UI only. Legacy "Awin Classic"
 * (`ui.awin.com`) accounts are not supported; the per-action constraints tell
 * the consumer to stop if navigation redirects there.
 */
function awinPartnershipsUrl(advertiserId: string): string {
  return `https://app.awin.com/en/awin/advertiser/${advertiserId}/partnerships/all`;
}

/** Caller-supplied, non-secret inputs for a publisher-decision handoff. */
export interface PublisherDecisionInput {
  /** Operator's logical brand slug; echoed for display, never a network id. */
  brand: string;
  /**
   * The resolved Awin advertiser account id (= networkBrandId). Selected by the
   * adapter from the brand binding, never free caller input; it scopes the
   * partnerships page the handoff points at.
   */
  advertiserId: string;
  /** The Awin programme (advertiser) the publisher applied to. */
  programmeId: string;
  /** The publisher (media partner) the decision targets. */
  publisherId: string;
  /** The publisher's display name, for an unambiguous handoff goal. */
  publisherName: string;
  /** Optional reason recorded with a decline. */
  declineReason?: string;
}

type PublisherDecision = 'approve' | 'decline';

/**
 * Build the shared `BrowserHandoff` for a publisher approve/decline. The
 * `startingUrl` and `verify.url` are always the partnerships-page template
 * scoped to the resolved `advertiserId`; the per-action constraints are appended
 * to the shared floor via `composeConstraints`, which the consumer must honour
 * and cannot weaken.
 */
function buildPublisherDecisionHandoff(
  input: PublisherDecisionInput,
  decision: PublisherDecision,
): BrowserHandoff {
  const verb = decision === 'approve' ? 'Approve' : 'Decline';
  const startingUrl = awinPartnershipsUrl(input.advertiserId);
  const inputs: Record<string, unknown> = {
    publisherId: input.publisherId,
    publisherName: input.publisherName,
    decision,
    brand: input.brand,
    programmeId: input.programmeId,
  };
  if (decision === 'decline' && input.declineReason !== undefined) {
    inputs['declineReason'] = input.declineReason;
  }
  // Per-action constraints, composed on top of the shared floor. The first five
  // apply to both decisions; the decline-reason rule is decline-only. Both were
  // confirmed against a live click-test of the new Awin partnerships UI.
  const perAction = [
    'This flow only works on the new Awin UI (app.awin.com). If navigation redirects to ui.awin.com (Awin Classic), stop — this account is not supported.',
    `Operate only on publisher ${input.publisherId}; do not approve or decline any other applicant.`,
    'If the publisher row is not in a pending state, stop — it may already be decided.',
    'Do not change commission, payout, or contract terms while recording this decision.',
    'If the dashboard requires setting terms as part of approval, stop and hand back to the user.',
    'Before acting, make sure the target advertiser account is the active account in the Awin UI; deep-linking the partnerships URL by advertiser id alone does not switch accounts and may redirect.',
  ];
  if (decision === 'decline') {
    perAction.push(
      "The decline flow requires selecting a reason from Awin's fixed list (it is not free text); choose the listed option that best matches the decline rationale, for example 'Website doesn't align with our brand or audience'. Do not invent a reason.",
    );
  }
  return {
    goal: `${verb} publisher ${input.publisherName} (id ${input.publisherId}) on the Awin programme for brand ${input.brand}.`,
    startingUrl,
    inputs,
    constraints: composeConstraints(perAction),
    mutates: true,
    verify: {
      url: startingUrl,
      expect: `publisher ${input.publisherId} no longer appears under Pending partners on the partnerships page.`,
    },
  };
}

/**
 * Emit the API-gap response for approving a pending Awin publisher. Pure: builds
 * and returns a plan, performs no network call.
 */
export function buildApprovePublisherHandoff(input: PublisherDecisionInput): ApiGapResponse {
  return {
    kind: 'api-gap',
    network: SLUG,
    operation: 'approvePublisher',
    reason: 'Awin has no public publisher approve/decline endpoint',
    userMessage:
      `Awin's advertiser API cannot approve a publisher application, so this prepares a guided ` +
      `browser handoff to approve ${input.publisherName} (id ${input.publisherId}) in the Awin ` +
      `dashboard. Review it before carrying it out; the approval is a state change.`,
    browserFallback: buildPublisherDecisionHandoff(input, 'approve'),
  };
}

/**
 * Emit the API-gap response for declining a pending Awin publisher. Pure: builds
 * and returns a plan, performs no network call.
 */
export function buildDeclinePublisherHandoff(input: PublisherDecisionInput): ApiGapResponse {
  return {
    kind: 'api-gap',
    network: SLUG,
    operation: 'declinePublisher',
    reason: 'Awin has no public publisher approve/decline endpoint',
    userMessage:
      `Awin's advertiser API cannot decline a publisher application, so this prepares a guided ` +
      `browser handoff to decline ${input.publisherName} (id ${input.publisherId}) in the Awin ` +
      `dashboard. Review it before carrying it out; the decline is a state change.`,
    browserFallback: buildPublisherDecisionHandoff(input, 'decline'),
  };
}

// ---------------------------------------------------------------------------
// Action capability map — the two browser/write actions this adapter declares.
// See docs/decisions/2026-06-18-action-capability-map.md. Network-scoped ids,
// owned beside the emitters that implement them. Both are channel 'browser',
// effect 'write', and default authority tier 3 (write fail-closed).
// ---------------------------------------------------------------------------

export const awinAdvertiserActionDescriptors: ActionDescriptor[] = [
  {
    id: 'awin-advertiser.approvePublisher',
    network: SLUG,
    channel: 'browser',
    effect: 'write',
    defaultAuthorityTier: 3,
    description:
      'Approve a pending publisher application on an Awin programme. Awin exposes no public ' +
      'approve/decline endpoint, so this emits a typed browser handoff for a human (or a future ' +
      'consumer) to carry out against the operator\'s own Awin session. The emitter performs no ' +
      'network write; the mutation risk lives in the consumer that carries out the handoff.',
    credentialRequirements: [{ label: 'AWIN_ADVERTISER_API_TOKEN' }],
  },
  {
    id: 'awin-advertiser.declinePublisher',
    network: SLUG,
    channel: 'browser',
    effect: 'write',
    defaultAuthorityTier: 3,
    description:
      'Decline a pending publisher application on an Awin programme. Awin exposes no public ' +
      'approve/decline endpoint, so this emits a typed browser handoff for a human (or a future ' +
      'consumer) to carry out against the operator\'s own Awin session. The emitter performs no ' +
      'network write; the mutation risk lives in the consumer that carries out the handoff.',
    credentialRequirements: [{ label: 'AWIN_ADVERTISER_API_TOKEN' }],
  },
];

/**
 * Exposed for tests: the partnerships-URL builder. The host/path are a fixed
 * Awin-owned template; only the adapter-selected advertiserId is interpolated.
 */
export const _internals = { awinPartnershipsUrl };
