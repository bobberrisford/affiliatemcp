/**
 * Sovrn Commerce adapter (publisher side; formerly VigLink).
 *
 * Sovrn Commerce is a link-monetisation platform that embeds affiliate
 * tracking into publisher links. The publisher API surface is reporting-centric:
 * merchants, transactions, links, and pages — all available at viglink.io/v1/.
 *
 * READ ME FIRST (pattern matched to src/networks/awin/adapter.ts):
 *
 * --- Authentication ----------------------------------------------------------
 *
 * Two credentials:
 *   SOVRN_SECRET_KEY — "secret {key}" Authorization header for all reporting calls.
 *   SOVRN_API_KEY   — per-site key used in tracking links (redirect.viglink.com?key=...).
 *
 * See client.ts for the header format and auth.ts for the validation approach.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — GET /v1/reports/merchants (aggregated by merchant)
 *   getProgramme        — derived from /v1/reports/merchants filtered by name
 *   listTransactions    — GET /v1/reports/transactions (one day per call)
 *   getEarningsSummary  — derived from listTransactions
 *   listClicks          — NOT IMPLEMENTED (no distinct click-stream endpoint)
 *   generateTrackingLink— deterministic: redirect.viglink.com?key=...&u=...
 *   verifyAuth          — minimal authenticated call to /v1/reports/merchants
 *
 * --- Why listProgrammes uses /reports/merchants not a dedicated catalogue ----
 *
 * Sovrn Commerce does not have a "join a merchant" catalogue endpoint in the
 * public publisher API. Publishers are opted in to Sovrn's network globally
 * and the platform automatically monetises links to qualifying merchants. The
 * /reports/merchants endpoint returns the merchants you have ACTUALLY sent
 * traffic to — which is the closest analogue to "joined programmes".
 *
 * This means ProgrammeStatus cannot be reliably determined. Every merchant
 * returned by /reports/merchants is effectively 'joined' for our purposes.
 *
 * --- Why transactions require one call per day --------------------------------
 *
 * The Sovrn Commerce /reports/transactions endpoint returns one day of data
 * per API call. Callers pass a date in YYYY-MM-DD format. To fetch a wider
 * window we iterate day-by-day; the adapter handles this internally so callers
 * see the flat `Transaction[]` they expect.
 *
 * Wide windows (30+ days) make 30+ sequential requests. The resilience layer
 * applies per-call, so a transient failure on day N causes a retry for that
 * day only.
 *
 * --- Cardinal rules (from awin/adapter.ts) -----------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `sovrnRequest` from `./client.ts`.
 *   2. EVERY failure → `NetworkErrorEnvelope` with network, operation, status, body.
 *   3. PRESERVE `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums. Sovrn does not expose a canonical transaction
 *      status; we default to 'other' and note it in known_limitations.
 *   5. COMPUTE `ageDays` for every transaction (§PRD 15.9).
 *   6. UK English in all user-visible strings. "programme" not "program".
 *
 * --- Public API sources -------------------------------------------------------
 *
 *   https://developer.sovrn.com/
 *   https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis
 *   https://support.viglink.com/hc/en-us/articles/216688298-VigLink-Developer-Guide
 */

import { sovrnRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { requireCredential } from '../../shared/config.js';
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
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('sovrn-commerce.adapter');

const SLUG = 'sovrn-commerce';
const NAME = 'Sovrn Commerce';

// The base URL for Sovrn's tracking redirect. Deterministic; no fetch required.
// Source: redirect.viglink.com observed in public URL patterns; confirmed via
// https://github.com/Sh1d0w/clean-links/issues/20 and Geniuslink documentation.
const VIGLINK_REDIRECT_HOST = 'https://redirect.viglink.com';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://viglink.io',
  authModel: 'custom',
  docsUrl: 'https://developer.sovrn.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  // experimental: built from public docs, not yet verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The transactions endpoint returns one day of data per call; wide date windows require sequential calls.',
    'Click-level data is not exposed as a distinct click-stream API; listClicks is unsupported.',
    'Merchant (programme) listing is aggregated reporting data, not a dedicated catalogue endpoint.',
    'getProgramme is derived from the merchants report filtered by merchant name; no single-merchant lookup endpoint exists in the public API.',
    'Commission status normalisation is best-effort; Sovrn Commerce does not expose a canonical status field on transactions.',
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

// listTransactions makes one call per day in the requested window, so each
// individual call is cheap — standard timeout is fine. Wide windows produce
// many calls rather than one slow call.
const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: DEFAULT_RESILIENCE,
  getEarningsSummary: DEFAULT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Sovrn Commerce response shapes
// ---------------------------------------------------------------------------
//
// The public Sovrn Commerce API returns arrays of objects. Field names are
// inferred from the developer.sovrn.com documentation. We treat every field
// as potentially absent (the API surface is partially documented).
//
// // TODO(verify): confirm exact JSON field names against a live API response.
// The names below are derived from public documentation and may differ in
// capitalisation or naming convention from the actual API.

interface SovrnMerchantRaw {
  // // TODO(verify): exact field names from /v1/reports/merchants response
  merchant?: string;         // merchant name
  merchantId?: string | number; // merchant identifier (if exposed)
  clicks?: number;
  revenue?: number;
  commission?: number;
  epc?: number;              // earnings per click
  sales?: number;
  actions?: number;
  conversionRate?: number;
  currency?: string;         // // TODO(verify): currency field presence and name
}

interface SovrnTransactionRaw {
  // // TODO(verify): exact field names from /v1/reports/transactions response
  revenueId?: string | number;      // unique identifier for the commission event
  commissionId?: string | number;   // alternative identifier
  clickId?: string | number;        // click that generated the transaction
  clickDate?: string;               // ISO date YYYY-MM-DD
  commissionDate?: string;          // date the commission was recorded
  updateDate?: string;              // date the record was last updated
  orderValue?: number;              // gross sale value
  publisherNetRevenue?: number;     // publisher's share of the revenue
  revenue?: number;                 // alternative revenue field name
  commission?: number;              // alternative commission field name
  merchant?: string;                // merchant name
  merchantId?: string | number;
  programType?: string;             // e.g. "cpa", "cpc"
  currency?: string;                // // TODO(verify): currency field name
  campaignId?: string | number;     // site/campaign identifier
  status?: string;                  // // TODO(verify): status field presence
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise transaction status.
 *
 * Sovrn Commerce's /reports/transactions endpoint does not expose a canonical
 * transaction status in its public documentation. The `commissionDate` field
 * indicates when a commission was recorded, and `updateDate` when it changed,
 * but there is no enum field equivalent to Awin's commissionStatus or CJ's
 * actionStatus.
 *
 * We map 'other' as the safe default. If a `status` field appears in the raw
 * payload we attempt a best-effort mapping; otherwise we leave it as 'other'
 * and let the user inspect rawNetworkData.
 *
 * // TODO(verify): confirm whether a status field exists in the API response
 * and what values it takes.
 */
function mapTransactionStatus(raw: SovrnTransactionRaw): TransactionStatus {
  if (raw.status) {
    const s = raw.status.toLowerCase();
    if (s === 'pending' || s === 'new') return 'pending';
    if (s === 'approved' || s === 'locked' || s === 'confirmed') return 'approved';
    if (s === 'reversed' || s === 'declined' || s === 'void' || s === 'cancelled') return 'reversed';
    if (s === 'paid' || s === 'cleared') return 'paid';
  }
  // The presence of commissionDate with no updateDate suggests a stable
  // commission — 'approved' is the most honest approximation. Without a status
  // field this is speculative; 'other' is safer per the cardinal rules.
  return 'other';
}

/**
 * Map Sovrn merchant data to canonical ProgrammeStatus.
 *
 * Sovrn Commerce does not maintain a "joined / pending / declined" catalogue
 * for merchants. Every merchant returned by /reports/merchants is one the
 * publisher has sent traffic to — functionally 'joined'. We return 'joined'
 * and note the limitation in known_limitations.
 */
function mapProgrammeStatus(_raw: SovrnMerchantRaw): ProgrammeStatus {
  // All merchants returned by the API are ones the publisher is actively
  // working with — there is no "available but not joined" concept in this API.
  return 'joined';
}

/**
 * Compute the age (in days) of a transaction.
 *
 * We prefer commissionDate (when the commission was recorded — analogous to
 * Awin's validationDate) over clickDate (when the click happened). For the
 * unpaid-age affordance (PRD §15.9), commissionDate is the relevant anchor:
 * "how long has this commission been sitting unresolved?".
 *
 * updateDate is deliberately NOT used as the anchor — a commission that was
 * "updated" today to still-pending is older than it looks.
 */
function computeAgeDays(raw: SovrnTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.commissionDate ?? raw.clickDate;
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

function toProgramme(raw: SovrnMerchantRaw): Programme {
  // Sovrn merchant IDs are not reliably exposed in the public API. We fall
  // back to a slugified merchant name when no ID is present.
  // // TODO(verify): confirm merchantId field name and whether it's always present.
  const id = raw.merchantId !== undefined
    ? String(raw.merchantId)
    : (raw.merchant ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const commissionRate = raw.commission !== undefined
    ? {
        type: 'unknown' as const,
        value: raw.commission,
        description: `Commission: ${raw.commission}${raw.currency ? ` ${raw.currency}` : ''}`,
      }
    : undefined;

  return {
    id,
    name: raw.merchant ?? `Sovrn merchant ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate,
    categories: undefined, // Sovrn Commerce does not expose merchant categories in the reporting API
    advertiserUrl: undefined, // Not available in the reporting API response
    rawNetworkData: raw,
  };
}

function toTransaction(raw: SovrnTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // publisherNetRevenue is the publisher's earnings. orderValue is the sale amount.
  // // TODO(verify): confirm field priority — publisherNetRevenue vs commission vs revenue.
  const commission = raw.publisherNetRevenue ?? raw.commission ?? raw.revenue ?? 0;
  const sale = raw.orderValue ?? commission;
  // Currency is not reliably present in all response shapes.
  // // TODO(verify): confirm currency field name.
  const currency = raw.currency ?? 'USD';

  const id =
    raw.revenueId !== undefined
      ? String(raw.revenueId)
      : raw.commissionId !== undefined
        ? String(raw.commissionId)
        : raw.clickId !== undefined
          ? String(raw.clickId)
          : '';

  const merchantId = raw.merchantId !== undefined
    ? String(raw.merchantId)
    : (raw.merchant ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    id,
    network: SLUG,
    programmeId: merchantId,
    programmeName: raw.merchant ?? `Sovrn merchant ${merchantId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: nullableIso(raw.clickDate),
    dateConverted: nullableIso(raw.commissionDate) ?? nullableIso(raw.clickDate) ?? new Date(0).toISOString(),
    dateApproved: nullableIso(raw.commissionDate),
    // Sovrn Commerce does not expose a paid-date on individual transactions.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: undefined, // Not available in the public API response
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date iteration helpers
// ---------------------------------------------------------------------------

/**
 * Generate an array of YYYY-MM-DD date strings covering [from, to] inclusive.
 *
 * Why we iterate day by day: Sovrn Commerce's transactions endpoint accepts
 * exactly one date parameter per call (clickDate, commissionDate, or
 * updateDate) in YYYY-MM-DD format — it does not support a date range. This
 * is consistent with the documented example:
 *   curl .../v1/reports/transactions?clickDate=2023-01-01
 *
 * The resulting list is used to make sequential calls and merge the results.
 * This is deliberately not parallelised to avoid rate limiting (Sovrn's
 * Commerce Merchants APIs have a documented rate limit of 1 request per 10s).
 *
 * // TODO(verify): confirm the per-10s rate limit applies to /reports/transactions
 * as well as /reports/merchants.
 */
function generateDateRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const endMs = new Date(to).setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= endMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Clamp the default window to 7 days to avoid excessive API calls.
 *
 * Sovrn requires one API call per day; a 30-day window means 30 calls. The
 * Awin adapter uses 30 days because Awin returns a full range in one call.
 * We default to 7 days here to keep the default case fast (7 calls).
 * Callers who need longer windows can pass explicit `from`/`to`.
 */
const DEFAULT_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Credential helpers (private to this adapter)
// ---------------------------------------------------------------------------

function requireSecretKey(operation: string): string {
  return requireCredential('SOVRN_SECRET_KEY', {
    network: SLUG,
    operation,
    hint:
      'Generate a Secret key at the Sovrn Commerce dashboard: Settings → Key icon → Generate Secret Key.',
  });
}

function requireApiKey(operation: string): string {
  return requireCredential('SOVRN_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your site API key at the Sovrn Commerce dashboard: Settings → Key icon next to your site.',
  });
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class SovrnCommerceAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List merchants the publisher has sent traffic to via Sovrn Commerce.
   *
   * Endpoint: GET /v1/reports/merchants
   *   Required params: at least one date (clickDate, commissionDate, updateDate)
   *
   * Why this maps to "programmes": Sovrn Commerce does not have a merchant
   * catalogue. All monetisation happens automatically through the publisher's
   * site script. The /reports/merchants endpoint returns aggregated performance
   * by merchant — i.e., the merchants you have actually worked with.
   *
   * Status: all returned merchants are treated as 'joined' (see mapProgrammeStatus).
   *
   * Date window: we use `from`/`to` from the query (defaulting to last 7 days).
   * Unlike listTransactions, /reports/merchants may support a date range
   * directly — we pass clickDate for the start of the window.
   * // TODO(verify): confirm whether /reports/merchants accepts a date range or
   * only a single date. If a range is supported, simplify this call.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const secretKey = requireSecretKey('listProgrammes');

    const now = new Date();
    const to = now;
    const from = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const clickDate = from.toISOString().slice(0, 10);

    const raw = await sovrnRequest<SovrnMerchantRaw[]>({
      operation: 'listProgrammes',
      path: '/v1/reports/merchants',
      secretKey,
      query: { clickDate },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (Array.isArray(raw) ? raw : []).map(toProgramme);

    // Client-side filters.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }

    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    void to; // suppress unused-variable warning — kept for future range extension
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single merchant's data by ID (or name).
   *
   * There is no single-merchant lookup endpoint in the public Sovrn Commerce
   * API. We call /reports/merchants and filter the result. The `programmeId`
   * may be either the merchantId (numeric) or a slugified merchant name —
   * we match on both.
   *
   * // TODO(verify): confirm whether a /reports/merchants?merchantId=... filter
   * exists server-side. If so, use it to avoid fetching all merchants.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Use listProgrammes to discover the merchant IDs available in your account.',
        }),
      );
    }

    const all = await this.listProgrammes();
    const found = all.find(
      (p) => p.id === programmeId || p.name.toLowerCase() === programmeId.toLowerCase(),
    );

    if (!found) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Sovrn Commerce merchant found with id or name "${programmeId}".`,
          hint:
            'Use listProgrammes to see all merchants in your account for the default date window. ' +
            'If the merchant sent traffic outside that window it may not appear.',
        }),
      );
    }

    return found;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commission events (transactions) for the given date window.
   *
   * Endpoint: GET /v1/reports/transactions
   *   Required: clickDate (YYYY-MM-DD) — one day per call.
   *
   * We iterate day-by-day over the requested window and merge the results.
   * The adapter is intentionally sequential rather than parallel to respect
   * Sovrn's documented rate limit.
   *
   * Date anchor: we use `clickDate` (the date of the click that generated
   * the commission) as the primary date filter. This matches the documented
   * curl example and is the most predictable date to query on.
   *
   * // TODO(verify): confirm whether commissionDate can be used as the date
   * parameter for more accurate "when was I owed money" queries.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const secretKey = requireSecretKey('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const dates = generateDateRange(from, to);

    const allRaw: SovrnTransactionRaw[] = [];
    for (const date of dates) {
      const chunk = await sovrnRequest<SovrnTransactionRaw[]>({
        operation: 'listTransactions',
        path: '/v1/reports/transactions',
        secretKey,
        query: { clickDate: date },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      if (Array.isArray(chunk)) {
        allRaw.push(...chunk);
      }
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Status filter.
    const statusFilter = toStatusList(query?.status);
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
   * Aggregate transactions into an earnings summary.
   *
   * Why derived from listTransactions (not a dedicated report endpoint):
   *   - Keeps ageDays available for oldestUnpaidAgeDays (PRD §15.9).
   *   - /reports/merchants provides aggregated data but not per-transaction
   *     ageing information.
   *   - The user can cross-check by calling listTransactions directly.
   *
   * Currency fallback: 'USD' (Sovrn Commerce is US-headquartered; most
   * publisher revenues are denominated in USD).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from =
      query?.from ??
      new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
          programmeName: t.programmeName || `Sovrn merchant ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid age.
      if (t.status === 'pending' || t.status === 'approved' || t.status === 'other') {
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
   * Sovrn Commerce does not expose a click-stream API to publishers.
   *
   * The /reports/links endpoint provides aggregated click counts per link but
   * not individual click events (no click ID, no timestamp, no referrer). This
   * is insufficient to populate the `Click` type (which requires a per-event
   * `timestamp`).
   *
   * We throw NotImplementedError rather than returning [] so callers understand
   * the difference between "no clicks" and "clicks not available" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Sovrn Commerce does not expose individual click events via the public publisher API. ' +
        'The /reports/links endpoint provides aggregated click counts, not a per-event stream.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Sovrn Commerce (VigLink) affiliate tracking link.
   *
   * Format (from public documentation and observed redirect.viglink.com URLs):
   *   https://redirect.viglink.com/?key={apiKey}&u={encodedDestinationUrl}
   *
   * Parameters:
   *   key — the publisher's site API key (SOVRN_API_KEY), embeddable in pages.
   *   u   — the destination URL, URL-encoded.
   *   opt — optional; "true" to opt in to link rewriting (commonly seen in
   *         the wild, but not always required).
   *
   * Why deterministic: the redirect.viglink.com host and parameter names are
   * stable and publicly documented. No API call is required to construct the
   * URL — all inputs are known at call time. This avoids latency and a
   * potential failure mode.
   *
   * programmeId: Sovrn Commerce links do not require a merchant/programme ID
   * in the tracking URL — the platform resolves the merchant from the
   * destination URL automatically. We accept it as an optional annotation
   * on the returned TrackingLink but do not use it in the URL.
   *
   * Sources:
   *   https://github.com/Sh1d0w/clean-links/issues/20
   *   https://knowledge.sovrn.com/kb/javascript-for-commerce
   *   // TODO(verify): confirm ?key=&u= is the correct redirect.viglink.com format
   *   // and whether any additional params (opt, prodOvrd) are required.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the page you want to link to.',
        }),
      );
    }

    // Validate the API key is configured — fail fast so users don't generate
    // links with a missing key that will silently not track.
    const apiKey = requireApiKey('generateTrackingLink');

    // The Secret key is not used in tracking links; we do not require it here.
    // The caller may not have the Secret key if they only want to generate links.

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `${VIGLINK_REDIRECT_HOST}` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&u=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'redirect.viglink.com deterministic construction',
        key: apiKey,
        u: input.destinationUrl,
        programmeId: input.programmeId || undefined,
      },
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
  // Admin operations (v0.2 scaffolds)
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

  /**
   * Probe each operation to record live capability data.
   *
   * listClicks is recorded as unsupported without probing — the API does not
   * have the endpoint; probing would be wasteful.
   *
   * generateTrackingLink is deterministic; we record it as supported without
   * a live probe (the link is constructed locally from the API key).
   *
   * getProgramme is not probed — it requires a known merchant ID.
   */
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
    await probe('getEarningsSummary', () =>
      this.getEarningsSummary({
        from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
        limit: undefined,
      }),
    );
    await probe('verifyAuth', () => this.verifyAuth());

    // listClicks: known-unsupported.
    operations['listClicks'] = {
      supported: false,
      note:
        'Sovrn Commerce does not expose individual click events via the public publisher API.',
    };

    // generateTrackingLink: deterministic — no live probe needed.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction via redirect.viglink.com; no live probe.',
    };

    // getProgramme: derived from listProgrammes — requires a known merchant ID.
    operations['getProgramme'] = {
      supported: true,
      note: 'Derived from /v1/reports/merchants; requires a known merchant id or name.',
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
// Module-level registration (side effect on import)
// ---------------------------------------------------------------------------

export const sovrnCommerceAdapter = new SovrnCommerceAdapter();
registerAdapter(sovrnCommerceAdapter);

// ---------------------------------------------------------------------------
// Internals exported for unit tests
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  generateDateRange,
};

// Silence unused-import lint warnings.
void log;
