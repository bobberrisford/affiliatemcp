import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import {
  AWIN_SLUG,
  csv,
  defaultReportWindow,
  requirePublisherId,
  requireToken,
  toDateOnly,
  toQuery,
} from './shared.js';

export interface AwinPublisherReportInput {
  from?: string;
  to?: string;
  dateType?: 'transaction' | 'validation';
  region?: string;
  timezone?: string;
}

export interface AwinCampaignReportInput extends AwinPublisherReportInput {
  advertiserIds?: Array<string | number>;
  campaign?: string;
  includeNumbersWithoutCampaign?: boolean;
  interval?: 'day' | 'month' | 'year';
}

export interface AwinReportResult {
  network: 'awin';
  publisherId: string;
  report: 'advertiser' | 'creative' | 'campaign';
  query: Record<string, string | number | undefined>;
  rows: unknown[];
  rawNetworkData: unknown;
}

export async function getAdvertiserPerformance(
  input: AwinPublisherReportInput = {},
): Promise<AwinReportResult> {
  return getPublisherReport('advertiser', input);
}

export async function getCreativePerformance(
  input: AwinPublisherReportInput = {},
): Promise<AwinReportResult> {
  return getPublisherReport('creative', input);
}

export async function getCampaignPerformance(
  input: AwinCampaignReportInput = {},
): Promise<AwinReportResult> {
  const window = defaultReportWindow(30);
  const query = toQuery({
    startDate: toDateOnly(input.from, new Date(`${window.startDate}T00:00:00Z`)),
    endDate: toDateOnly(input.to, new Date(`${window.endDate}T00:00:00Z`)),
    dateType: input.dateType ?? 'transaction',
    region: input.region ?? 'GB',
    timezone: input.timezone ?? 'Europe/London',
    advertiserIds: csv(input.advertiserIds),
    campaign: input.campaign,
    includeNumbersWithoutCampaign: input.includeNumbersWithoutCampaign,
    interval: input.interval,
  });
  return requestReport('campaign', query);
}

async function getPublisherReport(
  report: 'advertiser' | 'creative',
  input: AwinPublisherReportInput,
): Promise<AwinReportResult> {
  const window = defaultReportWindow(30);
  const query = toQuery({
    startDate: toDateOnly(input.from, new Date(`${window.startDate}T00:00:00Z`)),
    endDate: toDateOnly(input.to, new Date(`${window.endDate}T00:00:00Z`)),
    dateType: input.dateType ?? 'transaction',
    region: input.region ?? 'GB',
    timezone: input.timezone ?? 'Europe/London',
  });
  return requestReport(report, query);
}

async function requestReport(
  report: 'advertiser' | 'creative' | 'campaign',
  query: Record<string, string | number | undefined>,
): Promise<AwinReportResult> {
  const operation =
    report === 'advertiser'
      ? 'getAdvertiserPerformance'
      : report === 'creative'
        ? 'getCreativePerformance'
        : 'getCampaignPerformance';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/reports/${report}`,
    token,
    query,
    resilience: DEFAULT_RESILIENCE,
  });

  return {
    network: AWIN_SLUG,
    publisherId,
    report,
    query,
    rows: normaliseRows(raw),
    rawNetworkData: raw,
  };
}

export function normaliseRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const body = record['body'];
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const bodyRecord = body as Record<string, unknown>;
    for (const key of ['data', 'rows', 'results', 'items', 'pageItems']) {
      const value = bodyRecord[key];
      if (Array.isArray(value)) return value;
    }
  }
  for (const key of ['data', 'rows', 'results', 'items', 'pageItems']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
