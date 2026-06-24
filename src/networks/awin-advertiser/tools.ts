/**
 * Awin advertiser publisher-decision tool — the first browser-emitter surface.
 *
 * One tool, `affiliate_awin-advertiser_propose_publisher_decision`, validates
 * the brand binding, calls the matching pure emitter from `./actions.ts`, and
 * records a `handoff_emitted` audit line before returning the `ApiGapResponse`.
 *
 * Annotated `readOnlyHint: true`: emitting the handoff is read-only on the
 * world (it performs no network write), exactly like Impact's propose_contract.
 * The mutation risk lives in the consumer that carries out the handoff. The
 * tool NEVER records `applied`/`succeeded` — a handoff is only ever closed by a
 * consumer that observed the outcome at the verify target.
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
        // a clean BrandNotRegistered surfaces if the brand is not bound. The
        // resolved ctx.networkBrandId IS the Awin advertiser accountId, which
        // scopes the partnerships-page startingUrl — advertiserId is therefore
        // derived from the brand binding, never accepted as caller input.
        const ctx = buildAdapterCallContext(input.brand, awinAdvertiserAdapter.slug);

        const emitterInput: PublisherDecisionInput = {
          brand: input.brand,
          advertiserId: ctx.networkBrandId,
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
          action:
            input.decision === 'approve'
              ? 'awin-advertiser.approvePublisher'
              : 'awin-advertiser.declinePublisher',
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
