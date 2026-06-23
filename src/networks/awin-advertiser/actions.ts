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
 * CONSTANT Awin-owned origin path defined here, never derived from caller
 * input, so a hostile caller cannot redirect the operator to an arbitrary page.
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
 * The Awin advertiser pending-publishers queue. CONSTANT and Awin-owned: it is
 * never derived from caller input, so the handoff can only ever point the
 * operator at this reviewed Awin origin path.
 *
 * TODO(verify): the exact path is unverified against a live Accelerate/Advanced
 * tenant. The origin (`https://ui.awin.com`) is the Awin advertiser UI; confirm
 * the queue path when a live tenant is available.
 */
const AWIN_PENDING_PUBLISHERS_URL = 'https://ui.awin.com/awin/advertiser/publishers/pending';

/** Caller-supplied, non-secret inputs for a publisher-decision handoff. */
export interface PublisherDecisionInput {
  /** Operator's logical brand slug; echoed for display, never a network id. */
  brand: string;
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
 * `startingUrl` and `verify.url` are always the module constant; the per-action
 * constraints are appended to the shared floor via `composeConstraints`, which
 * the consumer must honour and cannot weaken.
 */
function buildPublisherDecisionHandoff(
  input: PublisherDecisionInput,
  decision: PublisherDecision,
): BrowserHandoff {
  const verb = decision === 'approve' ? 'Approve' : 'Decline';
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
  return {
    goal: `${verb} publisher ${input.publisherName} (id ${input.publisherId}) on the Awin programme for brand ${input.brand}.`,
    startingUrl: AWIN_PENDING_PUBLISHERS_URL,
    inputs,
    constraints: composeConstraints([
      `Operate only on publisher ${input.publisherId}; do not approve or decline any other applicant.`,
      'If the publisher row is not in a pending state, stop — it may already be decided.',
      'Do not change commission, payout, or contract terms while approving.',
      'If the dashboard requires setting terms as part of approval, stop and hand back to the user.',
    ]),
    mutates: true,
    verify: {
      url: AWIN_PENDING_PUBLISHERS_URL,
      expect: `publisher ${input.publisherId} no longer appears in the pending queue; its status reads approved (or declined).`,
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

/** Exposed for tests: the constant starting URL is never derived from input. */
export const _internals = { AWIN_PENDING_PUBLISHERS_URL };
