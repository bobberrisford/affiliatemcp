/**
 * Everflow adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`.
 * Read that file and its header comments before modifying this one.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `X-Eflow-API-Key: <key>`.
 * Base:    https://api.eflow.team/v1
 * Docs:    https://developers.everflow.io/docs/affiliate/
 *
 * --- Endpoint map -----------------------------------------------------------
 *
 *   GET  /v1/affiliates/alloffers
 *     → list of all visible offers (public + approval-required). Paginated.
 *   GET  /v1/affiliates/offers/{offerId}
 *     → single offer detail.
 *   POST /v1/affiliates/reporting/conversions
 *     → raw conversion report with date range + filter body.
 *   GET  /v1/affiliates/offers/{offerId}/url/{urlId}
 *     → returns a tracking URL for a runnable offer. urlId=0 for the default URL.
 *   POST /v1/affiliates/reporting/clicks/stream
 *     → raw clicks stream (up to 14 days per call).
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `everflowRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to canonical set. Prefer `unknown`/`other` over
 *      a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Affiliate API keys must be created by a network admin (not self-service).
 *   - The click stream endpoint caps at 14 days per call; we chunk automatically.
 *   - Adapter built from public API documentation; not yet verified against
 *     a live account.
 */

import { everflowRequest } from './client.js';
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

const log = createLogger('everflow.adapter');

const SLUG = 'everflow';
const NAME = 'Everflow';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.eflow.team',
  // Everflow uses a custom header (X-Eflow-API-Key) rather than standard Bearer.
  authModel: 'custom',
  docsUrl: 'https://developers.everflow.io/docs/affiliate/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  // Experimental: adapter built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Affiliate API keys must be created by a network admin, not self-service by the affiliate.',
    'Click stream endpoint caps at 14 days per call; wider windows are chunked automatically.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // Access gated: the affiliate cannot self-generate an API key; they need the network admin.
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 1,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Conversion reports (listTransactions / getEarningsSummary) can be slow
 * when the date window is wide. Give them a 60s timeout and 3 retries, matching
 * the pattern established by Awin's listTransactions.
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

// ---------------------------------------------------------------------------
// Everflow raw response shapes (deliberately minimal — see Awin adapter for rationale)
// ---------------------------------------------------------------------------

/** Minimal shape of one offer record from GET /v1/affiliates/alloffers */
interface EverflowOfferRaw {
  network_offer_id?: number;
  network_id?: number;
  name?: string;
  offer_status?: string; // e.g. "active", "paused", "pending"
  // currency_id is an ISO 4217 string (e.g. "USD"), NOT a numeric integer.
  // Confirmed via developers.everflow.io/docs/metadata/currencies/ and
  // developers.everflow.io/api-reference/get-partnersoffersrunnable (2026-05-28).
  currency_id?: string;
  preview_url?: string;
  thumbnail_url?: string;
  html_description?: string;
  visibility?: string; // e.g. "public", "require_approval"
  // Payout / commission info — confirmed present in alloffers and single-offer responses.
  default_payout?: number;
  payout_type?: string; // e.g. "cpa", "cps", "cpl"
  // Category — Everflow uses numeric IDs for categories; name confirmed present in list response.
  network_category_id?: number;
  network_category_name?: string;
  // Relationship of this affiliate to the offer.
  // Confirmed values: "approved", "pending", "rejected" (Offer Applications docs, 2026-05-28).
  relationship?: {
    status?: string; // "approved" | "pending" | "rejected"
  };
}

/** Minimal shape of a conversion record from POST /v1/affiliates/reporting/conversions */
interface EverflowConversionRaw {
  conversion_id?: string;
  transaction_id?: string; // click transaction ID that attributed this conversion
  offer?: { network_offer_id?: number; name?: string };
  // Confirmed status values (developers.everflow.io/docs/network/conversion_updates/, 2026-05-28):
  //   "approved" | "pending" | "rejected" | "invalid" | "on_hold"
  // Note: Everflow does not use "reversed" — rejections appear as "rejected".
  status?: string;
  payout?: number;
  revenue?: number;
  sale_amount?: number;
  // currency_id is an ISO 4217 string (e.g. "USD") in conversion responses.
  // Confirmed via developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ (2026-05-28).
  // The field name is currency_id (not currency) in the raw API response.
  currency_id?: string;
  // Timestamps: Everflow uses Unix epoch integers for all timestamps.
  // conversion_unix_timestamp = when the conversion was recorded (seconds since epoch).
  // click_unix_timestamp = when the originating click occurred (seconds since epoch).
  // Confirmed via developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ (2026-05-28).
  conversion_unix_timestamp?: number;
  click_unix_timestamp?: number;
  // Payout type — used to understand commission model
  payout_type?: string;
  // Source / sub-params carried through from the click
  source_id?: string;
  sub1?: string;
  sub2?: string;
  // Error / reversal context
  error_code?: number;
  error_message?: string;
}

/** Minimal shape of a click record from POST /v1/affiliates/reporting/clicks/stream */
interface EverflowClickRaw {
  transaction_id?: string;
  // unix_timestamp: confirmed field name for click timestamp (epoch seconds).
  // Source: developers.everflow.io/api-reference/post-affiliatesreportingclicksstream (2026-05-28).
  unix_timestamp?: number;
  tracking_url?: string;
  referer?: string;
  user_ip?: string;
  error_code?: number;
  error_message?: string;
  is_unique?: boolean;
  relationship?: {
    offer?: {
      network_offer_id?: number;
      name?: string;
    };
  };
}

/** Envelope from GET /v1/affiliates/alloffers */
interface EverflowOffersEnvelope {
  offers?: EverflowOfferRaw[];
  // Pagination fields confirmed via developers.everflow.io/docs/user-guide/paging/ (2026-05-28).
  page?: number;
  page_size?: number;
  total_count?: number;
}

/** Envelope from POST /v1/affiliates/reporting/conversions */
interface EverflowConversionsEnvelope {
  conversions?: EverflowConversionRaw[];
  // Paging
  page?: number;
  page_size?: number;
  total_count?: number;
}

/** Response from GET /v1/affiliates/offers/{offerId}/url/{urlId} */
interface EverflowTrackingUrlResponse {
  // The tracking link endpoint returns the generated URL in the "url" field.
  // Confirmed: developers.everflow.io/api-reference/get-partnersoffersrunnable shows
  // {"url": "http://www.servetrack.test/9W598/2CTPL/?uid=1"} (2026-05-28).
  // The tracking_url fallback is retained for robustness but is not the primary field.
  url?: string;
  tracking_url?: string; // present in offer list responses; not expected on this endpoint
}

/** Envelope from POST /v1/affiliates/reporting/clicks/stream */
interface EverflowClicksEnvelope {
  clicks?: EverflowClickRaw[];
  page?: number;
  page_size?: number;
  total_count?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(operation: string): string {
  return requireCredential('EVERFLOW_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Ask your Everflow network admin to generate an affiliate API key under ' +
      'Manage Affiliate → API tab, then set EVERFLOW_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Status normalisation: Everflow offer status → canonical ProgrammeStatus.
 *
 * Everflow uses string statuses on offers. The `relationship.status` field
 * describes the affiliate's relationship to the offer (approved, pending,
 * rejected). We prefer the relationship status when present, falling back to
 * the offer's own `offer_status`.
 *
 * relationship.status values confirmed via Offer Applications docs
 * (developers.everflow.io/docs/network/offer_applications/, 2026-05-28):
 *   approved    → 'joined'   (affiliate approved for the offer)
 *   pending     → 'pending'  (application awaiting approval)
 *   rejected    → 'declined' (application rejected)
 *
 * offer_status values for no-relationship fallback (confirmed via Offers docs,
 * developers.everflow.io/docs/affiliate/offers/, 2026-05-28):
 *   active   → 'available'
 *   paused   → 'suspended'
 *   inactive → 'suspended'
 *   pending  → 'pending'
 */
function mapProgrammeStatus(raw: EverflowOfferRaw): ProgrammeStatus {
  const rel = (raw.relationship?.status ?? '').toLowerCase();
  const offerStatus = (raw.offer_status ?? '').toLowerCase();

  // If there is a relationship, its status describes this affiliate's state.
  if (rel) {
    if (rel === 'approved' || rel === 'active' || rel === 'joined') return 'joined';
    if (rel === 'pending' || rel === 'under_review') return 'pending';
    // Everflow's confirmed rejection value is "rejected"; "declined" retained as alias.
    if (rel === 'rejected' || rel === 'declined') return 'declined';
    if (rel === 'paused' || rel === 'inactive') return 'suspended';
    return 'unknown';
  }

  // No relationship — use the offer's own status to decide availability.
  if (offerStatus === 'active') return 'available';
  if (offerStatus === 'paused' || offerStatus === 'inactive') return 'suspended';
  if (offerStatus === 'pending') return 'pending';
  return 'unknown';
}

/**
 * Status normalisation: Everflow conversion status → canonical TransactionStatus.
 *
 * Confirmed Everflow conversion statuses (developers.everflow.io/docs/network/
 * conversion_updates/ and helpdesk.everflow.io/customer/on-hold-conversions, 2026-05-28):
 *   approved  → 'approved'
 *   pending   → 'pending'
 *   rejected  → 'reversed'  (Everflow uses "rejected", not "reversed")
 *   invalid   → 'reversed'  (invalid conversions are effectively rejections)
 *   on_hold   → 'pending'   (on-hold is a time-delayed approval, treated as pending)
 *   anything else → 'other'
 *
 * Note: Everflow does not use a "reversed" status string — reversals appear as
 * "rejected". The "reversed" alias is retained for forward-compatibility.
 */
function mapTransactionStatus(raw: EverflowConversionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'pending' || s === 'on_hold') return 'pending';
  if (s === 'rejected' || s === 'reversed' || s === 'declined' || s === 'invalid') return 'reversed';
  return 'other';
}

/**
 * Compute the age in days of a transaction relative to `now`.
 *
 * We anchor on `conversion_unix_timestamp` (the point the conversion was recorded).
 * Everflow uses Unix epoch integers (seconds) for all timestamps in conversion
 * responses — confirmed via developers.everflow.io/docs/affiliate/reporting/
 * affiliate_raw_conversions/ (2026-05-28).
 *
 * The `raw` parameter accepts an `EverflowConversionRaw`; the function also
 * accepts a legacy string date (`conversion_date`) for fixture compatibility
 * via the internal test helper.
 */
function computeAgeDays(raw: EverflowConversionRaw & { conversion_date?: string }, now: Date = new Date()): number {
  // Primary path: unix timestamp (confirmed API field).
  if (typeof raw.conversion_unix_timestamp === 'number') {
    const ms = now.getTime() - raw.conversion_unix_timestamp * 1000;
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  }
  // Fallback: string date — retained for fixture/test backward-compatibility.
  // The string format "YYYY-MM-DD HH:mm:SS" is parsed correctly by Date.parse.
  const anchor = raw.conversion_date;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string | number): string | undefined {
  if (d === undefined || d === null) return undefined;
  // Handle epoch seconds (Everflow uses unix_timestamp for clicks)
  if (typeof d === 'number') {
    return new Date(d * 1000).toISOString();
  }
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: EverflowOfferRaw): Programme {
  const id = String(raw.network_offer_id ?? '');
  return {
    id,
    name: raw.name ?? `Everflow offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    // currency_id is an ISO 4217 string (e.g. "USD") on offer records.
    // Confirmed: developers.everflow.io/docs/metadata/currencies/ and
    // developers.everflow.io/api-reference/get-partnersoffersrunnable (2026-05-28).
    currency: raw.currency_id ?? undefined,
    commissionRate: raw.default_payout !== undefined
      ? {
          type: raw.payout_type === 'cps' ? 'percent' : 'flat',
          value: raw.default_payout,
          description: raw.payout_type
            ? `${raw.payout_type.toUpperCase()} ${raw.default_payout}`
            : String(raw.default_payout),
        }
      : undefined,
    categories: raw.network_category_name ? [raw.network_category_name] : [],
    advertiserUrl: raw.preview_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: EverflowConversionRaw & { conversion_date?: string; click_date?: string; currency?: string }, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = raw.payout ?? 0;
  const sale = raw.sale_amount ?? raw.revenue ?? 0;
  // currency_id is the ISO 4217 string field in conversion responses (e.g. "USD").
  // Confirmed via developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ (2026-05-28).
  // The `raw.currency` fallback handles fixture data that uses the old "currency" field name.
  const currency = raw.currency_id ?? raw.currency ?? 'USD';
  const offerId = String(raw.offer?.network_offer_id ?? '');
  const programmeName = raw.offer?.name ?? `Everflow offer ${offerId}`;

  // Timestamps: use conversion_unix_timestamp / click_unix_timestamp (confirmed unix epoch ints).
  // String date fields (conversion_date, click_date) retained as fallback for fixture compatibility.
  const dateConverted = (typeof raw.conversion_unix_timestamp === 'number'
    ? nullableIso(raw.conversion_unix_timestamp)
    : nullableIso(raw.conversion_date)) ?? new Date(0).toISOString();
  const dateClicked = typeof raw.click_unix_timestamp === 'number'
    ? nullableIso(raw.click_unix_timestamp)
    : nullableIso(raw.click_date);

  return {
    id: raw.conversion_id ?? raw.transaction_id ?? '',
    network: SLUG,
    programmeId: offerId,
    programmeName,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    // Everflow does not expose a separate approval-date field on conversion records.
    // Blocked: no date_approved or approved_at field is documented in the affiliate
    // reporting API. We set dateApproved to conversion timestamp for approved records
    // as a best-effort proxy until confirmed otherwise by live verification.
    dateApproved: status === 'approved' ? dateConverted : undefined,
    datePaid: undefined, // Everflow does not expose a payment date via conversion report.
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.error_message ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: EverflowClickRaw): Click {
  const offerId = String(raw.relationship?.offer?.network_offer_id ?? '');
  const ts = raw.unix_timestamp
    ? new Date(raw.unix_timestamp * 1000).toISOString()
    : new Date(0).toISOString();

  return {
    id: raw.transaction_id ?? '',
    network: SLUG,
    programmeId: offerId || undefined,
    timestamp: ts,
    referrer: raw.referer,
    destinationUrl: raw.tracking_url,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date helpers for Everflow reporting
// ---------------------------------------------------------------------------

/**
 * Format a Date for Everflow's `from`/`to` body fields.
 *
 * Everflow's reporting endpoints expect `YYYY-MM-DD HH:mm:SS` format.
 * Confirmed: developers.everflow.io/user-guide/request-response-format states
 * the supported date input formats are "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:SS" (2026-05-28).
 */
function formatEverflowDate(d: Date): string {
  // Produce "YYYY-MM-DD HH:mm:SS" in UTC
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EverflowAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Everflow offers visible to this affiliate.
   *
   * Everflow endpoint: GET /v1/affiliates/alloffers
   *   Returns all visible offers (public + approval-required) paginated.
   *
   * We fetch the first page (up to `query.limit` or 100 by default) and apply
   * client-side search/status/category filters. The alloffers endpoint does not
   * expose a server-side free-text search filter; status filtering is possible
   * via the query.filters body but client-side is used for consistency.
   *
   * Pagination: Everflow uses page / page_size integer pagination.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    // Everflow supports page_size up to 2000 for listing endpoints; cap at 500 to
    // stay well within limits and keep responses manageable. Confirmed max of 2000
    // via developers.everflow.io/docs/user-guide/paging/ (2026-05-28).
    const pageSize = Math.min(query?.limit ?? 100, 500);

    const envelope = await everflowRequest<EverflowOffersEnvelope>({
      operation: 'listProgrammes',
      path: '/v1/affiliates/alloffers',
      apiKey,
      query: { page: 1, page_size: pageSize },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (envelope.offers ?? []).map(toProgramme);

    // Client-side filters.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.advertiserUrl ?? '').toLowerCase().includes(needle),
      );
    }

    const statusFilter = toStatusList(query?.status);
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
   * Fetch a single Everflow offer by ID.
   *
   * Everflow endpoint: GET /v1/affiliates/offers/{offerId}
   *   Returns the full offer detail for the given network_offer_id.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Everflow offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_everflow_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');

    const raw = await everflowRequest<EverflowOfferRaw>({
      operation: 'getProgramme',
      path: `/v1/affiliates/offers/${programmeId}`,
      apiKey,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    return toProgramme(raw ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions via the Everflow raw conversions report.
   *
   * Everflow endpoint: POST /v1/affiliates/reporting/conversions
   * Request body:
   *   {
   *     from: "YYYY-MM-DD HH:mm:SS",
   *     to:   "YYYY-MM-DD HH:mm:SS",
   *     timezone_id: 67,  // 67 = UTC (confirmed: developers.everflow.io/docs/metadata/timezones/)
   *     show_conversions: true
   *   }
   *
   * Why POST: Everflow uses POST for reporting endpoints to allow a rich filter
   * body. We send a minimal body here; richer filtering is applied client-side.
   *
   * Date window default: last 30 days. Everflow does not document a per-call cap
   * on the conversion window (unlike the 14-day cap on the clicks stream).
   * Results are capped at 10,000 rows server-side; incomplete_results is set to
   * true if the limit is reached (confirmed: developers.everflow.io/docs/user-guide/paging/).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const body: Record<string, unknown> = {
      from: formatEverflowDate(from),
      to: formatEverflowDate(to),
      timezone_id: 67, // 67 = UTC, confirmed: developers.everflow.io/docs/metadata/timezones/ (2026-05-28)
      show_conversions: true,
    };

    // Offer-level filter in the request body.
    // Filter structure confirmed: resource_type + filter_id_value in query.filters array.
    // Source: developers.everflow.io/docs/network/reporting/aggregated_data/ (2026-05-28).
    // Multiple filters on the same resource_type act as OR; different types act as AND.
    if (query?.programmeId) {
      body['query'] = {
        filters: [
          {
            filter_id_value: Number(query.programmeId),
            resource_type: 'offer',
          },
        ],
      };
    }

    const envelope = await everflowRequest<EverflowConversionsEnvelope>({
      operation: 'listTransactions',
      path: '/v1/affiliates/reporting/conversions',
      apiKey,
      method: 'POST',
      body,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    let transactions = (envelope.conversions ?? []).map((r) => toTransaction(r, now));

    // Status filter (client-side). Everflow's conversion reporting does support a
    // server-side status filter via query.filters resource_type: "status", but
    // applying it client-side keeps the adapter simple and consistent with other networks.
    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
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
   * Aggregate conversion report into an earnings summary.
   *
   * We derive the summary from `listTransactions` for the same reason as Awin:
   * the per-transaction `ageDays` is not available from summary/aggregated
   * endpoints, so we need the raw records anyway for the `oldestUnpaidAgeDays`
   * affordance. Deriving from transactions keeps the summary auditable.
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
      // Default USD until we see a real transaction; overwritten by the first transaction's currency.
      // Currency values from Everflow are ISO 4217 strings confirmed via conversion responses.
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
          programmeName: t.programmeName || `Everflow offer ${key}`,
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
   * List click-level data via the Everflow raw clicks stream.
   *
   * Everflow endpoint: POST /v1/affiliates/reporting/clicks/stream
   *   Body: { from: "...", to: "...", timezone_id: 67 }
   *   Caps at 14 days per call — we chunk the window automatically.
   *
   * Unlike Awin and CJ, Everflow DOES expose click-level data via the affiliate
   * API. This implementation fetches the first page of results per chunk.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const apiKey = requireApiKey('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Chunk into ≤14-day slices — Everflow caps each clicks/stream call at 14 days.
    const slices = chunkDateRange(from, to, 14);

    const allClicks: Click[] = [];

    for (const slice of slices) {
      const body: Record<string, unknown> = {
        from: formatEverflowDate(slice.start),
        to: formatEverflowDate(slice.end),
        timezone_id: 67, // 67 = UTC, confirmed: developers.everflow.io/docs/metadata/timezones/ (2026-05-28)
      };

      if (query?.programmeId) {
        body['query'] = {
          filters: [
            {
              filter_id_value: Number(query.programmeId),
              resource_type: 'offer',
            },
          ],
        };
      }

      const envelope = await everflowRequest<EverflowClicksEnvelope>({
        operation: 'listClicks',
        path: '/v1/affiliates/reporting/clicks/stream',
        apiKey,
        method: 'POST',
        body,
        resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
      });

      allClicks.push(...(envelope.clicks ?? []).map(toClick));
    }

    let results = allClicks;

    if (typeof query?.limit === 'number') {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Generate an Everflow tracking URL for a runnable offer.
   *
   * Everflow endpoint: GET /v1/affiliates/offers/{offerId}/url/{urlId}
   *   urlId = 0 for the default offer URL.
   *   Returns a tracking URL string.
   *
   * Unlike Awin (where we construct the URL deterministically), Everflow
   * requires an API call to get the tracking link — the URL includes
   * network-specific domain, sub-ID, and routing information that is only
   * known server-side.
   *
   * Why urlId = 0: Everflow allows multiple destination URLs per offer
   * (urlId 0 is the default). Callers who need a specific URL ID should use
   * `input.programmeId` in `{offerId}:{urlId}` composite form — a v0.2 concern
   * once the use-case is validated against a live account.
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
          message: 'Everflow tracking links require the offer (programme) ID.',
          hint:
            'Pass `programmeId`. Use affiliate_everflow_list_programmes to discover offer IDs.',
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
          hint: 'Pass the URL of the page you want to link to within the advertiser\'s site.',
        }),
      );
    }

    if (!/^\d+$/.test(input.programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Everflow offer IDs are numeric; received "${input.programmeId}".`,
          hint: 'Use affiliate_everflow_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const apiKey = requireApiKey('generateTrackingLink');

    // urlId = 0 means "use the default URL for this offer".
    const raw = await everflowRequest<EverflowTrackingUrlResponse>({
      operation: 'generateTrackingLink',
      path: `/v1/affiliates/offers/${input.programmeId}/url/0`,
      apiKey,
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    // Everflow returns the tracking URL in the `url` field for this endpoint.
    // Confirmed via API reference example: {"url": "http://www.servetrack.test/9W598/2CTPL/?uid=1"}
    // Source: developers.everflow.io/api-reference/get-partnersoffersrunnable (2026-05-28).
    // The tracking_url fallback handles any edge cases where the field name differs.
    const trackingUrl = raw.url ?? raw.tracking_url ?? '';

    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Everflow returned an empty tracking URL for offer ${input.programmeId}.`,
          hint: 'Confirm the offer is runnable (status joined/approved) for your affiliate account.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: raw,
    };
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));

    // generateTrackingLink requires a known offer ID — mark as experimental without probing.
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known runnable offer ID; not probed automatically.',
    };

    // getProgramme requires a known offer ID — same as generateTrackingLink.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known offer ID; not probed automatically.',
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

export const everflowAdapter = new EverflowAdapter();
registerAdapter(everflowAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks.
 *
 * Everflow's clicks stream endpoint caps at 14 days per call. This helper
 * mirrors Awin's `chunkDateRange` implementation.
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

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toClick,
  chunkDateRange,
  formatEverflowDate,
};

// Silence unused-import lint for the logger.
void log;
