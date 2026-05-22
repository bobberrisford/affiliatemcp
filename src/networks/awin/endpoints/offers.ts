import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import { AWIN_SLUG, compactObject, requirePublisherId, requireToken } from './shared.js';

export interface AwinOffersInput {
  advertiserIds?: number[];
  exclusiveOnly?: boolean;
  membership?: 'joined' | 'notJoined' | 'all';
  regionCodes?: string[];
  status?: 'active' | 'expiringSoon' | 'upcoming';
  type?: 'promotion' | 'voucher' | 'all';
  updatedSince?: string;
  page?: number;
  pageSize?: number;
}

export interface AwinOffersResult {
  network: 'awin';
  publisherId: string;
  filters: Record<string, unknown>;
  pagination: Record<string, unknown>;
  offers: unknown[];
  rawNetworkData: unknown;
}

export async function listOffers(input: AwinOffersInput = {}): Promise<AwinOffersResult> {
  const operation = 'listOffers';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const filters = compactObject({
    advertiserIds: input.advertiserIds,
    exclusiveOnly: input.exclusiveOnly,
    membership: input.membership,
    regionCodes: input.regionCodes,
    status: input.status,
    type: input.type,
    updatedSince: input.updatedSince,
  });
  const pagination = compactObject({
    page: input.page ?? 1,
    pageSize: input.pageSize ?? 100,
  });

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publisher/${publisherId}/promotions`,
    method: 'POST',
    token,
    body: { filters, pagination },
    resilience: DEFAULT_RESILIENCE,
  });

  return {
    network: AWIN_SLUG,
    publisherId,
    filters,
    pagination,
    offers: normaliseOffers(raw),
    rawNetworkData: raw,
  };
}

export function normaliseOffers(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  for (const key of ['offers', 'promotions', 'items', 'pageItems', 'data', 'results']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  const body = record['body'];
  if (body && typeof body === 'object') {
    const bodyRecord = body as Record<string, unknown>;
    for (const key of ['offers', 'promotions', 'items', 'pageItems', 'data', 'results']) {
      const value = bodyRecord[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
