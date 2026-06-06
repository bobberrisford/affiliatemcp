/**
 * Affiliate Future adapter — publisher side.
 *
 * Affiliate Future is a UK affiliate network. Its publisher API is a set of
 * dated WCF (`.svc`) endpoints under
 * `https://api.affiliatefuture.com/PublisherService.svc/`, authenticated by an
 * API key (`key`) and password (`passcode`) carried as query parameters on
 * every call (see `client.ts`). The service can serialise XML or JSON; this
 * adapter requests the JSON variant.
 *
 * This file follows the Awin reference (`src/networks/awin/adapter.ts`) — read
 * that file first. The cardinal rules apply unchanged:
 *
 *   1. NEVER call `fetch` directly. Use `affiliateFutureRequest` from
 *      `./client.ts` so the resilience layer applies.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope` carrying the
 *      network, operation, httpStatus, and verbatim body (PRD principle 4.1).
 *   3. PRESERVE the raw response on `rawNetworkData` for every domain object.
 *   4. NORMALISE status enums to the canonical set; prefer `unknown`/`other`
 *      over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme", not "program").
 *
 * --- Affiliate Future API map (verify against the publisher API docs) -------
 *
 *   GET /PublisherService.svc/GetAFMerchantList
 *     ?key= &passcode= &merchantsJoined=YES|NO|ALL &newMerchants=YES|NO
 *     → list of merchant programmes. Used by listProgrammes, getProgramme
 *       (client-side filter), and verifyAuth.
 *   GET /PublisherService.svc/GetTransactionListbyDate
 *     ?key= &passcode= &startDate=DD-MMM-YYYY &endDate=DD-MMM-YYYY
 *     → transactions. IMPORTANT: a single call is limited to ONE day. The
 *       adapter chunks the requested window into 1-day slices and loops.
 *   GET /PublisherService.svc/GetCancelledTransactionListbyDate  → cancellations.
 *   GET /PublisherService.svc/Get2ndLevelLeadsTransactionListbyDate → 2nd-tier.
 *   GET /PublisherService.svc/GetPaymentReport → payments.
 *
 * The cancellation, 2nd-tier, and payment endpoints are documented but not
 * wired into the seven canonical operations at v0.1 — the transaction list is
 * the canonical earnings record. They are recorded as a known limitation.
 *
 * --- Amount unit ------------------------------------------------------------
 *
 * The public documentation does not state the unit of `SaleValue` /
 * `SaleCommission`. We ASSUME major currency units (e.g. pounds, not pence) and
 * record that assumption in `META.knownLimitations`. The verbatim values are
 * always preserved on `rawNetworkData` so a user can reconcile.
 */

import { affiliateFutureRequest } from './client.js';
import { verifyAuth as authVerify, requireCredentials } from './auth.js';
import { validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { getCredential } from '../../shared/config.js';
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

const log = createLogger('affiliate-future.adapter');

const SLUG = 'affiliate-future';
const NAME = 'Affiliate Future';

const EXPERIMENTAL_LIMITATION =
  'Experimental: the adapter has not been validated against a live Affiliate Future publisher account; the JSON response shapes are inferred from public documentation.';
const AMOUNT_UNIT_LIMITATION =
  'Amount unit assumption: SaleValue and SaleCommission are treated as major currency units (e.g. pounds, not pence); the public documentation does not state the unit.';
const PULL_WINDOW_LIMITATION =
  'Transaction pulls are limited to one day per call; listTransactions chunks the requested window into 1-day slices and loops, so wide ranges make many sequential calls.';
const SVC_LIMITATION =
  'Dated WCF (.svc) endpoints: the publisher API is served from PublisherService.svc and the JSON variant is requested via the Accept header.';
const CLICKS_LIMITATION =
  'Click-level data is not exposed via the Affiliate Future publisher API; listClicks is unsupported.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.affiliatefuture.com',
  // Auth is by API key + password carried as query parameters — not a standard
  // bearer, basic, or OAuth2 scheme — so the model is `custom`.
  authModel: 'custom',
  docsUrl:
    'https://affiliatefuture.freshdesk.com/support/solutions/articles/79000032665-what-are-the-apis-for-publishers-',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    EXPERIMENTAL_LIMITATION,
    AMOUNT_UNIT_LIMITATION,
    PULL_WINDOW_LIMITATION,
    SVC_LIMITATION,
    CLICKS_LIMITATION,
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * `listTransactions` fans out into one call per day across the requested
 * window. Each individual call is small (a single day of data), so the default
 * 30s timeout is comfortable; the extra retry guards against a transient
 * gateway error on one of the many sequential calls failing the whole loop.
 */
const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Affiliate Future response shapes (deliberately minimal, defensively read)
// ---------------------------------------------------------------------------

interface AFMerchantRaw {
  merchantID?: number;
  MerchantID?: number;
  merchantName?: string;
  MerchantName?: string;
  programmeID?: number;
  ProgrammeID?: number;
  programmeName?: string;
  ProgrammeName?: string;
  // Affiliate Future flags whether the publisher has joined the programme.
  joined?: boolean;
  Joined?: boolean;
  isJoined?: boolean;
  category?: string;
  Category?: string;
  categoryName?: string;
  currency?: string;
  Currency?: string;
  commission?: string | number;
  Commission?: string | number;
  commissionDescription?: string;
  url?: string;
  Url?: string;
  merchantUrl?: string;
}

interface AFTransactionRaw {
  transactionID?: number | string;
  TransactionID?: number | string;
  transactionDate?: string;
  TransactionDate?: string;
  merchantID?: number;
  MerchantID?: number;
  merchantName?: string;
  MerchantName?: string;
  programmeID?: number;
  ProgrammeID?: number;
  programmeName?: string;
  ProgrammeName?: string;
  trackingReference?: string;
  TrackingReference?: string;
  saleValue?: number | string;
  SaleValue?: number | string;
  saleCommission?: number | string;
  SaleCommission?: number | string;
  leadCommission?: number | string;
  LeadCommission?: number | string;
  paidAmount?: number | string;
  PaidAmount?: number | string;
  // Affiliate Future exposes a textual status for each transaction
  // (e.g. Pending / Validated / Declined). Field name varies by serialisation.
  status?: string;
  Status?: string;
  transactionStatus?: string;
  receiptID?: number | string;
  ReceiptID?: number | string;
  currency?: string;
  Currency?: string;
}

// ---------------------------------------------------------------------------
// Field readers — tolerate the upstream's inconsistent casing
// ---------------------------------------------------------------------------

function num(...vals: Array<number | string | undefined>): number {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function str(...vals: Array<string | number | undefined>): string | undefined {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers — status normalisation, ageing, date formatting, chunking
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Affiliate Future → canonical TransactionStatus.
 *
 * Affiliate Future reports a free-text status per transaction. The documented
 * values are Pending (awaiting validation), Validated/Confirmed (approved),
 * Declined/Cancelled (reversed), and Paid (included in a payment). We map:
 *
 *   pending                          → 'pending'
 *   validated / confirmed / approved → 'approved'
 *   declined / cancelled / rejected  → 'reversed'
 *   paid                             → 'paid'
 *   anything else                    → 'other'
 *
 * Unknown values map to 'other' rather than a guess, keeping us honest. The
 * raw status is always preserved on `rawNetworkData`.
 */
function mapTransactionStatus(raw: AFTransactionRaw): TransactionStatus {
  const s = (str(raw.status, raw.Status, raw.transactionStatus) ?? '').toLowerCase();
  if (s === 'pending' || s === 'new' || s === 'awaiting') return 'pending';
  if (s === 'validated' || s === 'confirmed' || s === 'approved') return 'approved';
  if (s === 'declined' || s === 'cancelled' || s === 'canceled' || s === 'rejected') {
    return 'reversed';
  }
  if (s === 'paid') return 'paid';
  return 'other';
}

/**
 * Status normalisation: Affiliate Future merchant → canonical ProgrammeStatus.
 *
 * The Merchant List exposes a "joined" flag. We map joined → 'joined' and
 * not-joined → 'available'. Affiliate Future's public Merchant List does not
 * carry a per-merchant pending/declined application state for the publisher, so
 * those canonical states are not produced here.
 */
function mapProgrammeStatus(raw: AFMerchantRaw): ProgrammeStatus {
  const joined = raw.joined ?? raw.Joined ?? raw.isJoined;
  if (joined === true) return 'joined';
  if (joined === false) return 'available';
  return 'unknown';
}

/**
 * Compute the age (in days) of a transaction at the moment this adapter
 * responded, anchored on the transaction (conversion) date. Affiliate Future
 * does not expose a separate validation date on the transaction row, so the
 * transaction date is the only available anchor.
 */
function computeAgeDays(raw: AFTransactionRaw, now: Date = new Date()): number {
  const anchor = str(raw.transactionDate, raw.TransactionDate);
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

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/**
 * Format a Date for Affiliate Future's `startDate`/`endDate` query params.
 *
 * Affiliate Future expects `DD-MMM-YYYY` (e.g. `01-jan-2026`), not ISO-8601.
 * We build it from UTC components so the day boundary matches the slice the
 * caller asked for.
 */
function formatAFDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

interface DaySlice {
  /** Midnight UTC for this day. */
  day: Date;
}

/**
 * Split `[from, to]` into one slice per calendar day (UTC), inclusive of both
 * ends.
 *
 * Why one day per slice: Affiliate Future's transaction endpoint is limited to
 * a single day per call. Rather than pushing that cap onto callers, the adapter
 * loops day by day so a caller can request any window naturally. A 30-day
 * window therefore makes 30 sequential calls.
 *
 * Returns at least one slice; if `from > to` we still return a single slice for
 * the `from` day so the call shape stays predictable.
 */
function chunkDateRangeByDay(from: Date, to: Date): DaySlice[] {
  const startDay = startOfUtcDay(from);
  const endDay = startOfUtcDay(to);
  if (Number.isNaN(startDay.getTime()) || Number.isNaN(endDay.getTime())) {
    return [{ day: startDay }];
  }
  if (startDay > endDay) return [{ day: startDay }];

  const slices: DaySlice[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = startDay.getTime();
  const endMs = endDay.getTime();
  // Inclusive of the end day.
  while (cursor <= endMs) {
    slices.push({ day: new Date(cursor) });
    cursor += dayMs;
  }
  return slices;
}

function startOfUtcDay(d: Date): Date {
  if (Number.isNaN(d.getTime())) return d;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Transformers (Affiliate Future raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: AFMerchantRaw): Programme {
  // Affiliate Future identifies a programme by merchant ID; the programme ID is
  // a secondary identifier on the same row. We use the merchant ID as the
  // canonical programme id because the deep-link and transaction rows key on it.
  const id = str(raw.merchantID, raw.MerchantID, raw.programmeID, raw.ProgrammeID) ?? '';
  const name = str(raw.merchantName, raw.MerchantName, raw.programmeName, raw.ProgrammeName);
  const commission = str(
    raw.commissionDescription,
    typeof raw.commission === 'string' ? raw.commission : undefined,
    typeof raw.Commission === 'string' ? raw.Commission : undefined,
  );
  const category = str(raw.category, raw.Category, raw.categoryName);

  return {
    id,
    name: name ?? `Affiliate Future merchant ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: str(raw.currency, raw.Currency),
    commissionRate: commission ? { type: 'unknown', description: commission } : undefined,
    categories: category ? [category] : [],
    advertiserUrl: str(raw.url, raw.Url, raw.merchantUrl),
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AFTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = num(
    raw.saleCommission,
    raw.SaleCommission,
    raw.leadCommission,
    raw.LeadCommission,
  );
  const sale = num(raw.saleValue, raw.SaleValue);
  const currency = str(raw.currency, raw.Currency) ?? 'GBP';

  const transactionDate =
    nullableIso(str(raw.transactionDate, raw.TransactionDate)) ?? new Date(0).toISOString();

  return {
    id: str(raw.transactionID, raw.TransactionID, raw.receiptID, raw.ReceiptID) ?? '',
    network: SLUG,
    programmeId: str(raw.merchantID, raw.MerchantID) ?? '',
    programmeName: str(raw.merchantName, raw.MerchantName, raw.programmeName, raw.ProgrammeName) ?? '',
    status,
    amount: sale,
    currency,
    commission,
    // Affiliate Future does not expose click or validation dates on the
    // transaction row. Leave undefined rather than fabricating.
    dateClicked: undefined,
    dateConverted: transactionDate,
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // Affiliate Future does not return a reversal reason on the transaction
    // list endpoint (cancellations carry their own endpoint). Leave undefined.
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

/**
 * Normalise the merchant-list response into an array. Affiliate Future's JSON
 * variant may return a bare array or wrap the rows in an envelope; we accept
 * either and tolerate the common WCF `d` wrapper.
 */
function normaliseMerchantList(response: unknown): AFMerchantRaw[] {
  if (Array.isArray(response)) return response as AFMerchantRaw[];
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    const inner = obj['d'] ?? obj['Merchants'] ?? obj['merchants'] ?? obj['MerchantList'];
    if (Array.isArray(inner)) return inner as AFMerchantRaw[];
  }
  return [];
}

/**
 * Normalise the transaction-list response into an array, mirroring the merchant
 * list handling.
 */
function normaliseTransactionList(response: unknown): AFTransactionRaw[] {
  if (Array.isArray(response)) return response as AFTransactionRaw[];
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    const inner =
      obj['d'] ?? obj['Transactions'] ?? obj['transactions'] ?? obj['TransactionList'];
    if (Array.isArray(inner)) return inner as AFTransactionRaw[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class AffiliateFutureAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Affiliate Future programmes (merchants) the publisher has joined, or
   * could join.
   *
   * Affiliate Future's Merchant List endpoint takes `merchantsJoined=YES|NO|ALL`.
   * We default to `ALL` and apply the canonical `status` filter client-side so a
   * caller asking for `joined` or `available` gets the right subset without a
   * second round-trip. `search`, `categories`, and `limit` are also applied
   * client-side because the endpoint does not support them.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const { key, passcode } = requireCredentials('listProgrammes');

    const statusFilter = toStatusList(query?.status);

    const raw = await affiliateFutureRequest<unknown>({
      operation: 'listProgrammes',
      path: '/PublisherService.svc/GetAFMerchantList',
      key,
      passcode,
      query: { merchantsJoined: pickMerchantsJoined(statusFilter), newMerchants: 'NO' },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = normaliseMerchantList(raw).map(toProgramme);

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
   * Fetch a single programme by merchant ID.
   *
   * Affiliate Future has no single-merchant endpoint; the Merchant List is the
   * only source, so we fetch the list and pick the matching merchant ID
   * client-side. An unknown ID surfaces as a `network_api_error` envelope
   * rather than a fabricated stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Affiliate Future merchant IDs are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_affiliate_future_list_programmes) to find the correct id.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Affiliate Future merchant found with id "${programmeId}".`,
          hint: 'List programmes first to confirm the merchant id is correct and visible to your account.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions across a date window with optional status / age /
   * programme filters.
   *
   * Affiliate Future endpoint:
   *   GET /PublisherService.svc/GetTransactionListbyDate
   *     ?key= &passcode= &startDate=DD-MMM-YYYY &endDate=DD-MMM-YYYY
   *
   * IMPORTANT: a single call is limited to ONE day. We chunk the requested
   * window into 1-day slices (`chunkDateRangeByDay`) and loop, issuing one call
   * per day with `startDate === endDate`. A 30-day window therefore makes 30
   * sequential calls; the resilience layer applies per call.
   *
   * `query.minAgeDays` / `maxAgeDays` filter on the computed `ageDays`
   * (PRD §15.9) and are applied AFTER status filtering so a query like
   * `{ status: 'approved', minAgeDays: 180 }` is meaningful.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { key, passcode } = requireCredentials('listTransactions');

    // Default window: last 30 days. The endpoint needs concrete dates.
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // One slice per calendar day — the endpoint's hard one-day-per-call limit.
    const slices = chunkDateRangeByDay(from, to);

    const allRaw: AFTransactionRaw[] = [];
    for (const slice of slices) {
      const formatted = formatAFDate(slice.day);
      const chunk = await affiliateFutureRequest<unknown>({
        operation: 'listTransactions',
        path: '/PublisherService.svc/GetTransactionListbyDate',
        key,
        passcode,
        query: {
          // startDate and endDate are the same day: the endpoint pulls a single
          // day's transactions per call.
          startDate: formatted,
          endDate: formatted,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...normaliseTransactionList(chunk));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toTransactionStatusList(query?.status);
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
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (same rationale as Awin): a user can
   * recompute the summary from the transactions they can see, and there is no
   * second source of truth to drift. Affiliate Future does expose a payment
   * report endpoint, but its buckets differ from the per-transaction status, so
   * we do not blend it in here.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      // A limit on a summary would silently undercount (principle 4.1).
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

      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const programmeKey = t.programmeId || '__unknown';
      const existing = byProgrammeMap.get(programmeKey);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(programmeKey, {
          programmeId: programmeKey,
          programmeName: t.programmeName || `Affiliate Future merchant ${programmeKey}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

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
   * Affiliate Future does not expose click-level data via its publisher API.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "no clicks" and "no click API" matters
   * (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Affiliate Future does not expose click-level data via the publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct an Affiliate Future tracking / deep-link URL.
   *
   * Format (the documented AFClick redirector):
   *
   *   https://scripts.affiliatefuture.com/AFClick.asp
   *     ?affiliateID={affiliateId}
   *     &merchantID={merchantId}
   *     &programmeID={programmeId}
   *     &mediaID=0
   *     &tracking=
   *     &url={destinationUrl, URL-encoded}
   *
   * The `programmeId` input carries the Affiliate Future merchant ID (the id
   * this adapter assigns to a Programme). The affiliate ID comes from the
   * `AFFILIATE_FUTURE_AFFILIATE_ID` credential if configured; without it we
   * cannot construct the click URL and surface a config_error.
   *
   * Deterministic construction (no API call): the AFClick scheme is documented
   * and stable, so an API round-trip would add latency and a failure mode for
   * no benefit.
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
          message: 'Affiliate Future tracking links require the merchant (programme) ID.',
          hint: 'Pass `programmeId`. Use affiliate_affiliate_future_list_programmes to discover the merchant id.',
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

    // Ensure the credentials are configured so a half-configured environment
    // fails here rather than at first click. The affiliate ID is the
    // additional value the click URL needs.
    requireCredentials('generateTrackingLink');
    const affiliateId = getCredential('AFFILIATE_FUTURE_AFFILIATE_ID');
    if (!affiliateId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Affiliate Future tracking links require your affiliate ID.',
          hint: 'Set AFFILIATE_FUTURE_AFFILIATE_ID (your numeric publisher/affiliate ID, shown in the account dashboard).',
        }),
      );
    }

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://scripts.affiliatefuture.com/AFClick.asp` +
      `?affiliateID=${encodeURIComponent(affiliateId)}` +
      `&merchantID=${encodeURIComponent(input.programmeId)}` +
      `&programmeID=${encodeURIComponent(input.programmeId)}` +
      `&mediaID=0` +
      `&tracking=` +
      `&url=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'scripts.affiliatefuture.com/AFClick.asp deterministic construction',
        affiliateID: affiliateId,
        merchantID: input.programmeId,
        url: input.destinationUrl,
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth`, which makes a cheap Merchant List call and
   * returns the contract type.
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
    // A single-day window keeps the transactions probe to one call.
    const probeDay = new Date().toISOString();
    await probe('listTransactions', () =>
      this.listTransactions({ from: probeDay, to: probeDay, limit: 1 }),
    );
    await probe('getEarningsSummary', () =>
      this.getEarningsSummary({ from: probeDay, to: probeDay }),
    );
    await probe('verifyAuth', () => this.verifyAuth());

    operations['listClicks'] = {
      supported: false,
      note: CLICKS_LIMITATION,
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic AFClick URL construction; requires AFFILIATE_FUTURE_AFFILIATE_ID. Not probed.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Resolved from the Merchant List by id; not probed automatically.',
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
// Module-level registration (see Awin's adapter for the rationale).
// ---------------------------------------------------------------------------

export const affiliateFutureAdapter = new AffiliateFutureAdapter();
registerAdapter(affiliateFutureAdapter);

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
 * Map our canonical ProgrammeStatus to Affiliate Future's `merchantsJoined`
 * query param. We default to `ALL` (the broadest set) and filter client-side.
 */
function pickMerchantsJoined(statuses?: ProgrammeStatus[]): string {
  if (!statuses || statuses.length === 0) return 'ALL';
  if (statuses.includes('joined') && !statuses.includes('available')) return 'YES';
  if (statuses.includes('available') && !statuses.includes('joined')) return 'NO';
  return 'ALL';
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRangeByDay,
  formatAFDate,
  pickMerchantsJoined,
  normaliseMerchantList,
  normaliseTransactionList,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
