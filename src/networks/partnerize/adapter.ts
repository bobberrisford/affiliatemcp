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
 *     → conversions with pagination.
 *
 *   GET  /reporting/report_publisher/publisher/{publisher_id}/click
 *     ?start_date=ISO &end_date=ISO
 *     → click records.
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

import { partnerizeRequest } from './client.js';
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
    'Pagination is cursor-based; this adapter fetches one page at a time via the start/end date window and does not yet follow cursor_id for result sets exceeding the default page size.',
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
// reporting documentation. Fields marked TODO(verify) have not been confirmed
// against a live API response.
// ---------------------------------------------------------------------------

interface PartnerizeCampaignRaw {
  campaign_id?: string;              // TODO(verify): may be numeric string
  campaign_title?: string;
  campaign_name?: string;            // TODO(verify): alternative field name
  status?: string;                   // from participation status in path
  approval_state?: string;           // TODO(verify): 'approved' | 'pending' | 'rejected'
  currency?: string;
  // Commission information — Partnerize returns nested commission structures.
  default_commission?: {
    type?: string;
    value?: string;                  // TODO(verify): may be numeric
    value_type?: string;             // e.g. 'percentage' | 'fixed'
  };
  tracking_url?: string;             // TODO(verify): may be named differently
  camref?: string;                   // publisher-specific campaign reference
  url?: string;                      // advertiser URL
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
 * Field names sourced from the export_reporting.apib blueprint, which documents
 * the CSV export fields. The JSON reporting endpoint is expected to return the
 * same fields. TODO(verify): confirm field names against a live response.
 */
interface PartnerizeConversionRaw {
  conversion_id?: string;
  campaign_id?: string;
  publisher_id?: string;
  conversion_date?: string;          // YYYY-MM-DD
  conversion_date_time?: string;     // ISO 8601 datetime
  click_time?: string;               // ISO 8601 datetime
  click_date?: string;               // YYYY-MM-DD
  click_date_time?: string;          // ISO 8601 datetime
  currency?: string;
  conversion_reference?: string;     // advertiser's order reference
  campaign_title?: string;
  publisher_name?: string;
  conversion_status?: string;        // e.g. 'approved' | 'pending' | 'rejected'
  conversion_lag?: string | number;  // TODO(verify): hours or days
  value?: string | number;           // gross order value
  commission?: string | number;      // advertiser pays network
  publisher_commission?: string | number; // publisher's actual commission
  camref?: string;
  // Rejection reason for reversed conversions.
  reject_reason?: string;            // TODO(verify): field name
  country?: string;
  [key: string]: unknown;
}

interface PartnerizeConversionListResponse {
  conversions?: {
    conversion?: PartnerizeConversionRaw[] | PartnerizeConversionRaw;
  };
  // Flat array variant.
  conversion?: PartnerizeConversionRaw[];
  // Pagination metadata. TODO(verify): header-based vs body-based pagination.
  count?: number;
  [key: string]: unknown;
}

/**
 * Click row shape from the publisher click reporting endpoint.
 * TODO(verify): these field names are from the export_reporting.apib blueprint;
 * live granular reporting fields may differ.
 */
interface PartnerizeClickRaw {
  click_id?: string;
  cookie_id?: string;
  campaign_id?: string;
  publisher_id?: string;
  set_time?: string;                 // ISO 8601 — when the click occurred
  last_used?: string;                // ISO 8601
  referer?: string;
  publisher_name?: string;
  status?: string;
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
 *   paid        → 'paid'      (TODO(verify): confirm this status exists)
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
 * TODO(verify): the response `approval_state` or `status` field values are not
 * confirmed; this mapping is inferred from the API blueprint.
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
 * TODO(verify): Partnerize may expose a separate `validation_date` or
 * `approved_at` field. Adjust anchor once confirmed against a live response.
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
    categories: undefined, // TODO(verify): Partnerize category taxonomy not confirmed
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
  // network's commission (what the advertiser pays). Use publisher_commission where
  // available; fall back to `commission`.
  // TODO(verify): confirm publisher_commission vs commission semantics.
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
    dateApproved: undefined, // TODO(verify): separate approval date field not confirmed
    datePaid: undefined,     // TODO(verify): Partnerize may expose a payment date
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
   * TODO(verify): confirm the exact path and status values against a live account.
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
      const response = await partnerizeRequest<PartnerizeCampaignListResponse>({
        operation: 'listProgrammes',
        path: `/user/publisher/${encodeURIComponent(publisherId)}/campaign/${pStatus}`,
        applicationKey,
        userApiKey,
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      });
      allRaw.push(...extractCampaigns(response));
    }

    let programmes = allRaw.map((r) => {
      // Tag the raw record with its participation status so mapProgrammeStatus
      // can read it — the raw record may not carry a status field of its own
      // (the status comes from the URL path, not the response body).
      // TODO(verify): confirm whether the response carries status in the body.
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
   * TODO(verify): confirm this approach or an alternative single-campaign endpoint.
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
   * Date windowing: Partnerize paginates results by default (cursor-based).
   * This adapter fetches all results within the date window in a single call,
   * relying on the API's default pagination size. Full cursor-following is a
   * known limitation documented in META.knownLimitations.
   *
   * Default window: last 30 days (matching Awin's default).
   *
   * PRD §15.9 — minAgeDays / maxAgeDays filters applied after status filter,
   * same as Awin.
   * PRD §15.10 — reversed transactions include `reversalReason` from
   * the `reject_reason` field where Partnerize provides one.
   *
   * TODO(verify): start_date / end_date format (ISO 8601 datetime vs date-only).
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

    const response = await partnerizeRequest<PartnerizeConversionListResponse>({
      operation: 'listTransactions',
      path: `/reporting/report_publisher/publisher/${encodeURIComponent(publisherId)}/conversion`,
      applicationKey,
      userApiKey,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawConversions = extractConversions(response);
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
   * This endpoint is documented in the public API blueprint but its response
   * field names have not been confirmed against a live account. The response
   * shape is modelled on the export_reporting fields from the blueprint.
   *
   * Note in known_limitations: listClicks is experimental and may require
   * field-name adjustments after live testing.
   *
   * TODO(verify): confirm response field names against a live Partnerize account.
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

    const response = await partnerizeRequest<PartnerizeClickListResponse>({
      operation: 'listClicks',
      path: `/reporting/report_publisher/publisher/${encodeURIComponent(publisherId)}/click`,
      applicationKey,
      userApiKey,
      query: params,
      resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
    });

    const rawClicks = extractClicks(response);

    return rawClicks.map((r): Click => ({
      id: String(r.click_id ?? r.cookie_id ?? ''),
      network: SLUG,
      programmeId: r.campaign_id ? String(r.campaign_id) : undefined,
      timestamp: nullableIso(r.set_time ?? r.last_used) ?? new Date(0).toISOString(),
      referrer: r.referer,
      destinationUrl: undefined, // TODO(verify): not documented in blueprint
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
 * Partnerize accepts ISO 8601 dates (YYYY-MM-DD). We use date-only rather than
 * datetime because the reporting endpoint's time-of-day semantics are
 * unconfirmed. TODO(verify): confirm whether datetime strings are accepted.
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
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
