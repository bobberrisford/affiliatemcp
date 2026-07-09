/**
 * AccessTrade adapter — publisher side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * (the canonical reference) and `src/networks/everflow/client.ts` (custom-header
 * auth). Read those first before modifying this one.
 *
 * AccessTrade (Interspace) is the largest CPA affiliate network in Japan and
 * South-East Asia.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `Authorization: Token <access_key>`.
 * Base:    https://gurkha.accesstrade.global  (per-country; see client.ts)
 * Docs:    https://support.accesstrade.global/api/report-apis.html
 *          https://developers.accesstrade.vn/
 *
 * --- Endpoint map (verified against the docs above, 2026-06-05) -------------
 *
 *   GET  /v1/publishers/me/sites/{siteId}/campaigns/affiliated
 *   GET  /v1/publishers/me/sites/{siteId}/campaigns/applied
 *   GET  /v1/publishers/me/sites/{siteId}/campaigns/unaffiliated
 *     → programmes (campaigns) by relationship. Query: keyword, categories,
 *       campaignTypes, limit (required), page (required). Response items carry
 *       id, name, url, imageUrl, affiliationStatus, defaultRewards, categories.
 *   GET  /v1/publishers/me/reports/conversion
 *     → conversion report (transactions). Query: fromDate, toDate (ISO with a
 *       timezone offset, e.g. +09:00), page, limit. Rate limit 1 request /
 *       5 minutes; the window is capped at 7 days. Response:
 *       totalConversionsCount, totalReward, conversionReportItems[].
 *   GET  /v1/publishers/me/sites/{siteId}/campaigns/{campaignId}/productfeed/url
 *     → product datafeed download URL (not surfaced by the seven canonical ops).
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `accessTradeRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live account.
 *   - Reward/amount unit is documented as a number in the account currency but
 *     the minor/major unit is not stated; we treat it as a major-unit decimal.
 *   - The conversion report is rate-limited (1 request / 5 minutes) and capped
 *     at a 7-day window; wider ranges are chunked into 7-day slices automatically.
 *   - The publisher API does not expose click-level data; listClicks is
 *     unsupported.
 *   - Tracking links are produced in the dashboard, not via a documented
 *     deterministic scheme; generateTrackingLink is unsupported.
 *   - The base URL differs by country; non-default countries set ACCESSTRADE_BASE_URL.
 *   - The campaign listing is paginated via the required limit/page parameters.
 *     When the caller passes no limit, listProgrammes pulls every page, capped
 *     at MAX_PAGES with a warning rather than a silent truncation.
 */

import { accessTradeRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type EarningsByProgramme,
  type EarningsByStatus,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammeQuery,
  type ProgrammeStatus,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('accesstrade.adapter');

const SLUG = 'accesstrade';
const NAME = 'AccessTrade';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://gurkha.accesstrade.global',
  // AccessTrade uses a custom header (Authorization: Token <key>) rather than Bearer.
  authModel: 'custom',
  docsUrl: 'https://support.accesstrade.global/api/report-apis.html',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Reward/amount unit is assumed to be a major-unit decimal in the account currency; the documentation does not state the unit. Verify against a live account.',
    'The conversion report is rate-limited to 1 request / 5 minutes and capped at a 7-day window; wider ranges are chunked into 7-day slices automatically.',
    'Click-level data is not exposed via the publisher API; listClicks is unsupported.',
    'Tracking links are produced in the AccessTrade dashboard, not via a documented deterministic scheme; generateTrackingLink is unsupported.',
    'The API base URL differs by country; non-default countries must set ACCESSTRADE_BASE_URL.',
    'The campaign listing is paginated via the required limit/page parameters; when no limit is requested, listProgrammes pulls every page, capped at MAX_PAGES with a warning rather than a silent truncation.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * The conversion report is rate-limited (1 request / 5 minutes) and may be slow
 * for wide windows. Give it a 60s timeout and 3 retries, matching the pattern
 * Awin uses for its slow transactions endpoint. The retry policy still does NOT
 * retry on 4xx other than 429, so a 429 from the rate limiter is the only
 * client error that retries.
 */
const REPORTING_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTING_RESILIENCE,
  getEarningsSummary: REPORTING_RESILIENCE,
};

// AccessTrade caps the conversion report at a 7-day window per call.
const CONVERSION_WINDOW_DAYS = 7;

// Largest page size this adapter requests from the campaign listing per call
// (the endpoint's `limit` parameter is required; 300 matches the ceiling the
// adapter has always applied to caller-supplied limits).
const CAMPAIGN_PAGE_SIZE = 300;

/**
 * Backstop for the campaign pagination loop, mirroring the Tolt/Tapfiliate
 * pattern: when the caller passes no limit we pull to completion, but never
 * loop unboundedly against a misbehaving `total`. Hitting the cap logs a
 * warning (stderr) so a truncated pull is never silent (principle 4.1).
 */
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// AccessTrade raw response shapes (deliberately minimal — see Awin for rationale)
// ---------------------------------------------------------------------------

/** One campaign record from the campaigns endpoints. */
interface AccessTradeCampaignRaw {
  id?: string | number;
  name?: string;
  url?: string;
  imageUrl?: string;
  // affiliationStatus describes this publisher's relationship to the campaign.
  // Confirmed values include "affiliated", "applied"/"pending", "rejected",
  // "unaffiliated" (support.accesstrade.global/api/campaign-apis.html, 2026-06-05).
  affiliationStatus?: string;
  status?: string;
  // defaultRewards is the campaign's headline reward. Shape varies; we read it
  // defensively and surface a description rather than guessing a structure.
  defaultRewards?: unknown;
  categories?: Array<{ id?: string | number; name?: string } | string>;
  currency?: string;
}

/** Envelope for the campaign listing endpoints. */
interface AccessTradeCampaignsEnvelope {
  // The listing returns the rows under `data`; `campaigns` retained as a
  // fallback for endpoint/tenant variation.
  data?: AccessTradeCampaignRaw[];
  campaigns?: AccessTradeCampaignRaw[];
  total?: number;
  page?: number;
  limit?: number;
}

/** One conversion record from /v1/publishers/me/reports/conversion. */
interface AccessTradeConversionRaw {
  conversionId?: string | number;
  transactionId?: string | number;
  siteId?: string | number;
  campaignId?: string | number;
  campaignName?: string;
  creativeId?: string | number;
  // Verification / approval status. Confirmed values include "APPROVED",
  // "PENDING", "REJECTED" (support.accesstrade.global/api/report-apis.html,
  // 2026-06-05). Case varies; we lower-case before matching.
  status?: string;
  verificationStatus?: string;
  // reward = commission to the publisher; transactionAmount = gross sale value.
  reward?: number;
  transactionAmount?: number;
  currency?: string;
  // Timestamps are ISO-8601 with a timezone offset (e.g. +09:00 for Japan).
  clickTime?: string;
  conversionTime?: string;
  confirmedTime?: string;
  rejectReason?: string;
}

/** Envelope for the conversion report. */
interface AccessTradeConversionEnvelope {
  totalConversionsCount?: number;
  totalReward?: number;
  conversionReportItems?: AccessTradeConversionRaw[];
  // Fallback key seen in some report variants.
  data?: AccessTradeConversionRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAccessKey(operation: string): string {
  return requireCredential('ACCESSTRADE_ACCESS_KEY', {
    network: SLUG,
    operation,
    hint:
      'Copy your access key from the AccessTrade publisher dashboard → your profile page, ' +
      'then set ACCESSTRADE_ACCESS_KEY in ~/.affiliate-mcp/.env.',
  });
}

function requireSiteId(operation: string): string {
  return requireCredential('ACCESSTRADE_SITE_ID', {
    network: SLUG,
    operation,
    hint:
      'Set ACCESSTRADE_SITE_ID to one of your registered site (website) IDs, ' +
      'visible under Websites in the dashboard.',
  });
}

/**
 * Status normalisation: AccessTrade campaign affiliationStatus → ProgrammeStatus.
 *
 * Confirmed affiliation states (support.accesstrade.global/api/campaign-apis.html,
 * 2026-06-05): the campaign endpoints split by relationship into "affiliated",
 * "applied", "rejected" and "unaffiliated". We collapse to the canonical enum:
 *
 *   affiliated / approved / active   → 'joined'
 *   applied / pending / under_review → 'pending'
 *   rejected / declined              → 'declined'
 *   unaffiliated / available         → 'available'
 *   paused / suspended / inactive    → 'suspended'
 *   anything else                    → 'unknown'
 *
 * We never invent a state the publisher did not see; unknown values map to
 * 'unknown' and the raw value stays on `rawNetworkData`.
 */
function mapProgrammeStatus(raw: AccessTradeCampaignRaw): ProgrammeStatus {
  const s = (raw.affiliationStatus ?? raw.status ?? '').toLowerCase();
  if (s === 'affiliated' || s === 'approved' || s === 'active' || s === 'joined') return 'joined';
  if (s === 'applied' || s === 'pending' || s === 'under_review') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'refused') return 'declined';
  if (s === 'unaffiliated' || s === 'available' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: AccessTrade conversion status → TransactionStatus.
 *
 * Confirmed conversion verification states
 * (support.accesstrade.global/api/report-apis.html, 2026-06-05):
 *   APPROVED → 'approved'
 *   PENDING  → 'pending'
 *   REJECTED → 'reversed'  (AccessTrade uses "rejected"; the user did not get paid)
 *   anything else → 'other'
 *
 * AccessTrade does not expose a distinct "paid" status on the conversion report
 * (payment is reconciled separately), so we never synthesise 'paid' here.
 */
function mapTransactionStatus(raw: AccessTradeConversionRaw): TransactionStatus {
  const s = (raw.status ?? raw.verificationStatus ?? '').toLowerCase();
  if (s === 'approved' || s === 'confirmed' || s === 'verified') return 'approved';
  if (s === 'pending' || s === 'unverified' || s === 'on_hold') return 'pending';
  if (s === 'rejected' || s === 'reversed' || s === 'declined' || s === 'invalid') return 'reversed';
  return 'other';
}

/**
 * Compute the age (in days) of a transaction relative to `now`.
 *
 * We anchor on `confirmedTime` (the approval point) when present so the
 * unpaid-age affordance answers "how long has this been approved but unpaid",
 * and fall back to `conversionTime` for pending conversions (PRD §15.9).
 */
function computeAgeDays(raw: AccessTradeConversionRaw, now: Date = new Date()): number {
  const anchor = raw.confirmedTime ?? raw.conversionTime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function campaignCategories(raw: AccessTradeCampaignRaw): string[] {
  return (raw.categories ?? [])
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter((n): n is string => typeof n === 'string');
}

function toProgramme(raw: AccessTradeCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  return {
    id,
    name: raw.name ?? `AccessTrade campaign ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    // AccessTrade's `defaultRewards` shape is not fully documented and varies
    // by campaign type; we surface a textual description and keep the verbatim
    // value on rawNetworkData rather than guessing a numeric structure.
    commissionRate:
      raw.defaultRewards !== undefined && raw.defaultRewards !== null
        ? {
            type: 'unknown',
            description:
              typeof raw.defaultRewards === 'string'
                ? raw.defaultRewards
                : JSON.stringify(raw.defaultRewards),
          }
        : undefined,
    categories: campaignCategories(raw),
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AccessTradeConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // reward = commission to the publisher; transactionAmount = gross sale value.
  // Amount unit is assumed to be a major-unit decimal in the account currency;
  // see META.knownLimitations.
  const commission = raw.reward ?? 0;
  const sale = raw.transactionAmount ?? 0;
  const currency = raw.currency ?? 'USD';

  const conversionTime = nullableIso(raw.conversionTime) ?? new Date(0).toISOString();
  const clickTime = nullableIso(raw.clickTime);
  const confirmedTime = nullableIso(raw.confirmedTime);

  return {
    id: String(raw.conversionId ?? raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.campaignId ?? ''),
    programmeName: raw.campaignName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickTime,
    dateConverted: conversionTime,
    dateApproved: confirmedTime,
    // AccessTrade reconciles payment separately and does not expose a paid date
    // on the conversion report; leave undefined rather than fabricating.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.rejectReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date for AccessTrade's `fromDate`/`toDate` query params.
 *
 * The conversion report accepts ISO-8601 with a timezone offset, e.g.
 * `2023-01-01T00:00:00+09:00` (support.accesstrade.global/api/report-apis.html,
 * 2026-06-05). We emit UTC ISO (`...Z`), which is an equivalent valid offset.
 */
function formatReportDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. AccessTrade caps the
 * conversion report at a 7-day window per call, so wider windows are chunked
 * automatically. Mirrors Awin's `chunkDateRange`.
 *
 * Returns at least one slice; if `from >= to` we still return one (zero-width)
 * slice so the call shape stays predictable.
 */
function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [{ start: from, end: to }];
  if (from >= to) return [{ start: from, end: to }];

  const slices: DateSlice[] = [];
  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = from.getTime();
  const endMs = to.getTime();

  while (cursor < endMs) {
    const sliceEnd = Math.min(cursor + stepMs, endMs);
    slices.push({ start: new Date(cursor), end: new Date(sliceEnd) });
    cursor = sliceEnd;
  }
  return slices;
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Map the requested ProgrammeStatus set to the AccessTrade campaign-listing
 * relationship segment. The endpoints split by relationship rather than taking
 * a status filter, so we pick the segment that matches the dominant requested
 * status. We default to 'affiliated' because "what campaigns am I running?" is
 * by far the most common publisher question.
 */
function pickCampaignSegment(statuses?: ProgrammeStatus[]): string {
  if (!statuses || statuses.length === 0) return 'affiliated';
  if (statuses.includes('joined')) return 'affiliated';
  if (statuses.includes('pending')) return 'applied';
  if (statuses.includes('available')) return 'unaffiliated';
  return 'affiliated';
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AccesstradeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List AccessTrade campaigns (programmes) for the configured site.
   *
   * Endpoint: GET /v1/publishers/me/sites/{siteId}/campaigns/{segment}
   *   where {segment} is affiliated | applied | unaffiliated, chosen from the
   *   requested status (default: affiliated). Query: keyword, categories,
   *   limit (required), page (required).
   *
   * Pagination: the endpoint is page-based (1-based `page`, required `limit`,
   * `total` on the envelope). When the caller passes no limit we loop pages
   * until the envelope's `total` is reached (falling back to a short/empty
   * page when `total` is absent), capped at MAX_PAGES with a logged warning so
   * a truncated pull is never silent. When the caller passes a limit we stop
   * as soon as enough rows have been collected, so limited calls keep the
   * previous single-request behaviour.
   *
   * We pass `keyword`/`categories` to the API where the caller supplied them,
   * then apply client-side filters for the canonical `status`/`categories`
   * sets so behaviour matches the other adapters regardless of which segment
   * was queried.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const accessKey = requireAccessKey('listProgrammes');
    const siteId = requireSiteId('listProgrammes');

    const statusFilter = toStatusList(query?.status);
    const segment = pickCampaignSegment(statusFilter);
    const pageLimit = Math.min(query?.limit ?? CAMPAIGN_PAGE_SIZE, CAMPAIGN_PAGE_SIZE);

    const rows: AccessTradeCampaignRaw[] = [];
    let truncated = true;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await accessTradeRequest<AccessTradeCampaignsEnvelope>({
        operation: 'listProgrammes',
        path: `/v1/publishers/me/sites/${encodeURIComponent(siteId)}/campaigns/${segment}`,
        accessKey,
        query: {
          limit: pageLimit,
          page,
          keyword: query?.search,
          categories:
            query?.categories && query.categories.length > 0
              ? query.categories.join(',')
              : undefined,
        },
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      });

      const pageRows = envelope.data ?? envelope.campaigns ?? [];
      rows.push(...pageRows);

      // A caller-supplied limit short-circuits the loop once satisfied; the
      // envelope's `total` (when present) is the authoritative end-of-results
      // signal; without it a short or empty page means the last page.
      const limitSatisfied = typeof query?.limit === 'number' && rows.length >= query.limit;
      const totalReached = typeof envelope.total === 'number' && rows.length >= envelope.total;
      const lastPage =
        pageRows.length === 0 ||
        (typeof envelope.total !== 'number' && pageRows.length < pageLimit);
      if (limitSatisfied || totalReached || lastPage) {
        truncated = false;
        break;
      }
    }

    if (truncated) {
      log.warn(
        { operation: 'listProgrammes', cap: MAX_PAGES, fetched: rows.length },
        'accesstrade pagination hit MAX_PAGES cap; result may be truncated',
      );
    }

    let programmes = rows.map(toProgramme);

    // Client-side filters (defensive — the segment already narrows relationship).
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (query?.categories && query.categories.length > 0) {
      const wanted = new Set(query.categories.map((c) => c.toLowerCase()));
      programmes = programmes.filter((p) =>
        (p.categories ?? []).some((c) => wanted.has(c.toLowerCase())),
      );
    }

    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single campaign by ID.
   *
   * AccessTrade does not document a single-campaign detail endpoint on the
   * publisher API; campaigns are discovered through the relationship-segmented
   * listing endpoints. We therefore fetch the affiliated list and match by ID,
   * falling back to the unaffiliated list so a campaign the publisher has not
   * joined is still resolvable. If no campaign matches we surface a
   * network_api_error with an actionable hint rather than a stub object.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'AccessTrade campaign ID is required.',
          hint: 'Use affiliate_accesstrade_list_programmes to discover campaign IDs.',
        }),
      );
    }

    const accessKey = requireAccessKey('getProgramme');
    const siteId = requireSiteId('getProgramme');

    for (const segment of ['affiliated', 'unaffiliated'] as const) {
      const envelope = await accessTradeRequest<AccessTradeCampaignsEnvelope>({
        operation: 'getProgramme',
        path: `/v1/publishers/me/sites/${encodeURIComponent(siteId)}/campaigns/${segment}`,
        accessKey,
        query: { limit: 300, page: 1 },
        resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
      });
      const rows = envelope.data ?? envelope.campaigns ?? [];
      const match = rows.find((r) => String(r.id ?? '') === programmeId);
      if (match) return toProgramme(match);
    }

    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation: 'getProgramme',
        message: `AccessTrade campaign "${programmeId}" was not found for the configured site.`,
        hint: 'Confirm the campaign ID via affiliate_accesstrade_list_programmes for this site.',
      }),
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversions via the AccessTrade conversion report.
   *
   * Endpoint: GET /v1/publishers/me/reports/conversion
   *   Query: fromDate, toDate (ISO with offset), page, limit.
   *   Rate limit: 1 request / 5 minutes. Window cap: 7 days.
   *
   * The 7-day cap means a wider window is chunked into ≤7-day slices and
   * fetched sequentially (mirroring Awin's 31-day chunking). Because the report
   * is rate-limited to one call every five minutes, callers should keep windows
   * modest; the resilience layer's 429 handling backs off if the limit is hit.
   *
   * Filters (status, programme, age) are applied client-side after the fetch so
   * `{ status: 'approved', minAgeDays: 180 }` is meaningful (PRD §15.9).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const accessKey = requireAccessKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - CONVERSION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, CONVERSION_WINDOW_DAYS);

    const allRaw: AccessTradeConversionRaw[] = [];
    for (const slice of slices) {
      const envelope = await accessTradeRequest<AccessTradeConversionEnvelope>({
        operation: 'listTransactions',
        path: '/v1/publishers/me/reports/conversion',
        accessKey,
        query: {
          fromDate: formatReportDate(slice.start),
          toDate: formatReportDate(slice.end),
          page: 1,
          limit: 1000,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const rows = envelope.conversionReportItems ?? envelope.data ?? [];
      allRaw.push(...rows);
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= minAge);
    }
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= maxAge);
    }

    if (typeof query?.limit === 'number') {
      transactions = transactions.slice(0, query.limit);
    }

    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate the conversion report into an earnings summary.
   *
   * Derived from `listTransactions` for the same reason as Awin and Everflow:
   * the per-transaction `ageDays` is not available from a summary endpoint, so
   * we need the raw records anyway for `oldestUnpaidAgeDays`. Deriving from
   * transactions keeps the summary auditable.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // never apply limit inside a summary — would silently undercount
    });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      // First-observed currency; overwritten by the first transaction's currency.
      currency: 'USD',
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || '__unknown';
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || `AccessTrade campaign ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved).
      if (t.status === 'pending' || t.status === 'approved') {
        if (oldestUnpaidAgeDays === undefined || t.ageDays > oldestUnpaidAgeDays) {
          oldestUnpaidAgeDays = t.ageDays;
        }
      }
    }

    if (firstCurrency) byStatus.currency = firstCurrency;

    return {
      network: SLUG,
      totalEarnings,
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /**
   * AccessTrade does not expose click-level data via the publisher API.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "no clicks" and "no click API" is the
   * difference between an actionable observation and a wild goose chase
   * (PRD principle 4.1). If AccessTrade adds a click endpoint later this becomes
   * a real implementation and the limitation line is dropped.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'AccessTrade does not expose click-level data via the publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * AccessTrade does not document a deterministic tracking-link scheme or a
   * link-generation endpoint on the publisher API. Tracking links are produced
   * in the dashboard per creative; constructing one here would mean guessing a
   * URL format, which violates principle 4.1 (never invent data). We therefore
   * throw `NotImplementedError` with a reason rather than emit a guessed link.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'AccessTrade tracking links are produced in the dashboard; no documented deterministic ' +
        'scheme or link-generation API is available to construct one reliably.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations (NotImplementedError — v0.2 scaffolds)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  // -------------------------------------------------------------------------
  // validateCredential / setupSteps
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  // -------------------------------------------------------------------------
  // capabilitiesCheck
  // -------------------------------------------------------------------------

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (
      name: string,
      fn: () => Promise<unknown>,
      note?: string,
    ): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        const cap: OperationCapability = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
          claimStatus: 'experimental',
        };
        if (note !== undefined) cap.note = note;
        operations[name] = cap;
      } catch (err) {
        operations[name] = {
          supported: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    // listClicks: known-unsupported. Record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'AccessTrade does not expose click-level data via the publisher API',
    };

    // generateTrackingLink: known-unsupported (no documented scheme/endpoint).
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'AccessTrade tracking links are produced in the dashboard; no link-generation API is available',
    };

    // getProgramme requires a known campaign ID — mark as experimental without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known campaign ID; not probed automatically.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level registration
// ---------------------------------------------------------------------------

export const accesstradeAdapter = new AccesstradeAdapter();
registerAdapter(accesstradeAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
// ---------------------------------------------------------------------------

export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  chunkDateRange,
  formatReportDate,
  pickCampaignSegment,
  // Exposed so pagination tests can assert the MAX_PAGES backstop warning.
  log,
  MAX_PAGES,
};
