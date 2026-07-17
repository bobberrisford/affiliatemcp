/**
 * Awin publisher programme-application EMITTER - pure, side-effect-free.
 *
 * Awin's publisher API has no public endpoint to apply to or join a programme
 * (`network.json` records `supports_brand_ops: false`), so the operation is an
 * API gap. Rather than throw, the adapter returns an `ApiGapResponse` carrying a
 * typed `BrowserHandoff` per the accepted browser-handoff contract
 * (docs/decisions/2026-06-12-browser-handoff-contract.md) and the publisher
 * application decision
 * (docs/decisions/2026-06-24-awin-publisher-programme-application-actions.md):
 * a human, or the authorised consumer skill, carries out the handoff against the
 * operator's own authenticated Awin session.
 *
 * This function is PURE. It builds a plan; it never calls `fetch`, the `awin`
 * client, `auth.ts`, or `withResilience`, and it touches no session, cookie, or
 * DOM. The mutation risk lives entirely in the consumer that carries out the
 * handoff, never in this repo. The handoff URLs are built by reviewed code here
 * from a fixed Awin-owned origin and path template. The only values interpolated
 * are the operator's own `publisherId` (from their authenticated config, not the
 * caller or model) and the numeric `advertiserId` target, each percent-encoded.
 * A hostile caller cannot change the origin or inject a path, so the operator can
 * only ever be sent to their own Awin publisher account on `ui.awin.com`. The
 * exact paths were confirmed against a live Awin publisher tenant on 2026-06-27.
 *
 * Terms handling is deliberately NOT in this payload. Per decision §2, the
 * itemised terms-review evidence belongs to the consumer workflow and the audit
 * summary, not the pure emitter inputs. The emitter only names the target
 * programme; the consumer surfaces and gates the terms (decision §3).
 *
 * Cardinal rules honoured:
 *   1. NEVER call fetch. This emitter calls nothing.
 *   2. An API gap is an expected, documented condition - it returns an
 *      `ApiGapResponse`, never a `NetworkErrorEnvelope`.
 *   3. No secrets (token, cookie, session) ever reach the handoff `inputs`.
 *   4. UK English in user-visible strings.
 */

import { composeConstraints } from '../../shared/browser-handoff.js';
import type {
  ActionDescriptor,
  ApiGapResponse,
  BrowserHandoff,
  NetworkSlug,
} from '../../shared/types.js';

/** The publisher-side network slug. Matches `awinAdapter.slug`. */
const SLUG: NetworkSlug = 'awin';

/**
 * The Awin publisher UI origin. CONSTANT and Awin-owned. Every handoff URL is
 * built from this origin by reviewed code below; the origin is never taken from
 * caller input, so a handoff can only ever target `ui.awin.com`.
 */
const AWIN_PUBLISHER_UI_ORIGIN = 'https://ui.awin.com';

/**
 * The programme-detail ("merchant profile") page for one advertiser inside the
 * operator's own publisher account. This is where a publisher reviews a
 * programme's terms and clicks "Join Programme". Used as the handoff
 * `startingUrl` so the consumer lands directly on the target programme.
 *
 * Verified against a live Awin publisher tenant on 2026-06-27. Awin scopes the
 * publisher area under `/awin/affiliate/{publisherId}/` ("affiliate" is Awin's
 * word for publisher) and the per-advertiser page is `/merchant-profile/{id}`.
 * Both ids are percent-encoded; upstream validation already constrains them to
 * positive integers.
 */
function programmeDetailUrl(publisherId: string, advertiserId: string): string {
  return (
    `${AWIN_PUBLISHER_UI_ORIGIN}/awin/affiliate/${encodeURIComponent(publisherId)}` +
    `/merchant-profile/${encodeURIComponent(advertiserId)}`
  );
}

/**
 * The publisher's pending-applications list (the "Pending" tab of the merchant
 * directory). A just-submitted application appears here as pending until the
 * advertiser approves it. Used as the handoff `verify.url`.
 *
 * Verified against a live Awin publisher tenant on 2026-06-27.
 */
function pendingApplicationsUrl(publisherId: string): string {
  return (
    `${AWIN_PUBLISHER_UI_ORIGIN}/awin/affiliate/${encodeURIComponent(publisherId)}` +
    `/merchant-directory/index/tab/pending/page/1`
  );
}

/** Caller-supplied, non-secret inputs for a programme-application handoff. */
export interface ProgrammeApplicationInput {
  /**
   * The operator's own Awin publisher id, from their authenticated config (not
   * the caller or model). Scopes the handoff URLs to the operator's account.
   */
  publisherId: string;
  /** The Awin advertiser (programme) the publisher is applying to join. */
  advertiserId: string;
  /** The programme/brand display name, for an unambiguous handoff goal. */
  programmeName: string;
  /** Operator's logical brand label; echoed for display, never a network id. */
  brand: string;
  /**
   * Optional short summary of the promotional methods the operator wants to
   * declare on the application form. If the form needs more than this, the
   * constraint floor requires the consumer to stop and hand back rather than
   * invent an answer.
   */
  promotionMethodSummary?: string;
}

/**
 * Build the shared `BrowserHandoff` for a programme application. The
 * `startingUrl` and `verify.url` are always the module constant; the per-action
 * constraints are appended to the shared floor via `composeConstraints`, which
 * the consumer must honour and cannot weaken.
 */
function buildProgrammeApplicationHandoff(input: ProgrammeApplicationInput): BrowserHandoff {
  const inputs: Record<string, unknown> = {
    advertiserId: input.advertiserId,
    programmeName: input.programmeName,
    brand: input.brand,
  };
  if (input.promotionMethodSummary !== undefined) {
    inputs['promotionMethodSummary'] = input.promotionMethodSummary;
  }
  return {
    goal: `Apply to the ${input.programmeName} programme (advertiser id ${input.advertiserId}) on Awin for brand ${input.brand}.`,
    startingUrl: programmeDetailUrl(input.publisherId, input.advertiserId),
    inputs,
    constraints: composeConstraints([
      `Apply only to advertiser ${input.advertiserId}; do not apply to any other programme.`,
      'If the programme relationship is not joinable (already joined, pending, or rejected), stop and hand back.',
      "Do not negotiate, counter, or alter the programme's commercial terms.",
      'If the application form requires answers the inputs do not supply (for example a free-text promotional-methods justification beyond the supplied summary), stop and hand back rather than inventing them.',
    ]),
    mutates: true,
    verify: {
      url: pendingApplicationsUrl(input.publisherId),
      expect: `advertiser ${input.advertiserId} appears in the pending-applications list, or the programme relationship reads pending or joined.`,
    },
  };
}

/**
 * Emit the API-gap response for applying to an Awin programme. Pure: builds and
 * returns a plan, performs no network call.
 */
export function buildApplyToProgrammeHandoff(input: ProgrammeApplicationInput): ApiGapResponse {
  return {
    kind: 'api-gap',
    network: SLUG,
    operation: 'applyToProgramme',
    reason: 'Awin has no public publisher programme-application endpoint',
    userMessage:
      `Awin's publisher API cannot apply to a programme, so this prepares a guided browser handoff ` +
      `to apply to ${input.programmeName} (advertiser id ${input.advertiserId}) in the Awin ` +
      `dashboard. Review it, and the programme's terms, before carrying it out; applying is a state ` +
      `change and accepts the advertiser's terms.`,
    browserFallback: buildProgrammeApplicationHandoff(input),
  };
}

// ---------------------------------------------------------------------------
// Action capability map - the one browser/write action this adapter declares.
// See docs/decisions/2026-06-18-action-capability-map.md and
// docs/decisions/2026-06-24-awin-publisher-programme-application-actions.md.
// Network-scoped id, owned beside the emitter that implements it. Channel
// 'browser', effect 'write', default authority tier 3 (write fail-closed).
// ---------------------------------------------------------------------------

export const awinActionDescriptors: ActionDescriptor[] = [
  {
    id: 'awin.applyToProgramme',
    network: SLUG,
    channel: 'browser',
    effect: 'write',
    defaultAuthorityTier: 3,
    description:
      "Apply to a brand's programme on Awin as a publisher. Awin exposes no public " +
      'publisher application endpoint, so this emits a typed browser handoff for a human (or the ' +
      "authorised consumer skill) to carry out against the operator's own Awin session, with " +
      "the programme's terms surfaced for informed acceptance. The emitter performs no network " +
      'write; the mutation risk lives in the consumer that carries out the handoff.',
    credentialRequirements: [{ label: 'AWIN_API_TOKEN' }, { label: 'AWIN_PUBLISHER_ID' }],
  },
];

/**
 * Exposed for tests: the fixed origin and the reviewed URL builders. The origin
 * is constant; the builders interpolate only the operator's publisherId and the
 * numeric advertiserId target, each percent-encoded.
 */
export const _internals = {
  AWIN_PUBLISHER_UI_ORIGIN,
  programmeDetailUrl,
  pendingApplicationsUrl,
};
