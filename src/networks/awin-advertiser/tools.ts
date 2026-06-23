/**
 * Awin advertiser publisher-decision tools — the first browser-emitter surface,
 * plus its verify-closure report.
 *
 * `affiliate_awin-advertiser_propose_publisher_decision` validates the brand
 * binding, calls the matching pure emitter from `./actions.ts`, and records a
 * `handoff_emitted` audit line before returning the `ApiGapResponse`.
 *
 * `affiliate_awin-advertiser_report_publisher_decision_result` closes the arc:
 * after a consumer carries out the handoff and revisits the verify target, it
 * records `verified` (the expected state was present) or `verify_failed` (it was
 * not). This is the consumer's report-back per the browser-handoff contract
 * (docs/decisions/2026-06-12-browser-handoff-contract.md, decision 2). It does
 * NOTHING else: no network call, no browser action.
 *
 * Both tools are annotated `readOnlyHint: true`: emitting the handoff and
 * recording its observed outcome are read-only on the world (neither performs a
 * network write), exactly like Impact's propose_contract. The mutation risk
 * lives in the consumer that carries out the handoff. Neither tool ever records
 * `applied`/`succeeded` — a handoff is only ever closed by a consumer that
 * observed the outcome at the verify target, as `verified` or `verify_failed`.
 */

import { z } from 'zod';
import { buildAdapterCallContext } from '../../shared/brand-resolver.js';
import { recordActionAudit } from '../../shared/audit.js';
import { toJsonSchema } from '../../tools/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import { awinAdvertiserAdapter } from './adapter.js';
import {
  buildApprovePublisherHandoff,
  buildDeclinePublisherHandoff,
  type PublisherDecisionInput,
} from './actions.js';

const ProposePublisherDecisionSchema = z
  .object({
    brand: z.string().trim().min(1),
    programmeId: z.string().trim().min(1),
    publisherId: z.string().trim().min(1),
    publisherName: z.string().trim().min(1),
    decision: z.enum(['approve', 'decline']),
    declineReason: z.string().trim().min(1).optional(),
  })
  .strict();

const ReportPublisherDecisionResultSchema = z
  .object({
    brand: z.string().trim().min(1),
    programmeId: z.string().trim().min(1),
    publisherId: z.string().trim().min(1),
    decision: z.enum(['approve', 'decline']),
    verified: z.boolean(),
    note: z.string().trim().min(1).optional(),
  })
  .strict();

/** Map a decision to the matching action-capability-map descriptor id. */
function actionIdFor(decision: 'approve' | 'decline'): string {
  return decision === 'approve'
    ? 'awin-advertiser.approvePublisher'
    : 'awin-advertiser.declinePublisher';
}

export function generateAwinAdvertiserTools(): ToolDefinition[] {
  return [
    tool(
      'affiliate_awin-advertiser_propose_publisher_decision',
      'Experimentally prepare a guided browser handoff to approve or decline a pending publisher ' +
        'application on an Awin programme. Awin exposes no public approve/decline endpoint, so this ' +
        'emits a typed handoff for a human to carry out against their own Awin session; it performs ' +
        'no network write itself. Requires brand, programmeId, publisherId, publisherName, and ' +
        'decision (approve|decline); decline accepts an optional declineReason. Returns an ApiGapResponse ' +
        'carrying the browser handoff (constraints, verify target, and inputs with no credentials).',
      ProposePublisherDecisionSchema,
      async (args) => {
        const input = ProposePublisherDecisionSchema.parse(args ?? {});
        // Validate the brand binding to awin-advertiser the same way Impact does;
        // a clean BrandNotRegistered surfaces if the brand is not bound.
        buildAdapterCallContext(input.brand, awinAdvertiserAdapter.slug);

        const emitterInput: PublisherDecisionInput = {
          brand: input.brand,
          programmeId: input.programmeId,
          publisherId: input.publisherId,
          publisherName: input.publisherName,
          ...(input.declineReason !== undefined ? { declineReason: input.declineReason } : {}),
        };

        const response =
          input.decision === 'approve'
            ? buildApprovePublisherHandoff(emitterInput)
            : buildDeclinePublisherHandoff(emitterInput);

        // Record a handoff_emitted audit line. `intendedAfterState` is present so
        // countMutatingHandoffsOn treats this mutating handoff as consuming the
        // day's allowance; `occurredAt` attributes it to a calendar day. We never
        // record `applied`/`succeeded` — closing the arc is the consumer's report.
        recordActionAudit({
          event: 'handoff_emitted',
          action: actionIdFor(input.decision),
          network: awinAdvertiserAdapter.slug,
          brand: input.brand,
          programmeId: input.programmeId,
          authorityTier: 3,
          summary: `${input.decision} publisher ${input.publisherId} (${input.publisherName})`,
          intendedAfterState: {
            publisherId: input.publisherId,
            decision: input.decision,
          },
          occurredAt: new Date().toISOString(),
        });

        // Return the ApiGapResponse (a normal value); never throw it.
        return response;
      },
      { readOnlyHint: true },
    ),
    tool(
      'affiliate_awin-advertiser_report_publisher_decision_result',
      'Record the observed outcome of a previously emitted Awin publisher approve/decline handoff, ' +
        'closing the audit arc. After a consumer carries out the handoff and revisits the verify ' +
        'target, call this with verified=true when the expected state was present, or verified=false ' +
        'when it was not. It records a verified or verify_failed audit line and does nothing else: no ' +
        'network call, no browser action, no state change. Requires brand, programmeId, publisherId, ' +
        'decision (approve|decline), and verified; accepts an optional note. Never records ' +
        'applied/succeeded; success is only ever an outcome the consumer actually observed.',
      ReportPublisherDecisionResultSchema,
      async (args) => {
        const input = ReportPublisherDecisionResultSchema.parse(args ?? {});
        // Validate the brand binding to awin-advertiser, exactly as the propose
        // tool does; a clean BrandNotRegistered surfaces if the brand is unbound.
        buildAdapterCallContext(input.brand, awinAdvertiserAdapter.slug);

        // verified -> the consumer observed the intended state at the verify
        // target; verify_failed -> it was revisited and the state was absent.
        // No other event is reachable here: this tool only ever reports an
        // observed verify outcome, never applied/succeeded.
        recordActionAudit({
          event: input.verified ? 'verified' : 'verify_failed',
          action: actionIdFor(input.decision),
          network: awinAdvertiserAdapter.slug,
          brand: input.brand,
          programmeId: input.programmeId,
          authorityTier: 3,
          summary:
            `${input.decision} publisher ${input.publisherId}: ` +
            `${input.verified ? 'verified at the verify target' : 'verify target did not show the expected state'}` +
            `${input.note !== undefined ? ` (${input.note})` : ''}`,
          occurredAt: new Date().toISOString(),
        });

        return {
          recorded: input.verified ? 'verified' : 'verify_failed',
          brand: input.brand,
          programmeId: input.programmeId,
          publisherId: input.publisherId,
          decision: input.decision,
        };
      },
      { readOnlyHint: true },
    ),
  ];
}

function tool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  handle: (args: unknown) => Promise<unknown>,
  annotations?: ToolDefinition['annotations'],
): ToolDefinition {
  return { name, description, inputSchema: toJsonSchema(schema), handle, annotations };
}
