/**
 * Partnerize (Advertiser) — brand-side adapter.
 *
 * READ-ONLY at v0.1. Mirrors the Impact advertiser adapter's defensive style;
 * read the Awin adapter (src/networks/awin/adapter.ts) for the full cardinal-
 * rule rationale.
 *
 * Partnerize calls brands "Campaigns" internally. One set of credentials
 * (application_key + user_api_key) may own multiple campaigns. This adapter is
 * multi-brand: `listBrands()` calls GET /v3/brand/campaigns to enumerate the
 * campaigns visible to the credential set, and `ctx.networkBrandId` on each
 * subsequent call carries the campaign_id for the brand the caller asked about.
 *
 * Auth: HTTP Basic — Authorization: Basic base64(application_key:user_api_key).
 * Base URL: https://api.partnerize.com (Brand API v3).
 *
 * The Partnerize Brand API docs site (api-docs.partnerize.com/brand) and Apiary
 * mirror returned 403 to automated fetch during both the initial PR and this
 * hardening pass. Endpoint shapes are grounded in: web-search summaries,
 * PerformanceHorizonGroup/apidocs GitHub repository (API Blueprint source files),
 * dltHub context page summaries, and third-party integration guides. Remaining
 * uncertainties are marked `// BLOCKED(verify):` and require a live account.
 * See docs/findings/partnerize-advertiser.md for the full source list.
 *
 * Operations implemented:
 *   listBrands             → GET /v3/brand/campaigns
 *   verifyAuth             → same probe as listBrands (limit=1)
 *   listProgrammes         → same as listBrands (brand's own campaigns)
 *   listMediaPartners      → GET /v3/brand/campaigns/{id}/publishers
 *   getProgrammePerformance→ GET /v3/brand/analytics/metrics + campaign filter
 *   listTransactions       → GET /v3/brand/campaigns/{id}/conversions
 *
 * Pagination: the list operations above page through the upstream `limit` +
 * `offset` pagination (Apiary standard-pagination) to completion when the
 * caller supplies no `limit`, capped at MAX_PAGES with a logged warning so a
 * truncated pull is never silent. A caller-supplied `limit` stops the loop as
 * soon as enough rows have been collected. See `fetchOffsetPages`.
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme        — use listBrands/listProgrammes and filter client-side
 *   getEarningsSummary  — use getProgrammePerformance for the rollup
 *   listClicks          — click-level data not exposed by the Brand API
 *   generateTrackingLink— publisher-side operation; not applicable here
 *   listPublishers      — admin stub
 *   listPublisherSectors— admin stub
 *
 * Cardinal rules:
 *   1. NEVER call fetch directly. Use `partnerizeAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings. The noun is "programme".
 *   5. NEVER issue a non-GET request. The client enforces this.
 *   6. COMPUTE ageDays for every transaction (PRD §15.9).
 */

import { partnerizeAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type AdapterOperation,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DiscoveredBrand,
  type EarningsSummary,
  type MediaPartner,
  type MediaPartnerQuery,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
  type ProgrammeQuery,
  type ProgrammeStatus,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('partnerize-advertiser.adapter');
const NAME = 'Partnerize (Advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnerize.com',
  authModel: 'basic',
  docsUrl: 'https://api-docs.partnerize.com/brand/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Click-level data is not exposed by the Partnerize Brand API; listClicks is unsupported.',
    'getProgramme is not implemented at v0.1; use listProgrammes (listBrands) and filter client-side.',
    'getEarningsSummary is not implemented at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    'generateTrackingLink is a publisher-side operation and is not applicable to the advertiser adapter.',
    'Conversion (transaction) reporting scope is per-campaign and requires a campaign_id context from AdapterCallContext.',
    'listProgrammes, listTransactions, listMediaPartners and getProgrammePerformance page through the upstream limit+offset pagination to completion when no limit is supplied, capped at 50 pages of 100 rows with a logged warning rather than a silent truncation.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // Analytics and conversion endpoints can be slow on large windows — give
  // them more time and an extra retry, same rationale as Impact's report engine.
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  listTransactions: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
};

/** Rows requested per page; matches the previous single-request default `limit`. */
const PAGE_SIZE = 100;
/**
 * Backstop on the offset-pagination loop so a misbehaving upstream (an offset
 * the server ignores, or a total that never reconciles) cannot loop forever.
 * Hitting the cap logs a warning so the truncation is never silent.
 */
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Helpers — ctx requirement, raw shapes, status mapping
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. Missing context
 * means the caller forgot to supply a `brand`, which we surface as a
 * `config_error` so the user sees an actionable hint rather than a TypeError.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Partnerize advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (campaign_id) via brands.json. Call `affiliate_resolve_brand` to see ' +
          'which brands are bound, or run `affiliate-networks-mcp setup partnerize-advertiser`.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Partnerize raw response shapes
// ---------------------------------------------------------------------------

/**
 * One campaign entry from GET /v3/brand/campaigns.
 *
 * Field names confirmed from the PerformanceHorizonGroup/apidocs repository
 * (advertiser.apib, data/campaign.apib) and Partnerize Apiary documentation
 * web-search summaries. The response envelope wraps results in a `campaigns`
 * array with `count` and `execution_time` at the top level.
 *
 * Campaign `status` string values are NOT explicitly enumerated in the public
 * docs; the strings below are sourced from integration guides and must be
 * confirmed against a live Brand account.
 */
interface PartnerizeAdvCampaignRaw {
  campaign_id?: string | number;
  campaign_name?: string;
  // Known status strings from integration guides: 'active', 'paused', 'pending',
  // 'closed'. The v3 Brand API may use different casing or additional values.
  // Source: PerformanceHorizonGroup/apidocs advertiser.apib (status referenced but
  // not enumerated); integration guides confirm 'active'/'paused'.
  // BLOCKED(verify): exact campaign status enum strings from a live Brand account.
  status?: string;
  currency?: string;
  campaign_reference?: string;
  advertiser_url?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvCampaignsEnvelope {
  // Confirmed: response wraps campaigns in a `campaigns` array. Source:
  // PerformanceHorizonGroup/apidocs advertiser.apib.
  campaigns?: PartnerizeAdvCampaignRaw[];
  data?: PartnerizeAdvCampaignRaw[];
  // Pagination: standard Partnerize pagination uses `count` (items in this page),
  // `limit`, `offset`. Hypermedia block may contain `total_item_count`.
  // Source: Partnerize API Apiary introduction/standard-pagination.
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  execution_time?: string;
}

/**
 * One publisher entry from GET /v3/brand/campaigns/{id}/publishers.
 *
 * The canonical Partnerize publisher field name is `publisher_id`; `partner_id`
 * is the v3 alias used in some contexts. Source: PerformanceHorizonGroup/apidocs
 * data/publisher.apib confirms `publisher_id` as the primary identifier.
 *
 * The participating publishers endpoint returns a `publishers` array.
 * Source: PerformanceHorizonGroup/apidocs src/participating_publishers.apib.
 *
 * Publisher status on a campaign ('campaign_status') uses single-letter codes in
 * the older API (a=approved, p=pending, r=rejected) per
 * src/publisher_campaign.apib. The v3 Brand API may return full strings;
 * both forms are handled defensively.
 * BLOCKED(verify): exact `status`/`campaign_status` string values returned by the
 * v3 brand publishers endpoint from a live account.
 */
interface PartnerizeAdvPublisherRaw {
  publisher_id?: string | number;
  partner_id?: string | number;
  publisher_name?: string;
  partner_name?: string;
  account_name?: string;
  // Status on the campaign participation. Confirmed values from apidocs:
  // 'a'/'approved', 'p'/'pending', 'r'/'rejected'. v3 may normalise to full strings.
  status?: string;
  campaign_status?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvPublishersEnvelope {
  // 'publishers' is the confirmed key from participating_publishers.apib.
  publishers?: PartnerizeAdvPublisherRaw[];
  partners?: PartnerizeAdvPublisherRaw[];
  data?: PartnerizeAdvPublisherRaw[];
  count?: number;
}

/**
 * One conversion row from GET /v3/brand/campaigns/{id}/conversions.
 *
 * The conversions/bulk endpoint is documented at:
 * https://api.partnerize.com/v3/brand/campaigns/{campaignID}/conversions/bulk
 *
 * Date field names confirmed from PerformanceHorizonGroup/apidocs
 * src/export_reporting.apib: `click_time`, `click_date`, `click_date_time`,
 * `conversion_date`, `conversion_date_time`. The JSON reporting API uses
 * `conversion_time` per data/reporting.apib. Both are handled defensively.
 *
 * Conversion status confirmed values (data/common.apib): `pending`, `approved`,
 * `rejected`. The v1 API also used single-letter codes ('a', 'p', 'r').
 * `reversed` and `paid` are NOT confirmed in the public schema — they may
 * reflect payment-pipeline state tracked separately.
 * BLOCKED(verify): full set of conversion_status strings from the v3 brand
 * conversions endpoint against a live account.
 *
 * Sale/value fields: confirmed as `value` (or `conversion_value`) and
 * `commission`/`publisher_commission` per data/reporting.apib. The v3 brand
 * endpoint may surface `sale_amount` as an alias; handled defensively.
 */
interface PartnerizeAdvConversionRaw {
  conversion_id?: string | number;
  publisher_id?: string | number;
  partner_id?: string | number;
  campaign_id?: string | number;
  campaign_name?: string;
  // Confirmed status values from data/common.apib: 'pending', 'approved', 'rejected'.
  // Single-letter aliases ('a', 'p', 'r') also handled in mapConversionStatus.
  // BLOCKED(verify): 'reversed' and 'paid' not confirmed against live endpoint.
  status?: string;
  // value / sale_amount: 'value' confirmed by data/reporting.apib; 'sale_amount'
  // used as defensive alias for v3 brand surface.
  value?: string | number;
  sale_amount?: string | number;
  commission?: string | number;
  publisher_commission?: string | number;
  currency?: string;
  // Date fields: 'conversion_time' from data/reporting.apib; 'click_time' and
  // 'conversion_date_time' from export_reporting.apib. All handled defensively.
  click_time?: string;
  click_date?: string;
  click_date_time?: string;
  conversion_time?: string;
  conversion_date?: string;
  conversion_date_time?: string;
  approved_at?: string;
  paid_at?: string;
  rejection_reason?: string;
  reject_reason?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvConversionsEnvelope {
  conversions?: PartnerizeAdvConversionRaw[];
  data?: PartnerizeAdvConversionRaw[];
  total?: number;
}

/**
 * One row from the analytics/metrics endpoint.
 *
 * Endpoint: GET /v3/brand/analytics/metrics
 * Source: dltHub Partnerize context page (data selector "data") confirms the
 * endpoint path and that results are returned under a `data` key.
 *
 * Field names are grounded in data/reporting.apib (confirms `publisher_id`,
 * `publisher_name`, `campaign_id`, `commission`, `value`, `conversion_value`)
 * and export_reporting.apib (confirms `currency`, `click_time`).
 *
 * The date grouping field name for the v3 analytics endpoint is not publicly
 * confirmed; both `date` and `day` are handled defensively.
 * BLOCKED(verify): exact `start_date`/`end_date` parameter names and the date
 * grouping field name in the analytics response from a live account. The
 * aggregated reporting API uses `start_date`/`end_date` (ISO 8601) per
 * src/aggregated_reporting.apib, so the same names are assumed for v3.
 */
interface PartnerizeAdvMetricRowRaw {
  // Aggregated date for this row. May be 'date', 'day', or 'period'.
  // BLOCKED(verify): exact key name from a live analytics response.
  date?: string;
  day?: string;
  publisher_id?: string | number;
  partner_id?: string | number;
  publisher_name?: string;
  partner_name?: string;
  account_name?: string;
  clicks?: string | number;
  // 'conversions' or 'actions' depending on campaign conversion type.
  conversions?: string | number;
  actions?: string | number;
  // Value / commission: confirmed field names from data/reporting.apib.
  value?: string | number;
  sale_amount?: string | number;
  commission?: string | number;
  publisher_commission?: string | number;
  currency?: string;
  // Status may not be present on aggregated rows.
  status?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvMetricsEnvelope {
  data?: PartnerizeAdvMetricRowRaw[];
  rows?: PartnerizeAdvMetricRowRaw[];
  metrics?: PartnerizeAdvMetricRowRaw[];
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapCampaignStatus(raw: PartnerizeAdvCampaignRaw): ProgrammeStatus {
  const s = String(raw.status ?? '').toLowerCase();
  // Campaign status strings are not explicitly enumerated in the public Partnerize
  // docs (PerformanceHorizonGroup/apidocs data/campaign.apib references a Status
  // type but does not list values). Strings below are sourced from integration
  // guides and the Partnerize help centre and should be confirmed live.
  // BLOCKED(verify): exact campaign status strings from a live Brand account.
  if (s === 'active' || s === 'live' || s === 'running') return 'joined';
  if (s === 'pending' || s === 'pending_approval') return 'pending';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'closed' || s === 'inactive' || s === 'archived') return 'suspended';
  return 'unknown';
}

function mapConversionStatus(raw: PartnerizeAdvConversionRaw): TransactionStatus {
  const s = String(raw.status ?? '').toLowerCase();
  // Confirmed conversion status values from PerformanceHorizonGroup/apidocs
  // data/common.apib "Conversion Status" enum: 'pending', 'approved', 'rejected'.
  // The v1 API also used single-letter codes ('a'=approved, 'p'=pending, 'r'=rejected);
  // both forms are handled.
  // 'reversed' and 'paid' are NOT confirmed in the public schema; they are included
  // defensively but must be verified against a live account.
  // BLOCKED(verify): full conversion_status string set from a live Brand account.
  if (s === 'pending' || s === 'p' || s === 'new') return 'pending';
  if (s === 'approved' || s === 'a' || s === 'validated' || s === 'accepted') return 'approved';
  if (s === 'rejected' || s === 'r' || s === 'reversed' || s === 'cancelled' || s === 'declined') return 'reversed';
  if (s === 'paid') return 'paid';
  return 'other';
}

function mapPublisherStatus(raw: PartnerizeAdvPublisherRaw): MediaPartner['status'] {
  // Use campaign_status (publisher's participation status on the campaign) if
  // present; fall back to the top-level status field.
  // Source: PerformanceHorizonGroup/apidocs src/publisher_campaign.apib and
  // src/participating_publishers.apib confirm `campaign_status` field.
  const s = String(raw.campaign_status ?? raw.status ?? '').toLowerCase();
  // Confirmed single-letter codes from publisher_campaign.apib: 'a'=approved,
  // 'p'=pending, 'r'=rejected. Full strings also handled for v3 normalisation.
  // Source for network-level status: data/publisher.apib confirms 'active',
  // 'inactive', and auto-rejected-from-campaigns on rejection.
  // BLOCKED(verify): exact status string format returned by the v3 brand
  // publishers endpoint from a live account.
  if (s === 'active' || s === 'approved' || s === 'a' || s === 'live') return 'active';
  if (s === 'pending' || s === 'p' || s === 'pending_approval') return 'pending';
  if (s === 'inactive' || s === 'paused' || s === 'declined' || s === 'rejected' || s === 'r') return 'inactive';
  return 'unknown';
}

function mapMetricRowStatus(raw: PartnerizeAdvMetricRowRaw): ProgrammePerformanceRow['status'] {
  const s = String(raw.status ?? '').toLowerCase();
  if (s === 'approved' || s === 'validated' || s === 'paid') return 'approved';
  if (s === 'rejected' || s === 'reversed' || s === 'cancelled') return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Number / date coercers
// ---------------------------------------------------------------------------

function toNumber(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  const candidate = input.trim();
  if (candidate === '') return undefined;
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

function computeAgeDays(raw: PartnerizeAdvConversionRaw, now: Date = new Date()): number {
  // Anchor on approved_at first (age of the "approved but unpaid" state —
  // the most useful affordance per PRD §15.9). Fall back to any confirmed
  // conversion date field alias. Source: export_reporting.apib confirms
  // conversion_date_time, conversion_date; data/reporting.apib confirms
  // conversion_time.
  const anchor =
    raw.approved_at ??
    raw.conversion_time ??
    raw.conversion_date_time ??
    raw.conversion_date;
  const parsed = parseDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  const ms = now.getTime() - ts;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: PartnerizeAdvCampaignRaw): Programme {
  const id = String(raw.campaign_id ?? '');
  return {
    id,
    name: raw.campaign_name ?? `Partnerize campaign ${id}`,
    network: SLUG,
    status: mapCampaignStatus(raw),
    currency: typeof raw.currency === 'string' ? raw.currency : undefined,
    advertiserUrl: typeof raw.advertiser_url === 'string' ? raw.advertiser_url : undefined,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: PartnerizeAdvConversionRaw, now: Date = new Date()): Transaction {
  const status = mapConversionStatus(raw);
  // Commission: 'commission' is the confirmed field from data/reporting.apib;
  // 'publisher_commission' is an alias for the publisher-facing value.
  const commission = toNumber(raw.commission ?? raw.publisher_commission);
  // Sale amount: 'value' is confirmed from data/reporting.apib;
  // 'sale_amount' handled as a v3 brand alias.
  const sale = toNumber(raw.sale_amount ?? raw.value);
  const currency = typeof raw.currency === 'string' ? raw.currency : 'USD';

  // Date field resolution: data/reporting.apib confirms `conversion_time`;
  // export_reporting.apib confirms `conversion_date_time`, `conversion_date`,
  // `click_time`, `click_date`, `click_date_time`. All handled defensively.
  const conversionDate =
    parseDate(raw.conversion_time) ??
    parseDate(raw.conversion_date_time) ??
    parseDate(raw.conversion_date) ??
    new Date(0).toISOString();
  const clickDate =
    parseDate(raw.click_time) ??
    parseDate(raw.click_date_time) ??
    parseDate(raw.click_date);
  const approvedDate = parseDate(raw.approved_at);
  const paidDate = parseDate(raw.paid_at);

  // Reversal reason: 'rejection_reason' used in older docs; 'reject_reason'
  // confirmed in campaign_conversion.apib. Both handled.
  const reversalReasonRaw = raw.rejection_reason ?? raw.reject_reason;

  return {
    id: String(raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign_id ?? ''),
    programmeName: typeof raw.campaign_name === 'string' ? raw.campaign_name : '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: conversionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? (typeof reversalReasonRaw === 'string' ? reversalReasonRaw : undefined)
        : undefined,
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: PartnerizeAdvPublisherRaw): MediaPartner {
  // publisher_id is the primary identifier (confirmed: data/publisher.apib).
  // partner_id is a v3 alias used interchangeably.
  const id = String(raw.publisher_id ?? raw.partner_id ?? '');
  // publisher_name / account_name are confirmed from data/publisher.apib.
  // partner_name is a v3 alias.
  const name =
    (typeof raw.publisher_name === 'string' ? raw.publisher_name : undefined) ??
    (typeof raw.partner_name === 'string' ? raw.partner_name : undefined) ??
    (typeof raw.account_name === 'string' ? raw.account_name : undefined) ??
    `Partnerize publisher ${id}`;
  return {
    id,
    name,
    status: mapPublisherStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(raw: PartnerizeAdvMetricRowRaw): ProgrammePerformanceRow {
  const rawDate = (typeof raw.date === 'string' ? raw.date : undefined) ??
    (typeof raw.day === 'string' ? raw.day : undefined) ?? '';
  let date = '';
  if (rawDate) {
    const parsed = parseDate(rawDate);
    if (parsed) {
      date = parsed.slice(0, 10);
    } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(rawDate)) {
      date = rawDate;
    }
  }

  const publisherId = String(raw.publisher_id ?? raw.partner_id ?? '');
  const publisherName =
    (typeof raw.publisher_name === 'string' ? raw.publisher_name : undefined) ??
    (typeof raw.partner_name === 'string' ? raw.partner_name : undefined) ??
    '';

  return {
    date,
    publisherId,
    publisherName,
    clicks: toNumber(raw.clicks),
    conversions: toNumber(raw.conversions ?? raw.actions),
    // Gross sale: 'value' confirmed by data/reporting.apib; 'sale_amount' as alias.
    grossSale: toNumber(raw.sale_amount ?? raw.value),
    // Commission: 'commission' and 'publisher_commission' confirmed by data/reporting.apib.
    commission: toNumber(raw.commission ?? raw.publisher_commission),
    currency: typeof raw.currency === 'string' ? raw.currency : 'USD',
    status: mapMetricRowStatus(raw),
    rawNetworkData: raw,
  };
}

function toDiscoveredBrand(raw: PartnerizeAdvCampaignRaw): DiscoveredBrand {
  const id = String(raw.campaign_id ?? '');
  const name = raw.campaign_name ?? `Partnerize campaign ${id}`;
  // Partnerize does not expose an explicit apiEnabled flag on campaigns in the
  // public docs; apiEnabled is derived from status. Only active/live campaigns are
  // treated as fully addressable. Paused campaigns may still return historical
  // conversions — the Brand API does not explicitly block queries on paused
  // campaigns per the public docs; this is a conservative default.
  // BLOCKED(verify): whether a paused campaign blocks conversion queries on the
  // live API. Set apiEnabled=true for paused to allow historical queries if
  // confirmed against a live account.
  const status = String(raw.status ?? '').toLowerCase();
  const apiEnabled = status === '' || status === 'active' || status === 'live' || status === 'running';
  return {
    networkBrandId: id,
    displayName: typeof name === 'string' ? name : `Partnerize campaign ${id}`,
    apiEnabled,
  };
}

// ---------------------------------------------------------------------------
// List extraction helpers
// ---------------------------------------------------------------------------

function extractCampaigns(
  env: PartnerizeAdvCampaignsEnvelope | PartnerizeAdvCampaignRaw[],
): PartnerizeAdvCampaignRaw[] {
  if (Array.isArray(env)) return env;
  return env.campaigns ?? env.data ?? [];
}

function extractPublishers(
  env: PartnerizeAdvPublishersEnvelope | PartnerizeAdvPublisherRaw[],
): PartnerizeAdvPublisherRaw[] {
  if (Array.isArray(env)) return env;
  return env.publishers ?? env.partners ?? env.data ?? [];
}

function extractConversions(
  env: PartnerizeAdvConversionsEnvelope | PartnerizeAdvConversionRaw[],
): PartnerizeAdvConversionRaw[] {
  if (Array.isArray(env)) return env;
  return env.conversions ?? env.data ?? [];
}

function extractMetricRows(
  env: PartnerizeAdvMetricsEnvelope | PartnerizeAdvMetricRowRaw[],
): PartnerizeAdvMetricRowRaw[] {
  if (Array.isArray(env)) return env;
  return env.data ?? env.rows ?? env.metrics ?? [];
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Read the reported total row count from a Partnerize list envelope.
 *
 * Standard Partnerize pagination reports `limit`, `offset` and a per-page
 * `count`; the overall total surfaces in the hypermedia block as
 * `total_item_count`. Source: Partnerize Apiary introduction/standard-pagination
 * (see docs/findings/partnerize-advertiser.md). A top-level `total` is also
 * read defensively — the existing conversions fixture shape uses it.
 *
 * Returns undefined when no total is reported; the pagination loop then falls
 * back to the short-page stop rule.
 * BLOCKED(verify): exact placement of the total field on each v3 brand
 * endpoint requires a live Brand account.
 */
function readReportedTotal(env: unknown): number | undefined {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const e = env as {
    total?: string | number;
    hypermedia?: {
      total_item_count?: string | number;
      pagination?: { total_item_count?: string | number };
    };
  };
  const candidate =
    e.hypermedia?.pagination?.total_item_count ?? e.hypermedia?.total_item_count ?? e.total;
  if (candidate === undefined || candidate === null) return undefined;
  const n = Number(candidate);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PartnerizeAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // Internal: page through an offset-paginated Partnerize list endpoint.
  // -------------------------------------------------------------------------

  /**
   * Fetch pages of an offset-paginated Partnerize list endpoint.
   *
   * Standard Partnerize pagination is `limit` + `offset` (Apiary
   * standard-pagination; see docs/findings/partnerize-advertiser.md). Each call
   * requests PAGE_SIZE rows. The loop continues while the reported
   * `total_item_count` (or top-level `total`) says more rows remain — the
   * server may clamp `limit` below what we asked for — or, when no total is
   * reported, while full pages keep coming back. It is capped at MAX_PAGES with
   * a logged warning so a truncated pull is never silent (principle 4.1).
   *
   * When `target` is set (the caller passed `query.limit`), the loop stops as
   * soon as `target` rows have been collected. This mirrors the previous
   * single-request behaviour without ever pulling fewer rows than before.
   */
  private async fetchOffsetPages<TEnvelope, TRaw>(
    operation: AdapterOperation,
    path: string,
    baseQuery: Record<string, string | number | undefined>,
    extract: (env: TEnvelope | TRaw[]) => TRaw[],
    target?: number,
  ): Promise<TRaw[]> {
    const resilience = RESILIENCE[operation] ?? RESILIENCE.default;
    const out: TRaw[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const envelope = await partnerizeAdvRequest<TEnvelope | TRaw[]>({
        operation,
        path,
        query: { ...baseQuery, limit: PAGE_SIZE, offset },
        resilience,
      });
      const batch = extract(envelope);
      out.push(...batch);
      if (batch.length === 0) return out;
      // Caller's limit satisfied — stop early (backward-compatible behaviour).
      if (typeof target === 'number' && out.length >= target) return out;
      const total = readReportedTotal(envelope);
      if (typeof total === 'number' && out.length >= total) return out;
      // No total reported: a short page means the upstream is exhausted.
      if (total === undefined && batch.length < PAGE_SIZE) return out;
      offset += batch.length;
    }
    log.warn(
      { operation, cap: MAX_PAGES, pageSize: PAGE_SIZE, fetched: out.length },
      'partnerize-advertiser pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  // -------------------------------------------------------------------------
  // listBrands — multi-brand discovery hook.
  // -------------------------------------------------------------------------

  /**
   * List the campaigns (brands) visible to the configured credential set.
   *
   * Calls GET /v3/brand/campaigns and maps each campaign to a DiscoveredBrand.
   * `apiEnabled` is true for active campaigns; paused or closed campaigns are
   * included but marked apiEnabled=false as a hint to the wizard's tick-box UI.
   *
   * Response envelope: confirmed to wrap results in a `campaigns` array with
   * `count` and `execution_time` at the top level. Source:
   * PerformanceHorizonGroup/apidocs src/advertiser.apib.
   *
   * Pagination: standard Partnerize pagination uses `limit` and `offset`.
   * Source: Partnerize Apiary introduction/standard-pagination.
   *
   * BLOCKED(verify): campaign status string values and whether paused campaigns
   * can still be queried for conversions require a live Brand account.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvCampaignsEnvelope | PartnerizeAdvCampaignRaw[]
    >({
      operation: 'verifyAuth',
      path: '/v3/brand/campaigns',
      query: { limit: 100 },
      resilience: RESILIENCE.default,
    });
    const list = extractCampaigns(envelope);
    return list.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) {
      return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — brand's own campaigns.
  // -------------------------------------------------------------------------

  /**
   * For the advertiser-side adapter, "programmes" are the brand's own campaigns.
   * This is the same data as `listBrands()` but returned as `Programme[]` in
   * the canonical shape.
   *
   * Unlike publisher-side adapters, this does NOT require a `ctx.networkBrandId`
   * (the call lists ALL campaigns for the credential set). A ctx is accepted for
   * interface compatibility but is not used.
   *
   * Pagination: pages through `limit` + `offset` via `fetchOffsetPages`. With
   * no `query.limit` the pull runs to completion (MAX_PAGES backstop); with a
   * `query.limit` the loop stops once enough campaigns have been collected.
   */
  async listProgrammes(
    query?: ProgrammeQuery,
    _ctx?: AdapterCallContext,
  ): Promise<Programme[]> {
    const list = await this.fetchOffsetPages<
      PartnerizeAdvCampaignsEnvelope,
      PartnerizeAdvCampaignRaw
    >('listProgrammes', '/v3/brand/campaigns', {}, extractCampaigns, query?.limit);
    let programmes = list.map(toProgramme);
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — brand's conversions for a specific campaign.
  // -------------------------------------------------------------------------

  /**
   * Fetch conversions for the campaign identified by `ctx.networkBrandId`.
   *
   * Endpoint: GET /v3/brand/campaigns/{campaign_id}/conversions
   *
   * Date filter parameters: `start_date` and `end_date` confirmed as the
   * standard parameter names across Partnerize reporting endpoints. Source:
   * PerformanceHorizonGroup/apidocs src/aggregated_reporting.apib and
   * src/export_reporting.apib (both use `start_date`/`end_date` in ISO 8601).
   *
   * Pagination: pages through `limit` + `offset` via `fetchOffsetPages`. With
   * no `query.limit` the pull runs to completion (MAX_PAGES backstop); with a
   * `query.limit` the loop stops once enough conversions have been collected.
   *
   * BLOCKED(verify): the v3 brand conversions endpoint-specific parameter names
   * and any status-filter parameter require a live Brand account.
   */
  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const now = new Date();

    const list = await this.fetchOffsetPages<
      PartnerizeAdvConversionsEnvelope,
      PartnerizeAdvConversionRaw
    >(
      'listTransactions',
      `/v3/brand/campaigns/${encodeURIComponent(c.networkBrandId)}/conversions`,
      {
        // start_date / end_date confirmed as standard parameter names.
        // Source: PerformanceHorizonGroup/apidocs aggregated_reporting.apib.
        start_date: query?.from,
        end_date: query?.to,
      },
      extractConversions,
      query?.limit,
    );
    let txns = list.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      txns = txns.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      txns = txns.filter((t) => set.has(t.status));
    }

    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') {
      txns = txns.filter((t) => t.ageDays >= minAge);
    }
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') {
      txns = txns.filter((t) => t.ageDays <= maxAge);
    }

    if (typeof query?.limit === 'number') txns = txns.slice(0, query.limit);
    return txns;
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — publishers on the brand's campaign.
  // -------------------------------------------------------------------------

  /**
   * Fetch publishers (partners) active on a specific campaign.
   *
   * Endpoint: GET /v3/brand/campaigns/{campaign_id}/publishers
   *
   * Path: the confirmed endpoint in the Partnerize API docs is
   * `/campaign/{campaign_id}/publisher` (singular). In the v3 brand context the
   * equivalent is `/v3/brand/campaigns/{id}/publishers`. Both singular and plural
   * forms are plausible; the plural form is used here to match v3 URL conventions
   * (`/campaigns`, `/conversions` are also plural).
   * BLOCKED(verify): `/publishers` vs `/publisher` requires a live Brand account.
   *
   * Pagination: pages through `limit` + `offset` via `fetchOffsetPages`. With
   * no `query.limit` the pull runs to completion (MAX_PAGES backstop); with a
   * `query.limit` the loop stops once enough publishers have been collected.
   */
  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const c = requireCtx('listMediaPartners', ctx);

    const list = await this.fetchOffsetPages<
      PartnerizeAdvPublishersEnvelope,
      PartnerizeAdvPublisherRaw
    >(
      'listMediaPartners',
      `/v3/brand/campaigns/${encodeURIComponent(c.networkBrandId)}/publishers`,
      {},
      extractPublishers,
      query?.limit,
    );
    let partners = list.map(toMediaPartner);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }

    if (typeof query?.limit === 'number') partners = partners.slice(0, query.limit);
    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — analytics rollup per publisher.
  // -------------------------------------------------------------------------

  /**
   * Fetch per-publisher analytics for the campaign identified by
   * `ctx.networkBrandId` (or a query-specified `programmeId`).
   *
   * Endpoint: GET /v3/brand/analytics/metrics
   *
   * Query parameters: `start_date`/`end_date` are the confirmed date parameter
   * names for Partnerize reporting. Source: aggregated_reporting.apib.
   * `campaign_id` and `publisher_id` are the confirmed filter field names.
   * Source: granular_reporting.apib and aggregated_reporting.apib.
   *
   * Response envelope: the v3 brand analytics endpoint returns results under a
   * `data` key. Source: dltHub Partnerize context page (data_selector="data").
   *
   * Pagination: pages through `limit` + `offset` via `fetchOffsetPages`. With
   * no `query.limit` the pull runs to completion (MAX_PAGES backstop); with a
   * `query.limit` the loop stops once enough rows have been collected.
   *
   * BLOCKED(verify): the exact parameter names specific to the v3
   * /analytics/metrics endpoint and the date grouping field name in the
   * response require a live Brand account.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);

    const rows = await this.fetchOffsetPages<
      PartnerizeAdvMetricsEnvelope,
      PartnerizeAdvMetricRowRaw
    >(
      'getProgrammePerformance',
      '/v3/brand/analytics/metrics',
      {
        // campaign_id / publisher_id confirmed from granular_reporting.apib.
        // start_date / end_date confirmed from aggregated_reporting.apib.
        campaign_id: query?.programmeId ?? c.networkBrandId,
        publisher_id: query?.publisherId,
        start_date: query?.from,
        end_date: query?.to,
      },
      extractMetricRows,
      query?.limit,
    );
    let mapped = rows.map(toPerformanceRow);
    if (typeof query?.limit === 'number') mapped = mapped.slice(0, query.limit);
    return mapped;
  }

  // -------------------------------------------------------------------------
  // Ops NOT implemented at v0.1 — explicit NotImplementedError with reason.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Partnerize advertiser adapter does not implement getProgramme at v0.1; ' +
        'use listProgrammes to enumerate campaigns and filter client-side.',
    );
  }

  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Partnerize advertiser adapter does not implement getEarningsSummary at v0.1; ' +
        'use getProgrammePerformance for the per-publisher commission rollup.',
    );
  }

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Click-level data is not exposed by the Partnerize Brand API; ' +
        'use getProgrammePerformance for aggregated click counts per publisher.',
    );
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Tracking link generation is a publisher-side operation and is not ' +
        'applicable to the Partnerize advertiser adapter.',
    );
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster on a campaign.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError(
      'listPublisherSectors is not implemented for Partnerize advertiser at v0.1.',
    );
  }

  // -------------------------------------------------------------------------
  // Setup + diagnostics
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    operations['verifyAuth'] = {
      supported: true,
      note: 'Live probe runs at wizard time; not re-probed here to avoid network calls during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Multi-brand discovery hook via GET /v3/brand/campaigns.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Returns the credential set\'s campaigns via GET /v3/brand/campaigns.',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'Conversions per campaign via GET /v3/brand/campaigns/{id}/conversions. Requires ctx.networkBrandId.',
      claimStatus: 'experimental',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'Publishers per campaign via GET /v3/brand/campaigns/{id}/publishers. Requires ctx.networkBrandId.',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Analytics via GET /v3/brand/analytics/metrics. Parameter names grounded in public docs (start_date/end_date, campaign_id, publisher_id). Response data selector confirmed as "data". Verify exact field names against a live account.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Not implemented at v0.1; use listProgrammes and filter client-side.',
    };
    operations['getEarningsSummary'] = {
      supported: false,
      note: 'Not implemented at v0.1; use getProgrammePerformance for the rollup.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Click-level data is not exposed by the Partnerize Brand API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Publisher-side operation; not applicable to the advertiser adapter.',
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

export const partnerizeAdvertiserAdapter = new PartnerizeAdvertiserAdapter();
registerAdapter(partnerizeAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers
// ---------------------------------------------------------------------------

export const _internals = {
  // Module logger, exposed so tests can spy on the MAX_PAGES cap warning.
  log,
  readReportedTotal,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  toDiscoveredBrand,
  mapCampaignStatus,
  mapConversionStatus,
  mapPublisherStatus,
  mapMetricRowStatus,
  parseDate,
  computeAgeDays,
  extractCampaigns,
  extractPublishers,
  extractConversions,
  extractMetricRows,
};
