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
    'Adapter built from public API documentation; response field names confirmed from developer.sovrn.com but not yet verified against a live account.',
    'The /v1/reports/transactions endpoint accepts one clickDate per call (rate limit: 1 req/60 s); wide date windows require many sequential calls.',
    'Click-level data is not exposed as a distinct click-stream API; listClicks is unsupported.',
    'Merchant (programme) listing uses /v1/reports/merchants, which returns aggregated data for merchants with activity on the given date — not a full catalogue.',
    'getProgramme is derived from /v1/reports/merchants filtered client-side; no single-merchant lookup endpoint exists in the public API.',
    'Sovrn Commerce /v1/reports/transactions does not include a status field; all transactions are mapped to canonical status "other".',
    'No currency field is present in the /v1/reports/transactions or /v1/reports/merchants response; currency defaults to USD.',
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
// The /v1/reports/transactions endpoint returns a top-level wrapper object:
//   { "transactions": [ ...transaction objects... ] }
// Each transaction object has nested sub-objects: account, commission, click,
// merchant, and product. Field names confirmed from the Sovrn Developer Centre
// at developer.sovrn.com/reference/get_reports-transactions and from
// multi-source search verification against the VigLink developer centre at
// viglink-developer-center.readme.io.
//
// The /v1/reports/merchants endpoint is documented at
// developer.sovrn.com/reference/get_reports-merchants and returns aggregated
// metrics (Revenue, Clicks, Sales, Actions, Conversion Rate, EPC) keyed by
// merchantGroupId/merchantGroupName. A single clickDate parameter (YYYY-MM-DD)
// is required; the endpoint does NOT support an open-ended date range
// (confirmed: same single-date-per-call model as transactions).

/** Top-level wrapper returned by GET /v1/reports/transactions */
interface SovrnTransactionsEnvelope {
  transactions?: SovrnTransactionRaw[];
}

/**
 * A single transaction object inside the "transactions" array.
 *
 * The response is organised into nested sub-objects.
 * Source: developer.sovrn.com/reference/get_reports-transactions
 *         (confirmed via viglink-developer-center.readme.io and multi-source
 *          search verification — 2026-05-28 hardening pass).
 *
 * Key confirmed facts:
 *  - No top-level "status" field exists; transactions do not carry an explicit
 *    status enum. Confirmed: not in the documented response schema.
 *  - No "currency" field exists at the transaction level. Sovrn Commerce
 *    publishes earnings in USD; the adapter defaults to 'USD'. Confirmed absent
 *    from the documented response schema.
 *  - commission.publisherNetRevenue is the publisher's earnings field.
 *  - merchant.merchantGroupId / merchant.merchantGroupName identify the merchant
 *    (Sovrn uses "merchantGroup" terminology, not "merchant" / "merchantId").
 */
interface SovrnTransactionRaw {
  account?: {
    accountId?: number;
    campaignId?: number;       // publisher's campaign/site ID
    campaignName?: string;
  };
  commission?: {
    revenueId?: string | number;      // unique identifier for the commission event
    commissionId?: string | number;   // alternative identifier
    commissionDate?: string;          // YYYY-MM-DD — when the commission was recorded
    updateDate?: string;              // YYYY-MM-DD — when the record was last updated
    orderValue?: number;              // gross sale value
    publisherNetRevenue?: number;     // publisher's net earnings (the primary earnings field)
    programType?: string;             // "cpa" or "cpc"
  };
  click?: {
    clickId?: string | number;
    clickDate?: string;               // YYYY-MM-DD — the date of the originating click
    cuid?: string;                    // custom user ID (publisher-assigned)
    linkUrl?: string;
    pageUrl?: string;
    country?: string;
    device?: string;
    sovrnProduct?: string;
    linkUtmInfo?: Record<string, unknown>;
    pageUtmInfo?: Record<string, unknown>;
  };
  merchant?: {
    merchantGroupId?: number | string;   // Sovrn's merchant group identifier
    merchantGroupName?: string;          // Sovrn's merchant group name
    network?: string;                    // e.g. "Sovrn"
  };
  product?: unknown[];
}

/**
 * A single row from GET /v1/reports/merchants.
 *
 * This endpoint returns aggregated performance metrics per merchant group.
 * Metrics: Revenue, Clicks, Sales, Actions, Conversion Rate, EPC.
 * Source: developer.sovrn.com/reference/get_reports-merchants
 *
 * The endpoint requires a clickDate parameter (YYYY-MM-DD) and does NOT
 * support an open date range — same single-date model as /reports/transactions.
 * Confirmed: no merchantId (legacy) field; Sovrn uses merchantGroupId/Name.
 * Confirmed: no currency field in the merchants response.
 * Rate limit: 1 request per 10 seconds (Commerce Merchants section).
 * Source: support.viglink.com/hc/en-us/articles/360008095914
 */
interface SovrnMerchantRaw {
  merchantGroupId?: number | string;
  merchantGroupName?: string;
  clicks?: number;
  revenue?: number;
  commission?: number;
  epc?: number;              // earnings per click
  sales?: number;
  actions?: number;
  conversionRate?: number;
  // No currency field confirmed present in the merchants response.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise transaction status.
 *
 * Sovrn Commerce's /reports/transactions endpoint does NOT expose a status
 * field. This is confirmed by the published API schema at
 * developer.sovrn.com/reference/get_reports-transactions: the commission
 * sub-object contains revenueId, commissionId, commissionDate, updateDate,
 * orderValue, publisherNetRevenue, and programType — no status enum.
 *
 * We permanently return 'other'. This is recorded in known_limitations.
 * The updateDate field can tell you a commission was revised, but not what
 * state it is in.
 *
 * Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
 */
function mapTransactionStatus(_raw: SovrnTransactionRaw): TransactionStatus {
  // No status field in the Sovrn Commerce transactions response. 'other' is
  // the canonical safe default per PRD cardinal rule 4.
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
  // Prefer commission.commissionDate (when the commission was recorded) over
  // click.clickDate (when the click occurred). commissionDate is the correct
  // anchor for "how long has this commission been sitting unresolved".
  const anchor = raw.commission?.commissionDate ?? raw.click?.clickDate;
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
  // Sovrn uses "merchantGroupId" and "merchantGroupName" — confirmed from the
  // developer.sovrn.com/reference/get_reports-merchants documentation
  // (hardening pass 2026-05-28). There is no "merchantId" or "merchant" field.
  const id = raw.merchantGroupId !== undefined
    ? String(raw.merchantGroupId)
    : (raw.merchantGroupName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const commissionRate = raw.commission !== undefined
    ? {
        type: 'unknown' as const,
        value: raw.commission,
        // No currency field in the merchants response; omit from description.
        description: `Commission: ${raw.commission}`,
      }
    : undefined;

  return {
    id,
    name: raw.merchantGroupName ?? `Sovrn merchant group ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    // No currency field in the /reports/merchants response.
    currency: undefined,
    commissionRate,
    categories: undefined, // Sovrn Commerce does not expose merchant categories in the reporting API
    advertiserUrl: undefined, // Not available in the reporting API response
    rawNetworkData: raw,
  };
}

function toTransaction(raw: SovrnTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);

  // commission.publisherNetRevenue is the publisher's earnings field — confirmed
  // as the primary earnings value at developer.sovrn.com/reference/get_reports-transactions.
  // commission.orderValue is the gross sale amount.
  // Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
  const commission = raw.commission?.publisherNetRevenue ?? 0;
  const sale = raw.commission?.orderValue ?? commission;

  // No currency field exists in the /reports/transactions response.
  // Sovrn Commerce operates primarily in USD. Default to 'USD'.
  // Source: confirmed absent from documented response schema (2026-05-28).
  const currency = 'USD';

  // Prefer commission.revenueId as the primary transaction identifier.
  // Fall back to commissionId, then click.clickId.
  const id =
    raw.commission?.revenueId !== undefined
      ? String(raw.commission.revenueId)
      : raw.commission?.commissionId !== undefined
        ? String(raw.commission.commissionId)
        : raw.click?.clickId !== undefined
          ? String(raw.click.clickId)
          : '';

  // merchant.merchantGroupId / merchant.merchantGroupName identify the merchant.
  // Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
  const merchantId = raw.merchant?.merchantGroupId !== undefined
    ? String(raw.merchant.merchantGroupId)
    : (raw.merchant?.merchantGroupName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    id,
    network: SLUG,
    programmeId: merchantId,
    programmeName: raw.merchant?.merchantGroupName ?? `Sovrn merchant group ${merchantId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: nullableIso(raw.click?.clickDate),
    dateConverted:
      nullableIso(raw.commission?.commissionDate) ??
      nullableIso(raw.click?.clickDate) ??
      new Date(0).toISOString(),
    dateApproved: nullableIso(raw.commission?.commissionDate),
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
 * This is deliberately not parallelised to respect Sovrn's documented rate
 * limits:
 *   - /reports/transactions: 1 request per 60 seconds (Commerce Real-Time Reports)
 *   - /reports/merchants: 1 request per 10 seconds (Commerce Merchants)
 * Source: support.viglink.com/hc/en-us/articles/360008095914 (2026-05-28).
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
   * Date window: /reports/merchants accepts exactly ONE clickDate parameter
   * (YYYY-MM-DD) per call — the same single-date-per-call model as
   * /reports/transactions. No date-range variant exists.
   * Source: developer.sovrn.com/reference/get_reports-merchants (2026-05-28).
   *
   * We pass `from` (defaulting to 7 days ago) to get a recent merchant list.
   * For a comprehensive merchant list, callers should pass a date with known
   * traffic. The API returns only merchants with activity on that date.
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
   * No server-side merchantGroupId filter exists on /reports/merchants.
   * The merchantGroupIds query parameter on /reports/transactions accepts a
   * comma-separated list of IDs to restrict results, but /reports/merchants
   * has no equivalent filter. Client-side filtering is the correct approach.
   * Source: developer.sovrn.com/reference/get_reports-merchants (2026-05-28).
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
   * All three date parameters (clickDate, commissionDate, updateDate) are
   * supported as alternative date filters. Using commissionDate filters by
   * when the commission was recorded — useful for "when was I owed money".
   * Using updateDate filters by when a record was last changed — useful for
   * catching reversals. We default to clickDate for predictability.
   * Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
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
      // The /v1/reports/transactions endpoint returns a wrapper object:
      //   { "transactions": [ ...transaction objects... ] }
      // Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
      const envelope = await sovrnRequest<SovrnTransactionsEnvelope>({
        operation: 'listTransactions',
        path: '/v1/reports/transactions',
        secretKey,
        query: { clickDate: date },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const chunk = envelope?.transactions;
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
   * Confirmed format: https://redirect.viglink.com?key={API_KEY}&u={encodedUrl}
   *   - "key" and "u" are the only required parameters.
   *   - "cuid" is an optional publisher-assigned custom user ID for tracking.
   *   - "opt" and "prodOvrd" appear in some observed URLs but are NOT required
   *     for basic tracking — they are platform-specific overrides.
   * Sources:
   *   support.viglink.com/hc/en-us/articles/360004112874 (2026-05-28)
   *   knowledge.sovrn.com/kb/cuids-in-commerce (2026-05-28)
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
