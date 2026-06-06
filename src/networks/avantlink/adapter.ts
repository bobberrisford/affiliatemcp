/**
 * AvantLink adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * (the canonical reference) and `src/networks/everflow/adapter.ts` (a custom-
 * auth, single-file publisher adapter). Read the Awin header for the full
 * reasoning behind status normalisation, `ageDays`, date chunking, and the
 * module-level registration side effect.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Query parameters, not headers. `affiliate_id` + `auth_key`
 *          authenticate; `website_id` scopes reports and links to a registered
 *          site. There is no Authorization header and no token exchange.
 * Base:    https://classic.avantlink.com/api.php  (a single REST "report
 *          framework" endpoint; the `module=` query parameter selects what runs)
 * Output:  We request `output=json`. CustomLink returns a bare URL string.
 * Docs:    API Module Documentation —
 *            https://support.avantlink.com/hc/en-us/sections/200985665-API-Module-Documentation
 *          Affiliate API Technical Integration —
 *            https://support.avantlink.com/hc/en-us/articles/203644699-Affiliate-API-Technical-Integration
 *
 * --- Module map -------------------------------------------------------------
 *
 *   module=AssociationFeed
 *     → merchants (programmes) the affiliate is associated with, scoped to the
 *       website. Used by listProgrammes / getProgramme and the auth check.
 *       (https://www.avantlink.com/api.php?help=1&module=AssociationFeed)
 *   module=AffiliateReport&report_id=8&date_begin=YYYY-MM-DD&date_end=YYYY-MM-DD
 *     → Sales/Commissions (Detail) report rows. report_id 8 is the
 *       sale/commission detail report; report_id 5/6 are click-through reports.
 *       (https://support.avantlink.com/hc/en-us/articles/203644699-Affiliate-API-Technical-Integration)
 *   module=CustomLink&merchant_id=...&merchant_url=...&custom_string=...
 *     → a tracking ("custom") link as a bare URL string. No auth_key required
 *       for this module; affiliate_id + website_id + merchant_id scope it.
 *       (https://support.avantlink.com/hc/en-us/articles/203994469-CustomLink)
 *   module=ProductSearch
 *     → product catalogue search; not part of the seven canonical operations.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `avantlinkRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. The user-visible noun is "programme" not "program".
 *
 * --- Known limitations (mirror network.json) --------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live AvantLink account. Treat field names and report shapes as provisional.
 *   - Monetary amounts are assumed to be decimal currency units (e.g. "12.50"
 *     in USD), not minor units (cents); confirm against a live account before
 *     promotion to production.
 *   - Click-level data is not exposed as a stable per-click feed via the
 *     affiliate API; listClicks is unsupported.
 */

import { avantlinkRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireAffiliateId,
  requireApiKey,
  requireWebsiteId,
} from './auth.js';
import { setupSteps } from './setup.js';
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

const log = createLogger('avantlink.adapter');

const SLUG = 'avantlink';
const NAME = 'AvantLink';

/**
 * The AffiliateReport report_id for the Sales/Commissions (Detail) report.
 * Confirmed against the Affiliate API Technical Integration docs and the
 * community avantlink-report library (report_id 8 = sale/commission detail;
 * 5/6 = click-throughs).
 */
const REPORT_ID_SALES_COMMISSIONS = 8;

/**
 * AvantLink does not publicly document a maximum window for AffiliateReport.
 * We chunk wide ranges into 31-day slices defensively (the same affordance as
 * Awin) so a caller asking for a year of data does not trip an undocumented
 * server-side cap. If a live account proves the report accepts arbitrary
 * windows, this can be widened without changing the call shape.
 */
const REPORT_MAX_WINDOW_DAYS = 31;

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // The single REST report-framework endpoint. The `module=` query parameter
  // selects the operation.
  baseUrl: 'https://classic.avantlink.com/api.php',
  // AvantLink authenticates via query parameters (affiliate_id + auth_key),
  // not a standard Authorization header — `custom` is the closest model.
  authModel: 'custom',
  docsUrl: 'https://support.avantlink.com/hc/en-us/sections/200985665-API-Module-Documentation',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live AvantLink account.',
    'Monetary amounts are assumed to be decimal currency units (e.g. 12.50), not minor units (cents); confirm against a live account.',
    'Click-level data is not exposed as a stable per-click feed via the affiliate API; listClicks is unsupported.',
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
 * The AffiliateReport report engine can be slow when the date window is wide.
 * Give the report-backed operations a 60s timeout and 3 retries, matching the
 * pattern Awin uses for its transactions endpoint.
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
// AvantLink response shapes (deliberately minimal — see Awin adapter for rationale)
// ---------------------------------------------------------------------------
//
// AvantLink's JSON shapes are not strongly documented and vary by module/report.
// Every transformer treats every field as possibly absent and preserves the
// original under `rawNetworkData`. Field names below are the best inference
// from the public docs and MUST be re-checked against a live account.

/** One merchant association row from module=AssociationFeed. */
interface AvantLinkMerchantRaw {
  merchant_id?: number | string;
  lngMerchantId?: number | string;
  merchant_name?: string;
  strMerchantName?: string;
  // Association / relationship status: AvantLink commonly returns "Active",
  // "Pending", "Declined" / "Rejected" for the affiliate's standing with a
  // merchant programme.
  association_status?: string;
  strAccountStatus?: string;
  status?: string;
  // Commission descriptor — often a free-text string or a percentage figure.
  commission?: string;
  strCommissionDetail?: string;
  category?: string;
  strCategory?: string;
  website?: string;
  strWebsiteUrl?: string;
  merchant_homepage?: string;
}

/** One sale/commission detail row from module=AffiliateReport&report_id=8. */
interface AvantLinkTransactionRaw {
  // AvantLink report column names vary; we read the common aliases.
  order_id?: string;
  transaction_id?: string;
  strOrderId?: string;
  merchant_id?: number | string;
  lngMerchantId?: number | string;
  merchant_name?: string;
  strMerchantName?: string;
  // Status of the transaction line. Observed values include "Open"/"Pending",
  // "Confirmed"/"Paid", "Reversed"/"Returned".
  transaction_status?: string;
  strTransactionStatus?: string;
  status?: string;
  // Money. Assumed to be decimal currency units (see META.knownLimitations).
  sale_amount?: number | string;
  curBaseSaleAmount?: number | string;
  order_total?: number | string;
  commission?: number | string;
  curCommission?: number | string;
  currency?: string;
  strCurrency?: string;
  // Dates. AvantLink reports use date or datetime strings.
  transaction_date?: string;
  dtTransaction?: string;
  order_date?: string;
  click_date?: string;
  dtClick?: string;
  // Reversal context, when present.
  reversal_reason?: string;
  strReversalReason?: string;
}

/** Envelope wrappers AvantLink uses around report rows in some responses. */
interface AvantLinkAssociationEnvelope {
  merchants?: AvantLinkMerchantRaw[];
  associations?: AvantLinkMerchantRaw[];
  data?: AvantLinkMerchantRaw[];
  [key: string]: AvantLinkMerchantRaw[] | undefined;
}

interface AvantLinkReportEnvelope {
  transactions?: AvantLinkTransactionRaw[];
  report?: AvantLinkTransactionRaw[];
  data?: AvantLinkTransactionRaw[];
  [key: string]: AvantLinkTransactionRaw[] | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstString(...vals: Array<string | number | undefined>): string | undefined {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.trim() !== '') return s;
  }
  return undefined;
}

/** Parse a money field that may arrive as a number or a decimal string. */
function toAmount(...vals: Array<number | string | undefined>): number {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.+-]/g, ''));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * Normalise an AvantLink report response into an array of rows regardless of
 * whether the module returned a bare array or wrapped it in an envelope key.
 */
function asArray<T>(response: T[] | Record<string, unknown>, keys: string[]): T[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    for (const key of keys) {
      const v = (response as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/**
 * Status normalisation: AvantLink association status → canonical ProgrammeStatus.
 *
 * AvantLink describes the affiliate's standing with a merchant programme with
 * free-text values that vary in casing. We collapse to our enum:
 *
 *   active / approved        → 'joined'
 *   pending / applied        → 'pending'
 *   declined / rejected      → 'declined'
 *   available / not joined   → 'available'
 *   paused / suspended       → 'suspended'
 *   anything else            → 'unknown'
 *
 * Prefer `unknown` over a wrong guess — AvantLink adds states over time and the
 * raw value is preserved under rawNetworkData.
 */
function mapProgrammeStatus(raw: AvantLinkMerchantRaw): ProgrammeStatus {
  const s = (
    raw.association_status ??
    raw.strAccountStatus ??
    raw.status ??
    ''
  )
    .toString()
    .toLowerCase()
    .trim();
  if (s === 'active' || s === 'approved' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'applied' || s === 'under review') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'not joined' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: AvantLink transaction status → canonical TransactionStatus.
 *
 * Observed AvantLink sale/commission statuses (casing varies):
 *   open / pending            → 'pending'
 *   confirmed / approved      → 'approved'
 *   paid                      → 'paid'
 *   reversed / returned /
 *     cancelled / declined    → 'reversed'  (the sale did not pay out)
 *   anything else             → 'other'
 */
function mapTransactionStatus(raw: AvantLinkTransactionRaw): TransactionStatus {
  const s = (
    raw.transaction_status ??
    raw.strTransactionStatus ??
    raw.status ??
    ''
  )
    .toString()
    .toLowerCase()
    .trim();
  if (s === 'paid') return 'paid';
  if (s === 'open' || s === 'pending' || s === 'new') return 'pending';
  if (s === 'confirmed' || s === 'approved' || s === 'validated') return 'approved';
  if (
    s === 'reversed' ||
    s === 'returned' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'declined' ||
    s === 'rejected'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Compute the age (in days) of a transaction at the moment the adapter responds.
 * PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * AvantLink does not document a separate validation/approval date on the
 * sale/commission report, so we anchor on the transaction date (falling back to
 * the order date). If a live account exposes an approval date, prefer it here.
 */
function computeAgeDays(raw: AvantLinkTransactionRaw, now: Date = new Date()): number {
  const anchor = firstString(raw.transaction_date, raw.dtTransaction, raw.order_date);
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
// Transformers (AvantLink raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: AvantLinkMerchantRaw): Programme {
  const id = firstString(raw.merchant_id, raw.lngMerchantId) ?? '';
  const commission = firstString(raw.commission, raw.strCommissionDetail);
  const category = firstString(raw.category, raw.strCategory);
  return {
    id,
    name: firstString(raw.merchant_name, raw.strMerchantName) ?? `AvantLink merchant ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    commissionRate: commission
      ? { type: 'unknown', description: commission }
      : undefined,
    categories: category ? [category] : [],
    advertiserUrl: firstString(raw.website, raw.strWebsiteUrl, raw.merchant_homepage),
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AvantLinkTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission, raw.curCommission);
  const sale = toAmount(raw.sale_amount, raw.curBaseSaleAmount, raw.order_total);
  // AvantLink is a US/outdoor-niche network; default currency USD when the row
  // does not carry one. The raw row is preserved for the user to disambiguate.
  const currency = firstString(raw.currency, raw.strCurrency) ?? 'USD';
  const merchantId = firstString(raw.merchant_id, raw.lngMerchantId) ?? '';

  const transactionDate =
    nullableIso(firstString(raw.transaction_date, raw.dtTransaction, raw.order_date)) ??
    new Date(0).toISOString();
  const clickDate = nullableIso(firstString(raw.click_date, raw.dtClick));

  return {
    id: firstString(raw.order_id, raw.transaction_id, raw.strOrderId) ?? '',
    network: SLUG,
    programmeId: merchantId,
    programmeName: firstString(raw.merchant_name, raw.strMerchantName) ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    // AvantLink's sale/commission report does not document a distinct approval
    // or paid date column; leave them undefined rather than fabricating.
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? firstString(raw.reversal_reason, raw.strReversalReason)
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date helpers for AvantLink reporting
// ---------------------------------------------------------------------------

/**
 * Format a Date for AvantLink's `date_begin`/`date_end` parameters.
 * AvantLink reports use `YYYY-MM-DD` (confirmed via the community
 * avantlink-report library: `date_begin: '2016-07-12'`).
 */
function formatAvantLinkDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. AvantLink does not document a
 * cap on AffiliateReport, so this is defensive (see REPORT_MAX_WINDOW_DAYS).
 * Mirrors Awin's `chunkDateRange`.
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AvantLinkAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the merchant programmes the affiliate is associated with.
   *
   * AvantLink module: AssociationFeed — returns the affiliate's merchant
   * associations for the configured website. There is no documented free-text
   * search or status filter on this module, so we apply search / status /
   * category / limit filters client-side (the same approach as Awin).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const affiliateId = requireAffiliateId('listProgrammes');
    const authKey = requireApiKey('listProgrammes');
    const websiteId = requireWebsiteId('listProgrammes');

    const raw = await avantlinkRequest<
      AvantLinkMerchantRaw[] | AvantLinkAssociationEnvelope
    >({
      operation: 'listProgrammes',
      module: 'AssociationFeed',
      query: {
        affiliate_id: affiliateId,
        auth_key: authKey,
        website_id: websiteId,
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = asArray<AvantLinkMerchantRaw>(raw, [
      'merchants',
      'associations',
      'data',
    ]).map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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
   * Fetch a single merchant programme by AvantLink merchant ID.
   *
   * AvantLink's AssociationFeed does not document a single-merchant lookup
   * endpoint, so we fetch the association feed and select the matching merchant
   * client-side. If a live account exposes a per-merchant filter parameter,
   * prefer it here to avoid pulling the whole feed.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `AvantLink merchant IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_avantlink_list_programmes to discover valid merchant IDs.',
        }),
      );
    }

    const affiliateId = requireAffiliateId('getProgramme');
    const authKey = requireApiKey('getProgramme');
    const websiteId = requireWebsiteId('getProgramme');

    const raw = await avantlinkRequest<
      AvantLinkMerchantRaw[] | AvantLinkAssociationEnvelope
    >({
      operation: 'getProgramme',
      module: 'AssociationFeed',
      query: {
        affiliate_id: affiliateId,
        auth_key: authKey,
        website_id: websiteId,
        // Pass merchant_id as a hint; harmless if the module ignores it, and
        // it lets a forward-compatible AvantLink narrow the feed server-side.
        merchant_id: programmeId,
      },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const rows = asArray<AvantLinkMerchantRaw>(raw, ['merchants', 'associations', 'data']);
    const match =
      rows.find(
        (m) => firstString(m.merchant_id, m.lngMerchantId) === programmeId,
      ) ?? rows[0];

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `AvantLink returned no association for merchant ${programmeId}.`,
          hint: 'The affiliate may not be associated with this merchant on the configured website.',
        }),
      );
    }

    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List sale/commission transactions via the AffiliateReport module.
   *
   * AvantLink endpoint:
   *   module=AffiliateReport&report_id=8&output=json
   *     &date_begin=YYYY-MM-DD&date_end=YYYY-MM-DD
   *     &affiliate_id=...&auth_key=...&website_id=...
   *
   * report_id 8 is the Sales/Commissions (Detail) report. Dates are `YYYY-MM-DD`.
   * AvantLink does not document a per-call window cap, so we chunk wide windows
   * into 31-day slices defensively (REPORT_MAX_WINDOW_DAYS) the way Awin does.
   *
   * Filters (programme, status, age, limit) are applied client-side after the
   * report rows are normalised, so a query like
   * `{ status: 'approved', minAgeDays: 180 }` is meaningful (PRD §15.9).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const affiliateId = requireAffiliateId('listTransactions');
    const authKey = requireApiKey('listTransactions');
    const websiteId = requireWebsiteId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, REPORT_MAX_WINDOW_DAYS);

    const allRaw: AvantLinkTransactionRaw[] = [];
    for (const slice of slices) {
      const chunk = await avantlinkRequest<
        AvantLinkTransactionRaw[] | AvantLinkReportEnvelope
      >({
        operation: 'listTransactions',
        module: 'AffiliateReport',
        query: {
          affiliate_id: affiliateId,
          auth_key: authKey,
          website_id: websiteId,
          report_id: REPORT_ID_SALES_COMMISSIONS,
          date_begin: formatAvantLinkDate(slice.start),
          date_end: formatAvantLinkDate(slice.end),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...asArray<AvantLinkTransactionRaw>(chunk, ['transactions', 'report', 'data']));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status);
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
   * Aggregate the sale/commission report into an earnings summary.
   *
   * We derive the summary from `listTransactions` (not a separate aggregated
   * report) for the same reason as Awin: the per-transaction `ageDays` needed
   * for `oldestUnpaidAgeDays` is only available from the detail rows, and
   * deriving from transactions keeps the summary auditable — the user can call
   * listTransactions and recompute the same numbers.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // never apply a limit inside a summary — would undercount
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
          programmeName: t.programmeName || `AvantLink merchant ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved-but-not-yet-paid).
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
   * AvantLink does not expose a stable per-click data feed via the affiliate
   * API. The AffiliateReport click-through reports (report_id 5/6) are
   * aggregate summaries, not individual click rows that map onto the `Click`
   * type, so we do not synthesise click records from them.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — "AvantLink does not expose per-click data" is a different, more
   * actionable fact than "AvantLink returned no clicks" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'AvantLink does not expose per-click data via the affiliate API; only aggregate click-through reports are available',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Generate an AvantLink tracking ("custom") link via the CustomLink module.
   *
   * AvantLink endpoint:
   *   module=CustomLink&affiliate_id=...&website_id=...&merchant_id=...
   *     &merchant_url=<destination, URL-encoded>
   *
   * Unlike Awin (deterministic construction), AvantLink builds the click-through
   * URL server-side from the affiliate/website/merchant tuple, so an API call is
   * required. The CustomLink module does not require the auth_key (confirmed in
   * the CustomLink docs); affiliate_id + website_id + merchant_id scope it.
   *
   * `programmeId` is the AvantLink merchant ID and is required, because the
   * tracking link is merchant-specific.
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
          message: 'AvantLink tracking links require the merchant (programme) ID.',
          hint:
            'Pass `programmeId`. Use affiliate_avantlink_list_programmes to discover merchant IDs.',
        }),
      );
    }
    if (!/^\d+$/.test(input.programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `AvantLink merchant IDs are numeric; received "${input.programmeId}".`,
          hint: 'Use affiliate_avantlink_list_programmes to discover valid merchant IDs.',
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
          hint: 'Pass the full URL of the merchant page you want to link to.',
        }),
      );
    }

    const affiliateId = requireAffiliateId('generateTrackingLink');
    const websiteId = requireWebsiteId('generateTrackingLink');

    // CustomLink returns a bare tracking URL string, not a JSON document.
    const body = await avantlinkRequest<string>({
      operation: 'generateTrackingLink',
      module: 'CustomLink',
      output: 'text',
      expectText: true,
      query: {
        affiliate_id: affiliateId,
        website_id: websiteId,
        merchant_id: input.programmeId,
        merchant_url: input.destinationUrl,
      },
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const trackingUrl = body.trim();
    if (!trackingUrl || !/^https?:\/\//i.test(trackingUrl)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          httpStatus: 200,
          networkErrorBody: body,
          message: `AvantLink CustomLink did not return a tracking URL for merchant ${input.programmeId}.`,
          hint: 'Confirm the affiliate is associated with this merchant on the configured website.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: { module: 'CustomLink', body },
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

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        operations[name] = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
          claimStatus: 'experimental',
        };
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
      note: 'AvantLink does not expose per-click data via the affiliate API.',
    };

    // generateTrackingLink + getProgramme need a known merchant ID — mark as
    // experimental without probing to keep the diagnostic fast.
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known merchant ID; not probed automatically.',
    };
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known merchant ID; not probed automatically.',
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

export const avantlinkAdapter = new AvantLinkAdapter();
registerAdapter(avantlinkAdapter);

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
  formatAvantLinkDate,
  toAmount,
  asArray,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
