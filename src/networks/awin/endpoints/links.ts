import { z } from 'zod';

import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import {
  AWIN_SLUG,
  compactObject,
  configError,
  requirePositiveIntegerId,
  requirePublisherId,
  requireToken,
} from './shared.js';

export interface AwinLinkParameters {
  campaign?: string;
  clickref?: string;
  clickref2?: string;
  clickref3?: string;
  clickref4?: string;
  clickref5?: string;
  clickref6?: string;
}

export interface AwinLinkRequest {
  advertiserId: string | number;
  destinationUrl?: string;
  parameters?: AwinLinkParameters;
  shorten?: boolean;
}

export interface AwinBatchLinkRequest {
  advertiserId: string | number;
  destinationUrl?: string;
  parameters?: AwinLinkParameters;
}

export interface AwinGeneratedLink {
  network: 'awin';
  publisherId: string;
  advertiserId: string;
  destinationUrl?: string;
  trackingUrl?: string;
  shortUrl?: string;
  rawNetworkData: unknown;
}

export const AwinBatchGeneratedLinksResultSchema = z
  .object({
    network: z.literal('awin'),
    publisherId: z.string(),
    responses: z.array(z.unknown()),
    rawNetworkData: z.unknown(),
  })
  .strict();

export type AwinBatchGeneratedLinksResult = z.infer<typeof AwinBatchGeneratedLinksResultSchema>;

export interface AwinLinkBuilderQuotaResult {
  network: 'awin';
  publisherId: string;
  limit?: string | number;
  usage?: number;
  rawNetworkData: unknown;
}

export async function generateLink(input: AwinLinkRequest): Promise<AwinGeneratedLink> {
  const operation = 'generateLink';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const advertiserId = requirePositiveIntegerId(input.advertiserId, 'advertiserId', operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/linkbuilder/generate`,
    method: 'POST',
    token,
    body: compactObject({
      advertiserId: Number(advertiserId),
      destinationUrl: input.destinationUrl,
      parameters: input.parameters ? compactObject({ ...input.parameters }) : undefined,
      shorten: input.shorten,
    }),
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    network: AWIN_SLUG,
    publisherId,
    advertiserId,
    destinationUrl: input.destinationUrl,
    trackingUrl: typeof record['url'] === 'string' ? record['url'] : undefined,
    shortUrl: typeof record['shortUrl'] === 'string' ? record['shortUrl'] : undefined,
    rawNetworkData: raw,
  };
}

export async function generateLinksBatch(
  requests: AwinBatchLinkRequest[],
): Promise<AwinBatchGeneratedLinksResult> {
  const operation = 'generateLinksBatch';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  if (requests.length === 0) {
    throw configError(operation, 'requests must contain at least one link-builder request.');
  }
  if (requests.length > 100) {
    throw configError(
      operation,
      'Awin Link Builder batch generation supports at most 100 requests.',
      'Split the request into batches of 100 links or fewer.',
    );
  }

  const normalised = requests.map((request) => ({
    advertiserId: Number(requirePositiveIntegerId(request.advertiserId, 'advertiserId', operation)),
    destinationUrl: request.destinationUrl,
    parameters: request.parameters ? compactObject({ ...request.parameters }) : undefined,
  }));

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/linkbuilder/generate-batch`,
    method: 'POST',
    token,
    body: { requests: normalised },
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return AwinBatchGeneratedLinksResultSchema.parse({
    network: AWIN_SLUG,
    publisherId,
    responses: Array.isArray(record['responses']) ? record['responses'] : [],
    rawNetworkData: raw,
  });
}

export async function getLinkBuilderQuota(): Promise<AwinLinkBuilderQuotaResult> {
  const operation = 'getLinkBuilderQuota';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/linkbuilder/quota`,
    token,
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const usage = record['usage'];
  return {
    network: AWIN_SLUG,
    publisherId,
    limit:
      typeof record['limit'] === 'string' || typeof record['limit'] === 'number'
        ? record['limit']
        : undefined,
    usage: typeof usage === 'number' ? usage : undefined,
    rawNetworkData: raw,
  };
}
