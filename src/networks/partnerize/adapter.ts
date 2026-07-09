/**
 * Partnerize adapter — publisher-side implementation for affiliate-mcp.
 *
 * READ ME FIRST (future Claude Code agents reading this file):
 *
 * This file follows the canonical pattern established in `src/networks/awin/adapter.ts`.
 * The Awin file is the primary reference; read it before reading this one. Comments
 * in this file focus on Partnerize-specific decisions rather than repeating the
 * pattern rationale.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes        — campaigns the publisher is approved for.
 *   getProgramme          — single campaign by ID.
 *   listTransactions      — conversion reporting via granular report endpoint.
 *   getEarningsSummary    — derived from listTransactions (same rationale as Awin).
 *   listClicks            — click data from publisher click reporting endpoint.
 *   generateTrackingLink  — deterministic camref-based prf.hn deep-link.
 *   verifyAuth            — GET /user/publisher to validate credentials + derive publisher ID.
 *
 * --- Partnerize API map (based on public API blueprint at
 *     https://github.com/PerformanceHorizonGroup/apidocs) ----------------------
 *
 *   GET  /user/publisher/{publisher_id}/campaign/{status}
 *     → campaigns the publisher is associated with; status: a=approved, p=pending, r=rejected.
 *
 *   GET  /reporting/report_publisher/publisher/{publisher_id}/conversion
 *     ?start_date=ISO &end_date=ISO &date_type=standard &timezone=UTC
 *     → conversions; cursor-paginated via the `cursor_id` RESPONSE HEADER,
 *       echoed back as a `cursor_id` query parameter for the next page.
 *
 *   GET  /reporting/report_publisher/publisher/{publisher_id}/click
 *     ?start_date=ISO &end_date=ISO
 *     → click records; same `cursor_id` header continuation.
 *
 *   Pagination: the reporting endpoints above follow `cursor_id` continuation
 *   to completion; the campaign list uses standard `limit`/`offset` pages.
 *   Both are capped at MAX_PAGES with a logged warning so a truncated pull is
 *   never silent (principle 4.1).
 *
 *   GET  /user/publisher
 *     → list of publisher accounts; used by verifyAuth to derive PARTNERIZE_PUBLISHER_ID.
 *
 * --- Auth model --------------------------------------------------------------
 *
 *   HTTP Basic: Authorization: Basic base64(application_key:user_api_key).
 *   Credentials: PARTNERIZE_APPLICATION_KEY, PARTNERIZE_USER_API_KEY.
 *   Publisher ID: PARTNERIZE_PUBLISHER_ID (path segment in every reporting call).
 *
 * --- Tracking link format (verified via public Partnerize documentation) -----
 *
 *   https://prf.hn/click/camref:{camref}/destination:{encodedUrl}
 *
 *   The camref is a per-publisher, per-campaign identifier obtained from the
 *   campaign tracking details endpoint. The publisher supplies it as input
 *   (equivalent to Awin's programmeId acting as the tracking identifier).
 *
 * --- Cardinal rules ---------------------------------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `partnerizeRequest` from `./client.ts`.
 *   2. EVERY failure must round-trip through a `NetworkErrorEnvelope` with
 *      `network`, `operation`, `httpStatus`, and the verbatim `networkErrorBody`.
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Document the mapping.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string. "Programme" not "program".
 */

import { partnerizeRequest, partnerizeRequestWithCursor } from './client.js';
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

const log = createLogger('partnerize.adapter');

const SLUG = 'partnerize';
const NAME = 'Partnerize';

/**
 * Pagination backstop. Wide pulls loop page by page (cursor continuation on
 * the reporting endpoints, limit/offset on the campaign list) until the
 * upstream signals completion; MAX_PAGES caps a misbehaving upstream (for
 * example, a cursor that never terminates) and the cap is logged so a
 * truncated pull is never silent (principle 4.1).
 */
const MAX_PAGES = 50;

/**
 * Page size for the limit/offset-paginated campaign list. 100 matches the
 * page size the partnerize-advertiser adapter uses against the same standard
 * pagination scheme (Apiary standard-pagination).
 */
const PROGRAMME_PAGE_SIZE = 100;

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnerize.com',
  authModel: 'basic',
  docsUrl: 'https://api-docs.partnerize.com/partner/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  // `experimental`: adapter is built from public API documentation and has not
  // been validated against a live publisher account. Bump to `partial` after
  // the diagnostic passes with real credentials.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listClicks is experimental: the publisher click endpoint is documented but response field names are unconfirmed; may require adjustment after live testing.',
    'generateTrackingLink requires the caller to supply the camref (campaign reference) for the target campaign, not the raw campaign_id. Camrefs can be found at the campaign tracking details endpoint.',
    'Reporting pagination is cursor-based: wide pulls follow the cursor_id response header to completion, and the campaign list pages via limit/offset. Both are capped at MAX_PAGES with a logged warning rather than a silent truncation.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * listTransactions is the slowest op because the reporting endpoint processes
 * conversion records across a date range. We give it 60s (matching Awin) and
 * an extra retry for transient gateway failures.
 */
const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Partnerize response shapes (intentionally minimal)
// ---------------------------------------------------------------------------
//
// We do not use strict Zod schemas for the same reason as Awin: Partnerize's
// surface drifts and hard schemas break first. Every transformer reads every
// field defensively and preserves the original under `rawNetworkData`.
//
// All field names are sourced from the public Partnerize API blueprint at
// https://github.com/PerformanceHorizonGroup/apidocs and from the export
// reporting documentation. Fields confirmed from the blueprint are annotated;
// remaining uncertainties are annotated "Blocked" with the specific credential/tier needed.
// ---------------------------------------------------------------------------

interface PartnerizeCampaignRaw {
  campaign_id?: string;              // Confirmed string (e.g. "10l176") — export_reporting.apib sample row
  campaign_title?: string;           // Confirmed field name — export_reporting.apib conversion CSV header
  campaign_name?: string;            // Alternative field name — kept as fallback for older API responses
  status?: string;                   // Participation status inferred from path segment
  approval_state?: string;           // Possible response field; exact name unconfirmed (blocked: needs live credentials)
  currency?: string;
  // Commission information — Partnerize returns nested commission structures.
  default_commission?: {
    type?: string;
    value?: string;                  // May be numeric string; export_reporting sample shows "0.9092" as string
    value_type?: string;             // e.g. 'percentage' | 'fixed'
  };
  tracking_url?: string;             // Field name not documented in public blueprints; kept as best-guess
  camref?: string;                   // Publisher-specific campaign reference — confirmed in export_reporting.apib
  url?: string;                      // Advertiser URL
  [key: string]: unknown;
}

interface PartnerizeCampaignListResponse {
  campaigns?: {
    campaign?: PartnerizeCampaignRaw[] | PartnerizeCampaignRaw;
  };
  // Some response shapes return the array at the top level.
  campaign?: PartnerizeCampaignRaw[];
}

/**
 * Conversion row shape from the granular reporting endpoint.
 *
 * All field names confirmed from export_reporting.apib (CSV column headers) at
 * https://github.com/PerformanceHorizonGroup/apidocs/blob/master/src/export_reporting.apib.
 * The JSON reporting endpoint is expected to return the same field names. Not
 * confirmed against a live JSON response (blocked: requires live credentials).
 *
 * Confirmed CSV column order from export_reporting.apib:
 *   conversion_id, campaign_id, publisher_id, conversion_date, conversion_date_time,
 *   click_time, click_date, click_date_time, currency, advertiser_reference,
 *   conversion_reference, referer_ip, source_referer, campaign_title, publisher_name,
 *   conversion_status, conversion_lag, value, commission, publisher_commission,
 *   creative_type, creative_id, specific_creative_id, customer_type, was_disputed,
 *   cookie_id, country, currency_original, currency_conversion_rate,
 *   customer_reference, camref
 */
interface PartnerizeConversionRaw {
  conversion_id?: string;
  campaign_id?: string;
  publisher_id?: string;
  conversion_date?: string;          // YYYY-MM-DD — confirmed in export_reporting.apib
  conversion_date_time?: string;     // datetime — confirmed in export_reporting.apib
  click_time?: string;               // datetime — confirmed in export_reporting.apib
  click_date?: string;               // YYYY-MM-DD — confirmed in export_reporting.apib
  click_date_time?: string;          // datetime — confirmed in export_reporting.apib
  currency?: string;
  conversion_reference?: string;     // advertiser's order reference — confirmed
  campaign_title?: string;           // campaign name — confirmed in export_reporting.apib
  publisher_name?: string;
  conversion_status?: string;        // 'approved' | 'pending' | 'rejected'; 'paid' not documented in public blueprints
  conversion_lag?: string | number;  // numeric, units unknown (example: 626 — likely minutes, not confirmed)
  value?: string | number;           // gross order value — confirmed in export_reporting.apib
  commission?: string | number;      // advertiser-side commission — confirmed in export_reporting.apib
  publisher_commission?: string | number; // publisher's actual commission — confirmed in export_reporting.apib
  camref?: string;                   // confirmed in export_reporting.apib
  // Note: reject_reason is documented on CONVERSION ITEMS (item-level), not on the
  // top-level conversion row in export_reporting.apib. It may still appear on the
  // JSON granular reporting endpoint's conversion objects; kept here defensively.
  reject_reason?: string;            // on conversion_items in export; presence on conversion row unconfirmed
  country?: string;
  [key: string]: unknown;
}

interface PartnerizeConversionListResponse {
  conversions?: {
    conversion?: PartnerizeConversionRaw[] | PartnerizeConversionRaw;
  };
  // Flat array variant.
  conversion?: PartnerizeConversionRaw[];
  // Pagination: cursor_id is returned as a RESPONSE HEADER (not body), per granular_reporting.apib.
  // The `count` field may appear in the body; its presence is unconfirmed from public docs alone.
  count?: number;
  [key: string]: unknown;
}

/**
 * Click row shape from the publisher click reporting endpoint.
 *
 * Field names confirmed from export_reporting.apib click CSV column headers:
 *   click_id, cookie_id, campaign_id, publisher_id, status, set_time, set_ip,
 *   last_used, last_ip, advertiser_reference, referer, creative_id, creative_type,
 *   specific_creative_id, country, publisher_name
 *
 * CONFIRMED ABSENT: there is no `destination_url` or `landing_url` field in the
 * click export schema — export_reporting.apib click CSV does not include it.
 * The JSON granular reporting endpoint may differ; this is blocked pending live credentials.
 */
interface PartnerizeClickRaw {
  click_id?: string;                 // confirmed in export_reporting.apib
  cookie_id?: string;                // confirmed in export_reporting.apib
  campaign_id?: string;              // confirmed in export_reporting.apib
  publisher_id?: string;             // confirmed in export_reporting.apib
  set_time?: string;                 // confirmed in export_reporting.apib — datetime string
  last_used?: string;                // confirmed in export_reporting.apib — datetime string
  referer?: string;                  // confirmed in export_reporting.apib
  publisher_name?: string;           // confirmed in export_reporting.apib
  status?: string;                   // confirmed in export_reporting.apib; sample value: "nibbled"
  [key: string]: unknown;
}

interface PartnerizeClickListResponse {
  clicks?: {
    click?: PartnerizeClickRaw[] | PartnerizeClickRaw;
  };
  click?: PartnerizeClickRaw[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireApplicationKey(operation: string): string {
  return requireCredential('PARTNERIZE_APPLICATION_KEY', {
    network: SLUG,
    operation,
    hint: 'Run `affiliate-networks-mcp setup` and supply your Partnerize Application Key.',
  });
}

function requireUserApiKey(operation: string): string {
  return requireCredential('PARTNERIZE_USER_API_KEY', {
    network: SLUG,
    operation,
    hint: 'Run `affiliate-networks-mcp setup` and supply your Partnerize User API Key.',
  });
}

function requirePublisherId(operation: string): string {
  return requireCredential('PARTNERIZE_PUBLISHER_ID', {
    network: SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup` — the wizard derives PARTNERIZE_PUBLISHER_ID automatically, ' +
      'or set it manually in ~/.affiliate-mcp/.env.',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Partnerize → canonical TransactionStatus.
 *
 * Partnerize uses `conversion_status` with values from the reporting endpoint.
 * Based on public documentation and API blueprint:
 *
 *   approved    → 'approved'
 *   pending     → 'pending'
 *   rejected    → 'reversed'  (rejected by advertiser = reversed commission)
 *   paid        → 'paid'      (not documented in public blueprints; search results show
 *                              only approved/pending/rejected/mixed as filter values;
 *                              kept for defensive compatibility in case live API returns it)
 *   anything else → 'other'
 *
 * Why 'rejected' maps to 'reversed': Partnerize's terminology is "rejected"
 * where other networks say "declined" or "reversed". The user-facing intent is
 * identical — the publisher was not paid for this conversion.
 */
function mapTransactionStatus(raw: PartnerizeConversionRaw): TransactionStatus {
  const s = (raw.conversion_status ?? '').toLowerCase();
  switch (s) {
    case 'approved':
      return 'approved';
    case 'pending':
      return 'pending';
    case 'rejected':
    case 'declined':
    case 'reversed':
      // Partnerize's "rejected" is our "reversed". See note above.
      return 'reversed';
    case 'paid':
      return 'paid';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Partnerize campaign status → canonical ProgrammeStatus.
 *
 * Partnerize exposes campaign participation via a status path segment on the
 * publisher/campaign endpoint: a=approved, p=pending, r=rejected.
 *
 *   approved / a / active  → 'joined'
 *   pending  / p           → 'pending'
 *   rejected / r / refused → 'declined'
 *   not joined / available → 'available'
 *   suspended / paused     → 'suspended'
 *   anything else          → 'unknown'
 *
 * The blueprint for /user/publisher/{id}/campaign/{status} shows `campaign_status`
 * as the field name in the participating_publishers endpoint (blocked: exact field name
 * in the publisher-side campaign list response is unconfirmed without live credentials).
 * The mapping below reads both `approval_state` and `status` defensively.
 */
function mapProgrammeStatus(raw: PartnerizeCampaignRaw): ProgrammeStatus {
  const s = (raw.approval_state ?? raw.status ?? '').toLowerCase();
  if (s === 'approved' || s === 'a' || s === 'active' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'p') return 'pending';
  if (s === 'rejected' || s === 'r' || s === 'refused' || s === 'declined') return 'declined';
  if (s === 'not joined' || s === 'available') return 'available';
  if (s === 'suspended' || s === 'paused') return 'suspended';
  return 'unknown';
}

/**
 * Compute the age of a conversion in days at the moment this adapter responded.
 *
 * Anchor priority (matches Awin's `computeAgeDays` rationale):
 *   1. `conversion_date_time` — the datetime of approval/validation when available.
 *      For the "oldest unpaid approved commission" affordance (PRD §15.9) we
 *      want to measure from when the commission was confirmed, not when the
 *      click occurred.
 *   2. `conversion_date` — the date-only fallback.
 *   3. 0 — no date available; better to under-report than to fabricate.
 *
 * A separate `validation_date` or `approved_at` field is NOT documented in any
 * public Partnerize API blueprint. Searches for validation_date/approved_date
 * returned no results. The export_reporting.apib conversion CSV has no such column.
 * Blocked: requires live credentials to confirm whether the JSON endpoint adds extra
 * date fields not present in the CSV export schema.
 */
export function computeAgeDays(raw: PartnerizeConversionRaw, now: Date = new Date()): number {
  const anchor = raw.conversion_date_time ?? raw.conversion_date;
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

function toNumber(v?: string | number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Transformers (Partnerize raw → canonical domain types)
// ---------------------------------------------------------------------------

/**
 * Transform a raw Partnerize campaign record into the canonical Programme type.
 *
 * Partnerize campaigns are joined via a participation relationship; the campaign
 * list endpoint returns the campaigns a publisher is approved for under a given
 * status path segment.
 */
export function toProgramme(raw: PartnerizeCampaignRaw): Programme {
  const id = String(raw.campaign_id ?? '');
  const name = raw.campaign_title ?? raw.campaign_name ?? `Partnerize campaign ${id}`;

  let commissionRate: Programme['commissionRate'];
  if (raw.default_commission) {
    const dc = raw.default_commission;
    const valueType = (dc.value_type ?? dc.type ?? '').toLowerCase();
    const value = toNumber(dc.value);
    if (valueType.includes('percent') || valueType.includes('%')) {
      commissionRate = { type: 'percent', value, description: `${value}%` };
    } else if (valueType.includes('fixed') || valueType.includes('flat')) {
      commissionRate = { type: 'flat', value, currency: raw.currency };
    } else if (dc.value !== undefined) {
      commissionRate = {
        type: 'unknown',
        value,
        description: `${dc.value} (${valueType || 'unknown type'})`,
      };
    }
  }

  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate,
    categories: undefined, // Partnerize campaign list does not include a categories/vertical
                           // field in the publisher campaign endpoint per public blueprints.
                           // The reference.apib defines a Vertical type but it is not returned
                           // in the publisher campaign list. Blocked: requires live credentials.
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

/**
 * Transform a raw Partnerize conversion record into the canonical Transaction type.
 *
 * Field names are sourced from the export_reporting.apib blueprint. The
 * publisher_commission field is used for the `commission` amount because that
 * is what the publisher actually earns, as opposed to `commission` which may
 * be the advertiser's network payment.
 */
export function toTransaction(raw: PartnerizeConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);

  // publisher_commission is the publisher's actual earnings; `commission` is the
  // advertiser-side payment (what the advertiser pays the network).
  // Confirmed from export_reporting.apib: both `commission` and `publisher_commission`
  // are separate columns in the conversion CSV. The aggregated_reporting.apib also
  // lists `partner_commission` separately from `commission`. Using publisher_commission
  // is correct for the publisher-facing commission amount.
  const commission = toNumber(raw.publisher_commission ?? raw.commission);
  const amount = toNumber(raw.value);
  const currency = raw.currency ?? 'GBP';

  const dateConverted = nullableIso(raw.conversion_date_time ?? raw.conversion_date)
    ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.click_date_time ?? raw.click_time ?? raw.click_date);

  return {
    id: String(raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign_id ?? ''),
    programmeName: raw.campaign_title ?? '',
    status,
    amount,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved: undefined, // No separate approval date field in export_reporting.apib conversion schema.
                             // Blocked: requires live credentials to check JSON endpoint.
    datePaid: undefined,     // No payment date field on individual conversions per public blueprints.
                             // Selfbill (invoice) objects have a payment_date, but that is
                             // aggregate-level. Blocked: requires live credentials.
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.reject_reason ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// List extraction helpers
// ---------------------------------------------------------------------------

/**
 * Partnerize wraps arrays in nested objects. Normalise to a flat array.
 * Both known shapes are handled; unknown shapes return [].
 */
function extractCampaigns(response: PartnerizeCampaignListResponse): PartnerizeCampaignRaw[] {
  // Shape 1: { campaigns: { campaign: [...] } }
  if (response?.campaigns?.campaign) {
    const c = response.campaigns.campaign;
    return Array.isArray(c) ? c : [c];
  }
  // Shape 2: { campaign: [...] }
  if (response?.campaign && Array.isArray(response.campaign)) {
    return response.campaign;
  }
  return [];
}

function extractConversions(response: PartnerizeConversionListResponse): PartnerizeConversionRaw[] {
  // Shape 1: { conversions: { conversion: [...] } }
  if (response?.conversions?.conversion) {
    const c = response.conversions.conversion;
    return Array.isArray(c) ? c : [c];
  }
  // Shape 2: { conversion: [...] }
  if (response?.conversion && Array.isArray(response.conversion)) {
    return response.conversion;
  }
  return [];
}

function extractClicks(response: PartnerizeClickListResponse): PartnerizeClickRaw[] {
  if (response?.clicks?.click) {
    const c = response.clicks.click;
    return Array.isArray(c) ? c : [c];
  }
  if (response?.click && Array.isArray(response.click)) {
    return response.click;
  }
  return [];
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class PartnerizeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // Pagination helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch every page of a cursor-paginated Partnerize reporting resource.
   *
   * Partnerize's granular reporting endpoints return the next-page cursor as a
   * `cursor_id` RESPONSE HEADER (granular_reporting.apib); the adapter echoes
   * it back as a `cursor_id` query parameter until no header is returned. The
   * loop is capped at MAX_PAGES, logged so a truncated pull is never silent.
   *
   * `target` short-circuits the pull when the caller passed a `limit`: once at
   * least `target` raw rows are collected there is no reason to keep paging.
   * The first page is always fetched, so a limited call never pulls less than
   * the pre-pagination adapter did.
   */
  private async fetchCursorPages<TResponse, TRow>(input: {
    operation: string;
    path: string;
    params: Record<string, string | number | undefined>;
    extract: (response: TResponse) => TRow[];
    applicationKey: string;
    userApiKey: string;
    resilience: ResilienceConfig;
    target?: number;
  }): Promise<TRow[]> {
    const out: TRow[] = [];
    let cursorId: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { body, cursorId: nextCursorId } = await partnerizeRequestWithCursor<TResponse>({
        operation: input.operation,
        path: input.path,
        applicationKey: input.applicationKey,
        userApiKey: input.userApiKey,
        query: cursorId === undefined ? input.params : { ...input.params, cursor_id: cursorId },
        resilience: input.resilience,
      });
      const batch = input.extract(body);
      out.push(...batch);
      // No cursor header, or an empty page → the result set is complete.
      if (!nextCursorId || batch.length === 0) return out;
      // Caller's limit satisfied → stop early (tool layer slices locally).
      if (typeof input.target === 'number' && out.length >= input.target) return out;
      cursorId = nextCursorId;
    }
    log.warn(
      { operation: input.operation, cap: MAX_PAGES, fetched: out.length },
      'partnerize pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  /**
   * Fetch every page of the limit/offset-paginated campaign list.
   *
   * Standard Partnerize endpoints paginate with `limit` + `offset` (Apiary
   * standard-pagination; the same scheme the partnerize-advertiser adapter
   * uses). The list carries no total count we can rely on, so we loop until a
   * short (< PROGRAMME_PAGE_SIZE) page, capped at MAX_PAGES with a logged
   * warning. `target` short-circuits once a caller-supplied `limit` is
   * satisfied; the first page is always fetched.
   */
  private async fetchAllCampaigns(input: {
    operation: string;
    path: string;
    applicationKey: string;
    userApiKey: string;
    resilience: ResilienceConfig;
    target?: number;
  }): Promise<PartnerizeCampaignRaw[]> {
    const out: PartnerizeCampaignRaw[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await partnerizeRequest<PartnerizeCampaignListResponse>({
        operation: input.operation,
        path: input.path,
        applicationKey: input.applicationKey,
        userApiKey: input.userApiKey,
        query: { limit: PROGRAMME_PAGE_SIZE, offset: page * PROGRAMME_PAGE_SIZE },
        resilience: input.resilience,
      });
      const batch = extractCampaigns(response);
      out.push(...batch);
      if (batch.length < PROGRAMME_PAGE_SIZE) return out;
      if (typeof input.target === 'number' && out.length >= input.target) return out;
    }
    log.warn(
      { operation: input.operation, cap: MAX_PAGES, fetched: out.length },
      'partnerize pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Partnerize campaigns the publisher has joined (or is associated with).
   *
   * Partnerize endpoint:
   *   GET /user/publisher/{publisher_id}/campaign/{status}
   *
   * Status path segment:
   *   a = approved (joined)
   *   p = pending
   *   r = rejected/declined
   *
   * Default: we fetch approved campaigns (status=a) because that is the most
   * common publisher question — "what merchants am I working with?". The `status`
   * query param on our canonical ProgrammeQuery maps to the path segment.
   *
   * Why we fetch separately for each requested status rather than one call:
   * Partnerize's endpoint is scoped to a single status value per call. If the
   * caller requests `{ status: ['joined', 'pending'] }` we make two calls and
   * merge. This is consistent with how Awin handles multiple relationships.
   *
   * Pagination: standard limit/offset pages per status segment, pulled to
   * completion via `fetchAllCampaigns` (MAX_PAGES backstop). When the caller
   * passes a `limit` the pull for each status stops once that many raw rows
   * are collected; client-side filters and the final slice run afterwards.
   *
   * Path and status segments confirmed from publisher_campaign.apib blueprint:
   * status path values are "a" (approved), "p" (pending), "r" (rejected).
   * Exact response body field names (approval_state vs campaign_status) remain
   * blocked pending live credentials.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const applicationKey = requireApplicationKey('listProgrammes');
    const userApiKey = requireUserApiKey('listProgrammes');
    const publisherId = requirePublisherId('listProgrammes');

    const statusFilter = toStatusList(query?.status);

    // Map canonical statuses to Partnerize path segments.
    const partnerizeStatuses = pickPartnerizeStatuses(statusFilter);

    const allRaw: PartnerizeCampaignRaw[] = [];

    for (const pStatus of partnerizeStatuses) {
      const batch = await this.fetchAllCampaigns({
        operation: 'listProgrammes',
        path: `/user/publisher/${encodeURIComponent(publisherId)}/campaign/${pStatus}`,
        applicationKey,
        userApiKey,
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
        target: typeof query?.limit === 'number' ? query.limit : undefined,
      });
      allRaw.push(...batch);
    }

    let programmes = allRaw.map((r) => {
      // Tag the raw record with its participation status so mapProgrammeStatus
      // can read it — the raw record may not carry a status field of its own
      // (the status comes from the URL path, not the response body).
      // Blocked: whether the response body echoes the status is unconfirmed
      // without live credentials. The adapter reads `approval_state` and `status`
      // defensively from the response and falls back to 'unknown'.
      return toProgramme(r);
    });

    // Client-side filters.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }

    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
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
   * Fetch a single Partnerize campaign by ID.
   *
   * Partnerize does not have a dedicated single-campaign endpoint on the
   * publisher side. We call listProgrammes with a filter against the ID
   * across all participation states.
   *
   * Why we search all states: a campaign may be in any participation state
   * (approved, pending, rejected) and the caller may request it by ID without
   * knowing the state. We try approved first, then pending, then rejected.
   *
   * No dedicated single-campaign endpoint is documented in publisher_campaign.apib.
   * The workaround of fetching all-states and filtering client-side is confirmed
   * necessary from the public blueprint. Blocked: a direct-by-ID endpoint may exist
   * in the live API but is not documented publicly.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'Partnerize campaign IDs must be non-empty strings.',
          hint: 'List programmes first (affiliate_partnerize_list_programmes) to find the correct id.',
        }),
      );
    }

    const applicationKey = requireApplicationKey('getProgramme');
    const userApiKey = requireUserApiKey('getProgramme');
    const publisherId = requirePublisherId('getProgramme');

    // Try approved (most common), then pending, then rejected.
    for (const pStatus of ['a', 'p', 'r']) {
      const response = await partnerizeRequest<PartnerizeCampaignListResponse>({
        operation: 'getProgramme',
        path: `/user/publisher/${encodeURIComponent(publisherId)}/campaign/${pStatus}`,
        applicationKey,
        userApiKey,
        resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
      });
      const campaigns = extractCampaigns(response);
      const match = campaigns.find((c) => String(c.campaign_id ?? '') === programmeId);
      if (match) return toProgramme(match);
    }

    // Not found in any participation state.
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation: 'getProgramme',
        message: `Partnerize campaign "${programmeId}" not found in any participation state.`,
        hint: 'Use affiliate_partnerize_list_programmes to confirm the campaign ID.',
      }),
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Partnerize conversions (transactions) within a date window.
   *
   * Partnerize endpoint:
   *   GET /reporting/report_publisher/publisher/{publisher_id}/conversion
   *     ?start_date=YYYY-MM-DD
   *     &end_date=YYYY-MM-DD
   *     &date_type=standard
   *     &timezone=UTC
   *     &campaign_id=...  (optional server-side filter)
   *
   * Pagination: Partnerize paginates results by default (cursor-based); the
   * next-page cursor arrives as a `cursor_id` RESPONSE HEADER and is echoed
   * back as a `cursor_id` query parameter. `fetchCursorPages` follows the
   * cursor to completion (MAX_PAGES backstop, logged on cap) so an unlimited
   * call returns the complete date window. When the caller passes a `limit`
   * the pull stops once that many raw conversions are collected.
   *
   * Default window: last 30 days (matching Awin's default).
   *
   * PRD §15.9 — minAgeDays / maxAgeDays filters applied after status filter,
   * same as Awin.
   * PRD §15.10 — reversed transactions include `reversalReason` from
   * the `reject_reason` field where Partnerize provides one.
   *
   * Date format: the granular_reporting.apib blueprint shows ISO 8601 datetime
   * (e.g. 2018-03-01 00:00:00 URL-encoded as 2018-03-01+00%3A00%3A00).
   * The intro.apib pagination example shows the same format.
   * The adapter currently sends YYYY-MM-DD (date-only); both are accepted per the
   * search evidence. YYYY-MM-DD is conservative and safe.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const applicationKey = requireApplicationKey('listTransactions');
    const userApiKey = requireUserApiKey('listTransactions');
    const publisherId = requirePublisherId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      start_date: formatPartnerizeDate(from),
      end_date: formatPartnerizeDate(to),
      date_type: 'standard',
      timezone: 'UTC',
    };

    // Server-side programme filter: reduces payload size when the caller
    // is scoping to a single campaign.
    if (query?.programmeId) {
      params['campaign_id'] = query.programmeId;
    }

    const rawConversions = await this.fetchCursorPages<
      PartnerizeConversionListResponse,
      PartnerizeConversionRaw
    >({
      operation: 'listTransactions',
      path: `/reporting/report_publisher/publisher/${encodeURIComponent(publisherId)}/conversion`,
      params,
      extract: extractConversions,
      applicationKey,
      userApiKey,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      target: typeof query?.limit === 'number' ? query.limit : undefined,
    });
    let transactions = rawConversions.map((r) => toTransaction(r, now));

    // Status filter.
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9.
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
   * Aggregate conversions into an earnings summary.
   *
   * Why we derive from `listTransactions` rather than a dedicated aggregate
   * endpoint: same rationale as Awin — the aggregate endpoint's status buckets
   * may differ from per-conversion statuses, and `oldestUnpaidAgeDays` (PRD
   * §15.9) can only be computed from per-transaction records. Two sources of
   * truth is worse than one slower source.
   *
   * The `limit` from the caller is ignored — a limited summary would silently
   * undercount (principle 4.1).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined,
    });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: 'GBP',
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      // Commission: the publisher's actual earnings, not the sale amount.
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
          programmeName: t.programmeName || `Partnerize campaign ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved-but-not-paid) transaction.
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
      currency: firstCurrency ?? 'GBP',
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
   * List click records from the Partnerize publisher click reporting endpoint.
   *
   * Partnerize endpoint:
   *   GET /reporting/report_publisher/publisher/{publisher_id}/click
   *     ?start_date=YYYY-MM-DD
   *     &end_date=YYYY-MM-DD
   *
   * Click response field names confirmed from export_reporting.apib click CSV
   * column headers: click_id, cookie_id, campaign_id, publisher_id, status,
   * set_time, set_ip, last_used, last_ip, advertiser_reference, referer,
   * creative_id, creative_type, specific_creative_id, country, publisher_name.
   *
   * CONFIRMED ABSENT: no destination_url or landing_url in the click export schema.
   *
   * Pagination: same `cursor_id` header continuation as listTransactions,
   * followed to completion via `fetchCursorPages` (MAX_PAGES backstop, logged
   * on cap). When the caller passes a `limit` it is also forwarded upstream,
   * and the pull stops once that many raw clicks are collected.
   *
   * Note in known_limitations: listClicks is experimental because JSON field names
   * from the granular reporting endpoint may differ from the CSV export schema.
   * Blocked: requires live credentials to confirm JSON vs CSV field parity.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const applicationKey = requireApplicationKey('listClicks');
    const userApiKey = requireUserApiKey('listClicks');
    const publisherId = requirePublisherId('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      start_date: formatPartnerizeDate(from),
      end_date: formatPartnerizeDate(to),
    };

    if (query?.programmeId) {
      params['campaign_id'] = query.programmeId;
    }

    if (typeof query?.limit === 'number') {
      params['limit'] = query.limit;
    }

    const rawClicks = await this.fetchCursorPages<PartnerizeClickListResponse, PartnerizeClickRaw>({
      operation: 'listClicks',
      path: `/reporting/report_publisher/publisher/${encodeURIComponent(publisherId)}/click`,
      params,
      extract: extractClicks,
      applicationKey,
      userApiKey,
      resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
      target: typeof query?.limit === 'number' ? query.limit : undefined,
    });

    let clicks = rawClicks;
    if (typeof query?.limit === 'number') {
      // Defensive local slice: `limit` is forwarded upstream, but if the
      // upstream ignores it the cursor pull may collect more than requested.
      clicks = clicks.slice(0, query.limit);
    }

    return clicks.map((r): Click => ({
      id: String(r.click_id ?? r.cookie_id ?? ''),
      network: SLUG,
      programmeId: r.campaign_id ? String(r.campaign_id) : undefined,
      timestamp: nullableIso(r.set_time ?? r.last_used) ?? new Date(0).toISOString(),
      referrer: r.referer,
      destinationUrl: undefined, // Confirmed absent: export_reporting.apib click CSV has no
                                  // destination_url or landing_url column. Blocked: JSON
                                  // granular endpoint may include it; requires live credentials.
      rawNetworkData: r,
    }));
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Partnerize deep-link tracking URL.
   *
   * Partnerize tracking link format (verified from public documentation):
   *
   *   https://prf.hn/click/camref:{camref}/destination:{encodedUrl}
   *
   * The `camref` (campaign reference) is a publisher-specific per-campaign
   * identifier. It is NOT the same as the campaign_id. Publishers obtain their
   * camref from the campaign tracking details endpoint or the Partnerize console.
   *
   * Why this matters for callers: the `programmeId` input to this method is
   * treated as the camref (not the raw campaign_id). This design is documented
   * in META.knownLimitations. Callers must supply the camref obtained from the
   * campaign tracking details endpoint.
   *
   * Why deterministic construction: the camref format is stable and fully
   * documented. An API round-trip would add latency for no benefit (the URL
   * is deterministically computable).
   *
   * Both `programmeId` (camref) and `destinationUrl` are required. Missing
   * values surface as `config_error` envelopes with actionable hints.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Partnerize tracking links require the camref (campaign reference), not the campaign_id.',
          hint:
            'Pass the camref as `programmeId`. Find your camref for a campaign via ' +
            'affiliate_partnerize_list_programmes or in the Partnerize console → campaign tracking details.',
        }),
      );
    }
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the advertiser page you want to deep-link to.',
        }),
      );
    }

    // Require credentials to be configured — validates the environment even
    // though we do not make an API call here.
    requireApplicationKey('generateTrackingLink');
    requireUserApiKey('generateTrackingLink');

    const trackingUrl =
      `https://prf.hn/click/camref:${encodeURIComponent(input.programmeId)}` +
      `/destination:${encodeURIComponent(input.destinationUrl)}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'prf.hn/click/camref deterministic construction',
        camref: input.programmeId,
        destination: input.destinationUrl,
        note: 'programmeId is treated as the camref (campaign reference); see adapter known_limitations.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth` which encapsulates the credential read,
   * /user/publisher call, and derivedValues extraction.
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations (v0.2 scaffolds)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('listPublishers is admin-only and not exposed at v0.1.');
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('listPublisherSectors is admin-only and not exposed at v0.1.');
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

  /**
   * Probe each operation with a minimal call to record live capability data.
   *
   * listClicks is probed (unlike Awin's unsupported listClicks) because the
   * endpoint is documented. Its capability is marked `experimental` because
   * the response shape has not been confirmed against a live account.
   *
   * generateTrackingLink and getProgramme are marked supported without probing:
   * generateTrackingLink is deterministic; getProgramme requires a known ID.
   */
  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (
      name: string,
      fn: () => Promise<unknown>,
      note?: string,
      claimStatus?: 'production' | 'partial' | 'experimental',
    ): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        const cap: OperationCapability = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
        };
        if (note !== undefined) cap.note = note;
        if (claimStatus !== undefined) cap.claimStatus = claimStatus;
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
    await probe(
      'listClicks',
      () => this.listClicks({ limit: 1 }),
      'Endpoint is documented; response field names are unconfirmed (see known_limitations).',
      'experimental',
    );
    await probe('verifyAuth', () => this.verifyAuth());

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic prf.hn camref URL construction; no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Searches approved/pending/rejected lists; requires a known campaign id.',
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

export const partnerizeAdapter = new PartnerizeAdapter();
registerAdapter(partnerizeAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toStatusList(v?: ProgrammeStatus | ProgrammeStatus[]): ProgrammeStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Map canonical ProgrammeStatus to Partnerize URL path segments.
 *
 * Partnerize's endpoint accepts a single status per call:
 *   a = approved (joined)
 *   p = pending
 *   r = rejected/declined
 *
 * Default (no status): fetch approved only (by far the most common use case).
 * If the caller requests multiple statuses we return multiple path values and
 * the adapter makes one call per value.
 */
function pickPartnerizeStatuses(statuses?: ProgrammeStatus[]): string[] {
  if (!statuses || statuses.length === 0) return ['a'];
  const result = new Set<string>();
  for (const s of statuses) {
    switch (s) {
      case 'joined':
        result.add('a');
        break;
      case 'pending':
        result.add('p');
        break;
      case 'declined':
        result.add('r');
        break;
      // 'available', 'suspended', 'unknown' have no direct Partnerize
      // equivalent on this endpoint; skip to avoid a 400.
    }
  }
  return result.size > 0 ? [...result] : ['a'];
}

/**
 * Format a Date for Partnerize's `start_date`/`end_date` parameters.
 *
 * Partnerize accepts YYYY-MM-DD dates. The granular_reporting.apib shows the
 * API also accepts full datetime strings (YYYY-MM-DD HH:MM:SS URL-encoded).
 * We use date-only (YYYY-MM-DD) for simplicity; this matches the API examples
 * in the public blueprint and is confirmed safe from search evidence.
 */
function formatPartnerizeDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  formatPartnerizeDate,
  pickPartnerizeStatuses,
  extractCampaigns,
  extractConversions,
  // Exposed so pagination tests can assert the MAX_PAGES cap warning is
  // actually emitted (a truncated pull must never be silent).
  log,
  MAX_PAGES,
  PROGRAMME_PAGE_SIZE,
};
