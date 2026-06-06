/**
 * ClickBank adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`.
 * Read that file and its header comments before modifying this one.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `Authorization: <DEVELOPER-KEY>:<CLERK-KEY>` (a
 *          colon-joined pair, NOT a Bearer token). See `auth.ts`.
 * Base:    https://api.clickbank.com/rest/1.3
 * Docs:    https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications
 *
 * --- Endpoint map -----------------------------------------------------------
 *
 *   GET  /quickstats/count
 *     → aggregate sale / refund / chargeback counters. Cheapest auth probe.
 *   GET  /orders2/list?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&role=AFFILIATE&type=SALE
 *     → per-order rows (one element per receipt). The workhorse for
 *       listTransactions. Paginated via a `Page` REQUEST header; ClickBank
 *       answers 206 while more pages remain.
 *   GET  /analytics/{role}/{dimension}  (role=affiliate)
 *     → aggregated statistics by dimension. Not used as the source of truth for
 *       transactions (no per-order ageing) — see getEarningsSummary.
 *
 * --- ClickBank is a single marketplace: how we model "programmes" -----------
 *
 * ClickBank is NOT a multi-network of separately-joined merchant programmes.
 * It is one marketplace: an affiliate promotes a vendor's products and is paid
 * a commission, with no per-merchant "join/pending/declined" lifecycle exposed
 * to the publisher API. There is therefore no endpoint that lists "programmes
 * the publisher has joined".
 *
 * To fit the cross-network `Programme` contract we SYNTHESISE programmes from
 * the affiliate's own order history: each distinct VENDOR seen in the orders
 * feed becomes one Programme (id = vendor nickname, status = 'joined' because
 * the affiliate has demonstrably promoted it). This is the honest, auditable
 * mapping — the user can reproduce the list by calling listTransactions. The
 * verbatim ClickBank order context is preserved on `rawNetworkData`. We do NOT
 * crawl the public marketplace catalogue: it is enormous, unrelated to the
 * publisher's actual activity, and would be a different (catalogue) product.
 *
 * getProgramme(vendor) returns the synthesised programme for one vendor by
 * filtering the same order history.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `clickbankRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to canonical set. Refunds and chargebacks map to
 *      'reversed'. Prefer 'other' over a wrong guess. Document the mapping.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations / assumptions ----------------------------------------
 *
 *   - Adapter built from public API documentation; not verified against a live
 *     account.
 *   - Amount unit assumption: ClickBank order amounts (`totalAccountAmount`)
 *     are treated as MAJOR currency units (whole dollars/pounds, not cents),
 *     matching ClickBank's documented decimal amounts. Verify against a live
 *     account before promoting to `production`.
 *   - "Programmes" are synthesised from the affiliate's own order history — see
 *     the modelling note above. ClickBank exposes no per-merchant join lifecycle
 *     to the publisher API.
 *   - Click-level data is not exposed via the publisher API; listClicks is
 *     unsupported.
 */

import { clickbankRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireKeys,
} from './auth.js';
import { setupSteps } from './setup.js';
import { getCredential, requireCredential } from '../../shared/config.js';
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionStatus,
  type TransactionQuery,
} from '../../shared/types.js';

const log = createLogger('clickbank.adapter');

const SLUG = 'clickbank';
const NAME = 'ClickBank';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.clickbank.com',
  // ClickBank uses a custom "DEV-KEY:CLERK-KEY" Authorization header rather
  // than a standard Bearer token.
  authModel: 'custom',
  docsUrl: 'https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live ClickBank account.',
    'Amount unit assumption: order amounts (totalAccountAmount) are treated as major currency units (whole dollars/pounds, not cents); verify against a live account before relying on the figures.',
    'ClickBank is a single marketplace with no per-merchant join lifecycle exposed to the publisher API; programmes are synthesised from the affiliate\'s own order history (one programme per promoted vendor).',
    'Click-level data is not exposed via the ClickBank publisher API; listClicks is unsupported.',
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
 * The orders feed (listTransactions / getEarningsSummary) can be slow when the
 * date window is wide and walks several pages. Give it a 60s timeout and 3
 * retries, matching the pattern Awin uses for its slow transactions endpoint.
 */
const ORDERS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: ORDERS_RESILIENCE,
  getEarningsSummary: ORDERS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// ClickBank raw response shapes (deliberately minimal — see Awin for rationale)
// ---------------------------------------------------------------------------

/**
 * One order row from GET /orders2/list. ClickBank wraps each receipt's data in
 * an `orderData` element; the list response is `{ orderData: [...] }` (or an
 * array directly on some serialisations). Field names confirmed against the
 * Orders2 service description and INS examples (2026-06-05):
 *   receipt, transactionType, transactionTime, totalAccountAmount, vendor,
 *   affiliate, role, currency, lineItems[].productTitle.
 */
interface ClickBankOrderRaw {
  receipt?: string;
  // transactionType: SALE | BILL | RFND | CGBK | FEE | TEST_SALE | TEST_BILL | ...
  transactionType?: string;
  // ISO-8601 datetime of the transaction.
  transactionTime?: string;
  // The amount credited to this account for the transaction. ClickBank reports
  // this as a decimal in major currency units.
  totalAccountAmount?: number;
  totalOrderAmount?: number;
  // Vendor nickname (the merchant). Affiliate nickname (the publisher).
  vendor?: string;
  affiliate?: string;
  role?: string; // AFFILIATE | VENDOR
  currency?: string; // ISO 4217, e.g. "USD"
  lineItems?: Array<{
    productTitle?: string;
    itemNo?: string;
    accountAmount?: number;
  }>;
}

/** Envelope from GET /orders2/list. */
interface ClickBankOrdersEnvelope {
  orderData?: ClickBankOrderRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: ClickBank transactionType → canonical TransactionStatus.
 *
 * ClickBank transaction types (Orders2 service description, 2026-06-05):
 *   SALE       → 'approved'  (a completed initial sale)
 *   BILL       → 'approved'  (a recurring rebill — a completed payment)
 *   RFND       → 'reversed'  (refund — the commission is clawed back)
 *   CGBK       → 'reversed'  (chargeback — the commission is clawed back)
 *   FEE        → 'other'     (a ClickBank fee line, not a sale)
 *   TEST_*     → 'other'     (sandbox/test transactions)
 *   anything else → 'other'
 *
 * Why SALE/BILL are 'approved' rather than 'paid': the order feed records the
 * transaction event, not the payout. ClickBank pays affiliates on a separate
 * schedule and does not expose a per-order paid flag here, so we map completed
 * transactions to 'approved' and never fabricate 'paid'. Refunds and
 * chargebacks both clawed-back the commission, so both normalise to 'reversed'
 * (the user-facing intent — the sale did not pay out), with the raw type kept
 * on rawNetworkData and surfaced as the reversal reason.
 */
function mapTransactionStatus(raw: ClickBankOrderRaw): TransactionStatus {
  const t = (raw.transactionType ?? '').toUpperCase();
  if (t === 'SALE' || t === 'BILL') return 'approved';
  if (t === 'RFND' || t === 'CGBK') return 'reversed';
  return 'other';
}

/**
 * Compute the age (in days) of a transaction at the moment the adapter
 * responded. ClickBank only exposes a single `transactionTime`, so we anchor on
 * it (there is no separate validation/approval date on an order row). PRD §15.9.
 */
function computeAgeDays(raw: ClickBankOrderRaw, now: Date = new Date()): number {
  const anchor = raw.transactionTime;
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

function productTitleOf(raw: ClickBankOrderRaw): string | undefined {
  const first = (raw.lineItems ?? []).find((li) => typeof li.productTitle === 'string');
  return first?.productTitle;
}

// ---------------------------------------------------------------------------
// Transformers (ClickBank raw → canonical domain types)
// ---------------------------------------------------------------------------

function toTransaction(raw: ClickBankOrderRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // Amount unit assumption: ClickBank reports decimal amounts in MAJOR currency
  // units (whole dollars/pounds). We pass them through unchanged. See
  // META.knownLimitations.
  const accountAmount = raw.totalAccountAmount ?? 0;
  const orderAmount = raw.totalOrderAmount ?? accountAmount;
  const currency = raw.currency ?? 'USD';

  // The affiliate's commission is the amount credited to this (affiliate)
  // account; the gross sale is the total order amount.
  const commission = accountAmount;
  const sale = orderAmount;

  const transactionTime = nullableIso(raw.transactionTime) ?? new Date(0).toISOString();

  const vendor = raw.vendor ?? '';
  const product = productTitleOf(raw);

  return {
    id: raw.receipt ?? '',
    network: SLUG,
    // We model one programme per vendor (see the modelling note in the file
    // header), so the vendor nickname is the programme id.
    programmeId: vendor,
    programmeName: product ? `${vendor} — ${product}` : vendor || 'ClickBank vendor',
    status,
    amount: sale,
    currency,
    commission,
    // ClickBank does not expose a click date on the order row.
    dateClicked: undefined,
    dateConverted: transactionTime,
    // No separate approval date; a completed SALE/BILL is the approval event.
    dateApproved: status === 'approved' ? transactionTime : undefined,
    // ClickBank pays on a separate schedule with no per-order paid flag here.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // For a reversal, the transaction type (RFND/CGBK) is the only reason
    // ClickBank gives at this level — surface it rather than inventing detail.
    reversalReason:
      status === 'reversed' ? `ClickBank ${raw.transactionType ?? 'reversal'}` : undefined,
    rawNetworkData: raw,
  };
}

/**
 * Synthesise a Programme from one vendor's slice of the affiliate's order
 * history. See the file header for why this mapping exists.
 *
 * `status` is always 'joined': the affiliate has demonstrably promoted the
 * vendor (there are orders attributed to them). ClickBank exposes no other
 * relationship state to the publisher API.
 */
function toProgramme(vendor: string, orders: ClickBankOrderRaw[]): Programme {
  const currency = orders.find((o) => o.currency)?.currency;
  const product = orders.map(productTitleOf).find((p): p is string => typeof p === 'string');
  return {
    id: vendor,
    name: product ? `${vendor} — ${product}` : vendor,
    slug: vendor,
    network: SLUG,
    status: 'joined',
    currency,
    // ClickBank's per-order feed does not carry the commission-rate schedule
    // (that lives on the public marketplace listing, not the publisher API).
    commissionRate: undefined,
    categories: [],
    rawNetworkData: { vendor, orderCount: orders.length, sampleOrder: orders[0] },
  };
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Date helpers for ClickBank's orders feed
// ---------------------------------------------------------------------------

/**
 * Format a Date for ClickBank's `startDate` / `endDate` query params.
 * ClickBank expects `YYYY-MM-DD` (date only) on the orders2 list endpoint.
 */
function formatClickBankDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks.
 *
 * ClickBank does not publish a hard per-call window cap on /orders2/list, but
 * very wide windows page slowly and risk timeouts. We chunk into ≤92-day
 * slices defensively so a "last 12 months" request resolves as a handful of
 * bounded calls rather than one open-ended one. Mirrors Awin's `chunkDateRange`.
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

/** Max days per orders2 list slice — see chunkDateRange. */
const ORDERS_MAX_WINDOW_DAYS = 92;

/** Hard cap on pages walked per slice, to bound a runaway pagination loop. */
const ORDERS_MAX_PAGES = 20;

function ordersOf(envelope: ClickBankOrdersEnvelope | ClickBankOrderRaw[] | undefined): ClickBankOrderRaw[] {
  if (!envelope) return [];
  if (Array.isArray(envelope)) return envelope;
  return Array.isArray(envelope.orderData) ? envelope.orderData : [];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ClickBankAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch the affiliate's orders across `[from, to]`, walking ClickBank's
   * `Page`-header pagination per slice. Centralised so listTransactions,
   * getEarningsSummary, and the synthesised programme ops share one fetch.
   */
  private async fetchOrders(operation: string, from: Date, to: Date): Promise<ClickBankOrderRaw[]> {
    const { developerKey, clerkKey } = requireKeys(operation);
    const slices = chunkDateRange(from, to, ORDERS_MAX_WINDOW_DAYS);

    const all: ClickBankOrderRaw[] = [];
    for (const slice of slices) {
      for (let page = 1; page <= ORDERS_MAX_PAGES; page += 1) {
        const envelope = await clickbankRequest<ClickBankOrdersEnvelope | ClickBankOrderRaw[]>({
          operation,
          path: '/orders2/list',
          developerKey,
          clerkKey,
          query: {
            startDate: formatClickBankDate(slice.start),
            endDate: formatClickBankDate(slice.end),
            // Restrict to the affiliate's own activity.
            role: 'AFFILIATE',
          },
          page,
          resilience: RESILIENCE[operation as keyof ResilienceConfigMap] ?? RESILIENCE.default,
        });
        const rows = ordersOf(envelope);
        all.push(...rows);
        // ClickBank pages are fixed-size; a short page means we have reached
        // the end of this slice. (The client cannot see the 206-vs-200 status
        // by design, so we stop on an empty/short page rather than on status.)
        if (rows.length === 0) break;
      }
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the programmes (promoted vendors) the affiliate has activity with.
   *
   * ClickBank exposes no "joined programmes" endpoint (see the file header).
   * We synthesise one Programme per distinct vendor seen in the affiliate's
   * order history over the default window (last 90 days). The user can
   * reproduce the list by calling listTransactions for the same window.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const now = new Date();
    // 90-day default window — enough to surface the vendors a publisher is
    // actively promoting without crawling the whole marketplace.
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const orders = await this.fetchOrders('listProgrammes', from, now);

    const byVendor = new Map<string, ClickBankOrderRaw[]>();
    for (const o of orders) {
      const vendor = o.vendor ?? '';
      if (!vendor) continue;
      const list = byVendor.get(vendor);
      if (list) list.push(o);
      else byVendor.set(vendor, [o]);
    }

    let programmes = [...byVendor.entries()].map(([vendor, list]) => toProgramme(vendor, list));

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
   * Fetch a single synthesised programme by vendor nickname.
   *
   * Validates the id format (a ClickBank vendor nickname is a short
   * lowercase-alphanumeric handle) and filters the same order history to that
   * vendor. Returns a programme with no orders (orderCount 0) when the vendor
   * is well-formed but absent from the window — we do NOT fabricate a status
   * other than 'joined', and the empty rawNetworkData makes the absence visible.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^[a-z0-9]{2,40}$/i.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `ClickBank programme IDs are vendor nicknames (alphanumeric); received "${programmeId}".`,
          hint: 'Use affiliate_clickbank_list_programmes to discover the vendor nicknames you promote.',
        }),
      );
    }

    const now = new Date();
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const orders = await this.fetchOrders('getProgramme', from, now);

    const wanted = programmeId.toLowerCase();
    const mine = orders.filter((o) => (o.vendor ?? '').toLowerCase() === wanted);
    return toProgramme(programmeId, mine);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List the affiliate's transactions across a date window.
   *
   * ClickBank endpoint: GET /orders2/list (role=AFFILIATE), paginated via the
   * `Page` request header. Default window: last 30 days. Wide windows are
   * chunked into ≤92-day slices (see chunkDateRange) so a long range resolves
   * as bounded calls.
   *
   * Status normalisation: SALE/BILL → approved, RFND/CGBK → reversed (PRD §15.10
   * reversed visibility — the reversal reason carries the raw type). Age filters
   * (PRD §15.9) are applied after status filtering so `{ status: 'approved',
   * minAgeDays: 180 }` is meaningful.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const orders = await this.fetchOrders('listTransactions', from, to);
    let transactions = orders.map((r) => toTransaction(r, now));

    // programmeId (vendor) filter — client-side; the orders feed returns all
    // vendors for the affiliate in one window.
    if (query?.programmeId) {
      const wanted = query.programmeId.toLowerCase();
      transactions = transactions.filter((t) => t.programmeId.toLowerCase() === wanted);
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
   * Aggregate the orders feed into an earnings summary.
   *
   * We derive from listTransactions rather than the /analytics endpoint for the
   * same reason as Awin: the per-transaction `ageDays` is needed for the
   * `oldestUnpaidAgeDays` affordance and analytics summaries do not carry it.
   * Deriving from transactions keeps the summary auditable — the user can
   * recompute it from the rows they see.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // never apply a limit inside a summary — it would undercount.
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

      // Count commission (the affiliate's earnings), not the gross sale.
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
          programmeName: t.programmeName || `ClickBank vendor ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid. ClickBank does not expose a per-order paid
      // flag, so "unpaid" here means an approved transaction that has not yet
      // been reversed (refunded/charged back). Pending never occurs on the
      // ClickBank order feed but is included for contract parity.
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
   * ClickBank does not expose click-level (HopLink hit) data via its publisher
   * API. We throw NotImplementedError rather than returning an empty array —
   * the difference between "no clicks" and "no API" is PRD principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'ClickBank does not expose click-level data via the publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a ClickBank HopLink deterministically.
   *
   * ClickBank's canonical affiliate link is the HopLink, whose stable form is:
   *
   *   https://<AFFILIATE>.<VENDOR>.hop.clickbank.net
   *
   * with an optional tracking id (`?tid=`) and an optional destination override.
   * We build the documented host-based form; we do NOT call the API (the URL is
   * fully known from the affiliate nickname + vendor, so an API round-trip would
   * add latency and a failure mode for no benefit — the same rationale as Awin).
   *
   * `programmeId` is the VENDOR nickname; the AFFILIATE nickname comes from
   * CLICKBANK_NICKNAME. Both are required: without the affiliate nickname the
   * link cannot attribute the sale, so we surface a config_error rather than
   * building an unattributed link.
   *
   * The optional `destinationUrl` is carried through as the `&url=` parameter so
   * a deep link to a specific vendor page is preserved. ClickBank's documented
   * HopLink redirect (the host form above) handles the vendor's own landing
   * page when no destination is supplied.
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
          message: 'ClickBank HopLinks require the vendor nickname as the programme ID.',
          hint:
            'Pass `programmeId` (the vendor nickname). Use affiliate_clickbank_list_programmes ' +
            'to discover the vendors you promote.',
        }),
      );
    }
    if (!/^[a-z0-9]{2,40}$/i.test(input.programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `ClickBank vendor nicknames are alphanumeric; received "${input.programmeId}".`,
          hint: 'Use affiliate_clickbank_list_programmes to discover valid vendor nicknames.',
        }),
      );
    }

    // The affiliate nickname is mandatory for attribution. Surface a clear
    // config error if it is not configured, rather than building a broken link.
    const affiliate = requireCredential('CLICKBANK_NICKNAME', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint:
        'Set CLICKBANK_NICKNAME (your ClickBank account login handle) so HopLinks attribute ' +
        'sales to you. Run `affiliate-networks-mcp setup` to provide it.',
    });

    const vendor = input.programmeId.toLowerCase();
    let trackingUrl = `https://${encodeURIComponent(affiliate)}.${encodeURIComponent(vendor)}.hop.clickbank.net`;
    if (input.destinationUrl) {
      trackingUrl += `?url=${encodeURIComponent(input.destinationUrl)}`;
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      // No upstream API call — record the construction context so the user can
      // see exactly how the HopLink was assembled.
      rawNetworkData: {
        format: 'hop.clickbank.net deterministic construction',
        affiliate,
        vendor,
        url: input.destinationUrl || undefined,
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
      note: 'ClickBank does not expose click-level data via the publisher API',
    };

    // generateTrackingLink + getProgramme need known inputs; record as
    // supported-without-probe to keep the diagnostic fast.
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: getCredential('CLICKBANK_NICKNAME')
        ? 'Deterministic HopLink construction; no live probe.'
        : 'Deterministic HopLink construction; requires CLICKBANK_NICKNAME to be set.',
    };
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Synthesised from order history for a known vendor nickname; not probed automatically.',
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
//
// Registers at module load via a side effect. The aggregator
// (`src/networks/index.ts`) is the single place that imports adapter modules;
// adding ClickBank to the server means adding one import line there.
// ---------------------------------------------------------------------------

export const clickbankAdapter = new ClickBankAdapter();
registerAdapter(clickbankAdapter);

// Internal test helpers — exported under `_internals` so they don't appear on
// the public adapter surface.
export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatClickBankDate,
  ordersOf,
  productTitleOf,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
