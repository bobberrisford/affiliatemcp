/** Impact advertiser contract reads, kept network-local until shared semantics exist. */

import { z } from 'zod';
import { buildAdapterCallContext } from '../../shared/brand-resolver.js';
import { toJsonSchema } from '../../tools/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import { impactAdvertiserAdapter } from './adapter.js';

const ContractStatusSchema = z.enum(['active', 'pending', 'expired', 'inactive', 'unknown']);

const ListContractsSchema = z
  .object({
    brand: z.string().min(1),
    programmeId: z.string().min(1),
    status: z.union([ContractStatusSchema, z.array(ContractStatusSchema)]).optional(),
    mediaPartnerId: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    cursor: z
      .string()
      .regex(/^[1-9]\d*$/, 'cursor must be a positive Impact page number')
      .optional(),
  })
  .strict();

const GetContractSchema = z
  .object({
    brand: z.string().min(1),
    programmeId: z.string().min(1),
    contractId: z.string().min(1),
  })
  .strict();

const ProposeApplyContractSchema = z
  .object({
    brand: z.string().trim().min(1),
    programmeId: z.string().trim().min(1),
    action: z.literal('apply'),
    contractId: z.string().trim().min(1).optional(),
    payoutTerms: z.string().trim().min(1).optional(),
    mediaPartnerId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.payoutTerms !== undefined || value.mediaPartnerId !== undefined, {
    message: 'An apply proposal requires payoutTerms or mediaPartnerId.',
  });

const ProposeRemoveContractSchema = z
  .object({
    brand: z.string().trim().min(1),
    programmeId: z.string().trim().min(1),
    action: z.literal('remove'),
    contractId: z.string().trim().min(1),
  })
  .strict();

const ProposeContractSchema = z.union([
  ProposeApplyContractSchema,
  ProposeRemoveContractSchema,
]);

export function generateImpactAdvertiserTools(): ToolDefinition[] {
  return [
    tool(
      'affiliate_impact-advertiser_list_contracts',
      'Experimentally list Impact contracts, the payment-term relationships with media partners, for one brand programme. Use this to review known partner terms before any separately gated change is proposed. Requires brand and programmeId; supports status, mediaPartnerId, page cursor, and limit filters, and returns read-only Impact contract records with raw payloads preserved.',
      ListContractsSchema,
      (args) => {
        const { brand, ...query } = ListContractsSchema.parse(args ?? {});
        const ctx = buildAdapterCallContext(brand, impactAdvertiserAdapter.slug);
        return impactAdvertiserAdapter.listContracts(query, ctx);
      },
      { readOnlyHint: true },
    ),
    tool(
      'affiliate_impact-advertiser_get_contract',
      'Experimentally fetch one read-only Impact contract by brand, programmeId, and contractId. Use this after list_contracts when the operator needs the full status, payout terms, dates, and raw Impact payload for a known contract. This operation performs only an API read and does not propose, apply, remove, or execute a browser flow.',
      GetContractSchema,
      (args) => {
        const { brand, programmeId, contractId } = GetContractSchema.parse(args ?? {});
        const ctx = buildAdapterCallContext(brand, impactAdvertiserAdapter.slug);
        return impactAdvertiserAdapter.getContract({ programmeId, contractId }, ctx);
      },
      { readOnlyHint: true },
    ),
    tool(
      'affiliate_impact-advertiser_propose_contract',
      'Experimentally build a reviewable plan for changing an Impact contract (a brand-partner payment-term relationship) WITHOUT writing anything to the network. Use this to preview exactly what an apply or remove would do, and its blast radius, before any separately gated write is enabled. Requires brand, programmeId, and action (apply|remove); returns a ContractChangePlan with before/after snapshots, warnings, and a confirmation token, and performs only API reads.',
      ProposeContractSchema,
      (args) => {
        const input = ProposeContractSchema.parse(args ?? {});
        const ctx = buildAdapterCallContext(input.brand, impactAdvertiserAdapter.slug);
        return impactAdvertiserAdapter.proposeContract(input, ctx);
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
