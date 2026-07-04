/**
 * Rakuten Advertising adapter — partial implementation.
 *
 * IMPORTANT FOR FUTURE CONTRIBUTORS:
 *
 * Per AGENTS.md, this adapter is **not a pattern source** for new networks.
 * The Awin adapter (`src/networks/awin/adapter.ts`) is the canonical reference.
 * Rakuten's API access is gated behind a 3–7 day approval flow, parts of its
 * surface are paid-tier-only, and several endpoints return XML by default —
 * those quirks make some choices here Rakuten-specific. Read Awin first.
 *
 * --- What is implemented vs. stubbed ----------------------------------------
 *
 * Implemented against the documented public endpoints:
 *   - listProgrammes      → GET /v1/programs/ (paged to completion; see below)
 *   - getProgramme        → GET /v1/programs/?mid=<id> (filtered, single result)
 *   - listTransactions    → GET /v1/reports/transaction_reports
 *   - getEarningsSummary  → derived from listTransactions (auditable)
 *   - generateTrackingLink→ deterministic deeplink construction
 *   - verifyAuth          → token exchange round-trip
 *
 * Stubbed (throws `NotImplementedError`) because the relevant endpoint
 * requires a paid Rakuten tier or scope not available to an unapproved
 * test account at commit time:
 *   - listClicks          → /v1/reports/clicks_reports is paid-tier-gated.
 *
 * Admin scaffolds:
 *   - listPublishers, listPublisherSectors → v0.2 (NotImplementedError).
 *
 * Pagination: `/v1/programs/` takes 1-based `page` + `page_size` parameters.
 * When the caller passes no `limit`, `listProgrammes` pages to completion,
 * stepping `page` until an empty or short page, capped at MAX_PAGES with a
 * stderr warning so a truncated pull is never silent. A present `limit` stops
 * the loop as soon as enough raw rows are fetched (the single request the
 * pre-pagination adapter sent, for limits within one page).
 *
 * --- Cardinal rules (same as every adapter) ---------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `rakutenRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope` with network,
 *      operation, httpStatus, and verbatim networkErrorBody (PRD §15.4).
 *   3. PRESERVE the raw response on every domain object via `rawNetworkData`.
 *   4. NORMALISE Rakuten's `pending|locked|paid|reversed` status set into our
 *      canonical `pending|approved|reversed|paid|other` (see `mapTransactionStatus`).
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *
 * --- Rakuten status mapping ---------------------------------------------------
 *
 * Rakuten's transaction reports use these status values broadly:
 *
 *   "pending"   — sale recorded, awaiting validation         → 'pending'
 *   "locked"    — validated, in the payment-lock window      → 'approved'
 *   "paid"      — payment issued to the publisher            → 'paid'
 *   "reversed"  — sale cancelled / customer return           → 'reversed'
 *
 * The interesting choice is "locked" → "approved". Rakuten "locks" a sale
 * after the advertiser approves it but before it leaves the payment-hold
 * window (typically 60 days). That's semantically the same as Awin's
 * "approved-but-not-yet-paid". Mapping to 'approved' lets the unpaid-age
 * affordance (§15.9) work the same way across networks: a query for
 * "approved transactions older than 90 days" returns the locked sales that
 * are overdue. See docs/findings/rakuten.md for the full rationale.
 */

import { rakutenRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
} from './auth.js';
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

const log = createLogger('rakuten.adapter');

const SLUG = 'rakuten';
const NAME = 'Rakuten Advertising';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.linksynergy.com',
  authModel: 'oauth2',
  docsUrl: 'https://developers.rakutenadvertising.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-21',
  // `partial`: most ops implemented against the public docs, but listClicks
  // is paid-tier-gated (NotImplementedError) and the adapter has not been
  // run against a live publisher account. If listClicks turns out to also
  // be inaccessible AND another op fails at first contact, this should be
  // downgraded to `experimental`.
  claimStatus: 'partial',
  knownLimitations: [
    'Click-level data (listClicks) requires a paid Rakuten tier; the adapter throws NotImplementedError until that access is granted.',
    'Brand-side operations (listPublishers, listPublisherSectors) are scaffolded for v0.2 and throw NotImplementedError.',
    'API access requires Publisher Solutions approval; the adapter cannot be exercised end-to-end without that approval.',
    'Token endpoint URL varies across tenants; the adapter defaults to api.linksynergy.com/token and accepts a RAKUTEN_TOKEN_URL override.',
    'listProgrammes pagination is 1-based via page + page_size; when no limit is passed it pages to completion (stopping on an empty or short page), capped at MAX_PAGES with a warning rather than a silent truncation.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 12,
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 5,
  side: 'publisher',
  credentialScope: 'single-brand',
};

/**
 * Backstop for the pagination loop in `listProgrammes`. 50 pages at the
 * default `page_size` of 100 is far beyond any realistic publisher's approved
 * programme list; hitting it logs a warning (stderr) so a truncated pull is
 * never silent (principle 4.1). Same pattern as the Tolt and Tapfiliate
 * adapters.
 */
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * `listTransactions` against Rakuten's report endpoints is the slowest call
 * in the surface (report engine warm-load on first call of a session). Bump
 * timeout + retries here for the same reason Awin does.
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
// Rakuten raw response shapes (deliberately minimal — same rationale as Awin)
// ---------------------------------------------------------------------------

interface RakutenProgrammeRaw {
  mid?: number | string;
  advertiser_name?: string;
  network_name?: string;
  status?: string;
  application_status?: string;
  currency?: string;
  primary_category?: { name?: string; parent?: string };
  categories?: Array<{ name?: string }>;
  description?: string;
  merchant_url?: string;
  commission?: {
    type?: string;
    rate?: number;
    description?: string;
    currency?: string;
  };
}

interface RakutenTransactionRaw {
  // Field naming on Rakuten's reports drifts between snake_case (newer) and
  // camelCase (older). We accept both.
  transaction_id?: string | number;
  transactionId?: string | number;
  mid?: number | string;
  advertiser_name?: string;
  advertiserName?: string;
  sid?: number | string;
  status?: string; // pending | locked | paid | reversed
  sale_amount?: number | string;
  saleAmount?: number | string;
  commission_amount?: number | string;
  commissionAmount?: number | string;
  currency?: string;
  click_date?: string;
  clickDate?: string;
  transaction_date?: string;
  transactionDate?: string;
  process_date?: string;
  processDate?: string;
  payment_date?: string;
  paymentDate?: string;
  reversal_reason?: string;
  reversalReason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSid(operation: string): string {
  return requireCredential('RAKUTEN_SID', {
    network: SLUG,
    operation,
    hint: 'Set RAKUTEN_SID (publisher Site ID) — run `affiliate-networks-mcp setup rakuten`.',
  });
}

/**
 * Map Rakuten's status vocabulary to our canonical TransactionStatus.
 *
 * See file-level comment for the rationale of "locked" → "approved".
 * Anything we don't recognise maps to 'other' — we never invent a status.
 */
function mapTransactionStatus(raw: RakutenTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toString().toLowerCase().trim();
  switch (s) {
    case 'pending':
      return 'pending';
    case 'locked':
    case 'approved':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'reversed':
    case 'declined':
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Map Rakuten programme/application status to canonical ProgrammeStatus.
 *
 * Rakuten uses `application_status` ("approved" / "pending" / "rejected") for
 * the publisher's relationship with the merchant, and `status` for the
 * merchant's own operational state ("active" / "inactive"). We prefer the
 * relationship-side status because that's what callers actually want.
 */
function mapProgrammeStatus(raw: RakutenProgrammeRaw): ProgrammeStatus {
  const rel = (raw.application_status ?? '').toString().toLowerCase();
  if (rel === 'approved' || rel === 'joined' || rel === 'active') return 'joined';
  if (rel === 'pending') return 'pending';
  if (rel === 'rejected' || rel === 'declined') return 'declined';
  if (rel === 'available' || rel === 'notjoined' || rel === '') {
    // No relationship recorded — could be either "available to apply" or
    // "merchant is inactive". Read the merchant status for a hint.
    const m = (raw.status ?? '').toString().toLowerCase();
    if (m === 'inactive' || m === 'suspended' || m === 'paused') return 'suspended';
    if (m === 'active' || m === '') return 'available';
  }
  return 'unknown';
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute `ageDays` for a Rakuten transaction. Prefer process_date (Rakuten's
 * equivalent of Awin's validationDate — the moment the sale leaves "pending"
 * state) and fall back to transaction_date for sales still pending.
 */
function computeAgeDays(raw: RakutenTransactionRaw, now: Date = new Date()): number {
  const anchor =
    raw.process_date ??
    raw.processDate ??
    raw.transaction_date ??
    raw.transactionDate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toNumber(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Unwrap Rakuten's programme list envelope. Newer tenants return
 * `{ programs: [...] }`; older ones have been observed returning a bare array.
 */
function extractProgrammeList(
  raw: { programs?: RakutenProgrammeRaw[] } | RakutenProgrammeRaw[],
): RakutenProgrammeRaw[] {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.programs) ? raw.programs : [];
}

/**
 * Fetch pages of `/v1/programs/` until the pull is complete.
 *
 * Rakuten's programs endpoint takes 1-based `page` + `page_size` parameters.
 * The response body carries no record counter we can rely on across tenants,
 * so completion is detected from page shape alone. The loop stops when:
 *   - the endpoint returns an empty page (nothing more upstream);
 *   - the caller's `limit` is satisfied by the raw rows fetched so far (the
 *     backward-compatible short-circuit — a present limit never fetches more
 *     pages than it needs);
 *   - the page comes back short (fewer rows than `page_size`);
 *   - the MAX_PAGES backstop trips — logged so truncation is never silent.
 */
async function fetchAllProgrammePages(input: {
  pageSize: number;
  limit?: number;
  status?: string;
}): Promise<RakutenProgrammeRaw[]> {
  const out: RakutenProgrammeRaw[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await rakutenRequest<{ programs?: RakutenProgrammeRaw[] } | RakutenProgrammeRaw[]>({
      operation: 'listProgrammes',
      path: '/v1/programs/',
      query: {
        page,
        page_size: input.pageSize,
        ...(input.status ? { status: input.status } : {}),
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = extractProgrammeList(raw);
    out.push(...rows);

    if (rows.length === 0) return out;
    if (typeof input.limit === 'number' && out.length >= input.limit) return out;
    if (rows.length < input.pageSize) return out;
  }
  log.warn(
    { operation: 'listProgrammes', cap: MAX_PAGES, fetched: out.length },
    'rakuten pagination hit MAX_PAGES cap; result may be truncated',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: RakutenProgrammeRaw): Programme {
  const id = String(raw.mid ?? '');
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => c.name).filter((n): n is string => typeof n === 'string')
    : raw.primary_category?.name
      ? [raw.primary_category.name]
      : [];

  const programme: Programme = {
    id,
    name: raw.advertiser_name ?? `Rakuten merchant ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (raw.currency ?? raw.commission?.currency) {
    programme.currency = raw.currency ?? raw.commission?.currency;
  }
  if (raw.commission) {
    programme.commissionRate = {
      type:
        raw.commission.type === 'percent' ||
        raw.commission.type === 'flat' ||
        raw.commission.type === 'tiered'
          ? raw.commission.type
          : 'unknown',
      value: raw.commission.rate,
      currency: raw.commission.currency,
      description: raw.commission.description,
    };
  }
  if (categories.length > 0) programme.categories = categories;
  if (raw.merchant_url) programme.advertiserUrl = raw.merchant_url;
  return programme;
}

function toTransaction(raw: RakutenTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const amount = toNumber(raw.sale_amount ?? raw.saleAmount);
  const commission = toNumber(raw.commission_amount ?? raw.commissionAmount);
  const currency = raw.currency ?? 'USD'; // Rakuten's default reporting currency; per-row when available

  const transactionDate =
    nullableIso(raw.transaction_date ?? raw.transactionDate) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date ?? raw.clickDate);
  const processDate = nullableIso(raw.process_date ?? raw.processDate);
  const paymentDate = nullableIso(raw.payment_date ?? raw.paymentDate);

  const txn: Transaction = {
    id: String(raw.transaction_id ?? raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.mid ?? ''),
    programmeName: raw.advertiser_name ?? raw.advertiserName ?? '',
    status,
    amount,
    currency,
    commission,
    dateConverted: transactionDate,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
  if (clickDate) txn.dateClicked = clickDate;
  if (processDate) txn.dateApproved = processDate;
  if (paymentDate) txn.datePaid = paymentDate;
  if (status === 'reversed') {
    const reason = raw.reversal_reason ?? raw.reversalReason;
    if (reason) txn.reversalReason = reason;
  }
  return txn;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class RakutenAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Rakuten programmes the publisher has access to.
   *
   * Endpoint: `GET /v1/programs/?page=...&page_size=...`. With no
   * `query.limit` we page to completion (see `fetchAllProgrammePages`); with a
   * limit we stop as soon as enough raw rows are fetched. We filter by
   * application status server-side via `status=approved|pending|rejected`
   * where Rakuten supports it; otherwise we filter client-side after the
   * fetch.
   *
   * Why client-side filtering for `search` and `categories`: Rakuten's
   * /programs endpoint doesn't accept a free-text search parameter; category
   * filtering is by ID rather than name, and resolving names→IDs would mean a
   * second round-trip per call. Same pattern as the Awin adapter.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const statusFilter = toStatusList(query?.status);
    const rakutenStatus = pickRakutenApplicationStatus(statusFilter);

    const pageSize = Math.min(query?.limit ?? 100, 200);

    const list = await fetchAllProgrammePages({
      pageSize,
      ...(typeof query?.limit === 'number' ? { limit: query.limit } : {}),
      ...(rakutenStatus ? { status: rakutenStatus } : {}),
    });

    let programmes = list.map(toProgramme);

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
   * Fetch a single programme by Rakuten MID (merchant ID).
   *
   * Rakuten exposes the legacy `/linklocator/getMerchByID/{mid}` endpoint and
   * the newer `/v1/programs/?mid=` filter. The legacy endpoint returns XML by
   * default even with the JSON Accept header — we use the v1 filter so the
   * client's JSON-parse path applies uniformly.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Rakuten merchant IDs (MIDs) are numeric; received "${programmeId}".`,
          hint: 'List programmes first to find the correct MID.',
        }),
      );
    }

    const raw = await rakutenRequest<
      { programs?: RakutenProgrammeRaw[] } | RakutenProgrammeRaw[]
    >({
      operation: 'getProgramme',
      path: '/v1/programs/',
      query: { mid: programmeId, page_size: 1 },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { programs?: RakutenProgrammeRaw[] }).programs)
        ? (raw as { programs: RakutenProgrammeRaw[] }).programs
        : [];
    const match = list[0];
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Rakuten programme found for MID "${programmeId}".`,
          hint: 'Confirm the MID via listProgrammes; the publisher may not have access to that merchant.',
        }),
      );
    }
    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions across a date window with optional status / age /
   * programme filters.
   *
   * Endpoint: `GET /v1/reports/transaction_reports`.
   *
   * Rakuten's `transaction_reports` accepts:
   *   - process_date_start / process_date_end (YYYY-MM-DD)
   *   - status (pending|locked|paid|reversed) — applied server-side
   *   - mid (server-side filter by merchant)
   *
   * We pass through `programmeId` as `mid` (server-side), and `status` is
   * filtered client-side because the canonical→Rakuten status set is not
   * one-to-one ("approved" maps to "locked"). Doing it client-side means
   * mixed-status queries work the way callers expect.
   *
   * --- §15.9 unpaid-age filter ------------------------------------------------
   *
   * `minAgeDays`/`maxAgeDays` are applied AFTER the fetch (same pattern as
   * Awin). `ageDays` anchors on `process_date ?? transaction_date`.
   *
   * --- §15.10 reversed-sale visibility ----------------------------------------
   *
   * Reversed sales are returned unless the caller filters them out. The
   * transformer populates `reversalReason` from Rakuten's `reversal_reason`
   * field where present. Rakuten's reversal reasons are typically free-text
   * strings ("customer return", "fraud", "duplicate"); we surface them
   * verbatim.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const sid = requireSid('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const rakutenQuery: Record<string, string | number | undefined> = {
      sid,
      process_date_start: formatRakutenDate(from),
      process_date_end: formatRakutenDate(to),
    };
    if (query?.programmeId) rakutenQuery['mid'] = query.programmeId;

    const raw = await rakutenRequest<
      { transactions?: RakutenTransactionRaw[] } | RakutenTransactionRaw[]
    >({
      operation: 'listTransactions',
      path: '/v1/reports/transaction_reports',
      query: rakutenQuery,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { transactions?: RakutenTransactionRaw[] }).transactions)
        ? (raw as { transactions: RakutenTransactionRaw[] }).transactions
        : [];

    let transactions = list.map((r) => toTransaction(r, now));

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
   * Same rationale as Awin: derive from `listTransactions` so the user can
   * recompute totals from the per-record output. Rakuten exposes a separate
   * `/v1/reports/summary_report` endpoint, but its status buckets don't align
   * cleanly with our canonical enum, so we'd have to re-bucket anyway.
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
          programmeName: t.programmeName || `Rakuten merchant ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // §15.9 — oldest unpaid age. Includes pending + approved (locked).
      if (t.status === 'pending' || t.status === 'approved') {
        if (oldestUnpaidAgeDays === undefined || t.ageDays > oldestUnpaidAgeDays) {
          oldestUnpaidAgeDays = t.ageDays;
        }
      }
    }

    if (firstCurrency) byStatus.currency = firstCurrency;

    const summary: EarningsSummary = {
      network: SLUG,
      totalEarnings,
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      periodFrom: from,
      periodTo: to,
    };
    if (oldestUnpaidAgeDays !== undefined) summary.oldestUnpaidAgeDays = oldestUnpaidAgeDays;
    return summary;
  }

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /**
   * Rakuten exposes click-level data via `GET /v1/reports/clicks_reports`, but
   * the endpoint is paid-tier-gated. An unapproved or basic-tier publisher
   * gets a 403 with no usable body.
   *
   * We throw `NotImplementedError` with a specific human-readable reason
   * rather than letting the call fail at runtime with a confusing 403. If the
   * test account is later upgraded, swap this for the real implementation;
   * the response shape is the same as `transaction_reports`.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Rakuten clicks_reports endpoint requires a paid Rakuten tier; not available on the test account at adapter commit time. Contact Rakuten Publisher Solutions to enable click-level reporting.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Rakuten deep-link.
   *
   * Format (canonical Rakuten Linkshare tracking URL):
   *
   *   https://click.linksynergy.com/deeplink
   *     ?id=<RAKUTEN_SID>    (publisher Site ID — the "id" param IS the SID)
   *     &mid=<merchant MID>
   *     &u=<URL-encoded destination>
   *
   * Why deterministic construction rather than calling `/linklocator/getTextLinks`:
   *   - The `getTextLinks` endpoint returns pre-canned text-link HTML, not a
   *     deeplink to an arbitrary destination URL. For the principle 4.1 use
   *     case ("link me to *this specific* product page"), the deeplink format
   *     above is what callers actually want.
   *   - The deeplink format is documented in the Rakuten Publisher Linking
   *     Guide and has been stable for years. Every property is known to us
   *     at the moment of the call — an API round-trip adds latency and a
   *     failure mode for no benefit.
   *   - This matches the Awin adapter's deterministic-construction pattern,
   *     which we're explicitly mirroring to keep behaviour consistent across
   *     networks where the format permits.
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
          message: 'Rakuten tracking links require the merchant (programme) ID (MID).',
          hint: 'Pass `programmeId`. Use listProgrammes to find the MID for the merchant you want to link to.',
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

    const sid = requireSid('generateTrackingLink');

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://click.linksynergy.com/deeplink` +
      `?id=${encodeURIComponent(sid)}` +
      `&mid=${encodeURIComponent(input.programmeId)}` +
      `&u=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'click.linksynergy.com/deeplink deterministic construction',
        id: sid,
        mid: input.programmeId,
        u: input.destinationUrl,
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
  // Admin scaffolds
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  // -------------------------------------------------------------------------
  // validateCredential / setupSteps / derivedValues
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  /**
   * No values are derivable from the auth round-trip — the SID must be
   * user-supplied. Return an empty list (rather than skipping the optional
   * method) so the wizard sees a deterministic, empty derived-values set
   * instead of an undefined that might be misread as "not yet implemented".
   */
  async derivedValues(): Promise<import('../../shared/types.js').DerivedValueResult[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // capabilitiesCheck
  // -------------------------------------------------------------------------

  /**
   * Probe each op with a minimal call. listClicks is recorded as
   * `supported: false` without probing (NotImplementedError). For ops that
   * require credentials we still attempt the probe so a misconfigured
   * environment surfaces as the explicit failure rather than a silent skip.
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
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['listClicks'] = {
      supported: false,
      note: 'Rakuten clicks_reports endpoint is paid-tier-gated; throws NotImplementedError until publisher upgrades.',
    };

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction; no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known merchant MID; not probed automatically.',
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
 * Map canonical ProgrammeStatus[] to Rakuten's `status` query param.
 *
 * Rakuten's /programs endpoint accepts `approved|pending|rejected` (when it
 * accepts a filter at all — some tenants ignore it). We only set the query
 * param when the caller asked for a single, server-translatable status; if
 * the request mixes statuses we fetch everything and filter client-side.
 */
function pickRakutenApplicationStatus(statuses?: ProgrammeStatus[]): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  const s = statuses[0];
  if (s === 'joined') return 'approved';
  if (s === 'pending') return 'pending';
  if (s === 'declined') return 'rejected';
  return undefined;
}

/**
 * Rakuten's `process_date_start` / `process_date_end` accept YYYY-MM-DD.
 * They reject ISO-8601 with a time component on at least some tenants.
 */
function formatRakutenDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Module-level registration
// ---------------------------------------------------------------------------

export const rakutenAdapter = new RakutenAdapter();
registerAdapter(rakutenAdapter);

// Internal helpers for tests.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  formatRakutenDate,
  pickRakutenApplicationStatus,
  log,
  MAX_PAGES,
};
