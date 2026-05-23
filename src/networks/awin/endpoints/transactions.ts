import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import {
  AWIN_SLUG,
  configError,
  csv,
  defaultReportWindow,
  requirePositiveIntegerId,
  requirePublisherId,
  requireToken,
  toQuery,
} from './shared.js';

export interface AwinTransactionsByIdInput {
  ids: Array<string | number>;
  showBasketProducts?: boolean;
  timezone?: string;
}

export interface AwinTransactionQueriesInput {
  advertiserIds?: Array<string | number>;
  clickRefs?: string[];
  dateType?: 'enquiryDate' | 'transactionDate' | 'validationDate';
  from?: string;
  to?: string;
  statuses?: Array<'pending' | 'approved' | 'declined'>;
  timezone?: string;
  pageNumber?: number;
  pageSize?: number;
}

export interface AwinTransactionsByIdResult {
  network: 'awin';
  publisherId: string;
  ids: string[];
  transactions: unknown[];
  rawNetworkData: unknown;
}

export interface AwinTransactionQueriesResult {
  network: 'awin';
  publisherId: string;
  queries: unknown[];
  pageNumber?: number;
  pageSize?: number;
  totalPagesAvailable?: number;
  totalRowsAvailable?: number;
  rawNetworkData: unknown;
}

export async function getTransactionsByIds(
  input: AwinTransactionsByIdInput,
): Promise<AwinTransactionsByIdResult> {
  const operation = 'getTransactionsByIds';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const ids = input.ids.map((id) => requirePositiveIntegerId(id, 'ids', operation));
  if (ids.length === 0) {
    throw configError(
      operation,
      'ids must contain at least one Awin transaction id.',
      'Pass one or more numeric transaction IDs returned by affiliate_awin_list_transactions.',
    );
  }

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/transactions`,
    token,
    query: toQuery({
      ids: ids.join(','),
      showBasketProducts: input.showBasketProducts,
      timezone: input.timezone ?? 'Europe/London',
    }),
    resilience: DEFAULT_RESILIENCE,
  });

  return {
    network: AWIN_SLUG,
    publisherId,
    ids,
    transactions: Array.isArray(raw) ? raw : [],
    rawNetworkData: raw,
  };
}

export async function listTransactionQueries(
  input: AwinTransactionQueriesInput = {},
): Promise<AwinTransactionQueriesResult> {
  const operation = 'listTransactionQueries';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const window = defaultReportWindow(30);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publisher/${publisherId}/transactionqueries`,
    token,
    query: toQuery({
      advertiserIds: csv(input.advertiserIds),
      clickRefs: csv(input.clickRefs),
      dateType: input.dateType ?? 'transactionDate',
      startDate: input.from ?? `${window.startDate}T00:00:00`,
      endDate: input.to ?? `${window.endDate}T23:59:59`,
      statuses: csv(input.statuses),
      timezone: input.timezone ?? 'Europe/London',
      pageNumber: input.pageNumber,
      pageSize: input.pageSize,
    }),
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    network: AWIN_SLUG,
    publisherId,
    queries: Array.isArray(record['pageItems']) ? record['pageItems'] : [],
    pageNumber: typeof record['pageNumber'] === 'number' ? record['pageNumber'] : undefined,
    pageSize: typeof record['pageSize'] === 'number' ? record['pageSize'] : undefined,
    totalPagesAvailable:
      typeof record['totalPagesAvailable'] === 'number' ? record['totalPagesAvailable'] : undefined,
    totalRowsAvailable:
      typeof record['totalRowsAvailable'] === 'number' ? record['totalRowsAvailable'] : undefined,
    rawNetworkData: raw,
  };
}
