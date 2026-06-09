/**
 * LinkConnector adapter (publisher side).
 *
 * Built on the Awin reference pattern (`src/networks/awin/adapter.ts`); read
 * that file's header for the full reasoning behind the seven-operation shape,
 * the status-normalisation discipline, and the `rawNetworkData` rule.
 *
 * --- LinkConnector API map --------------------------------------------------
 *
 * Auth + dispatch: a single endpoint `https://www.linkconnector.com/api/` that
 * dispatches on a `Function` query parameter. The API key is the `Key`
 * parameter; `Format=JSON` forces JSON output (default is CSV/XML). See
 * `client.ts`. Docs: https://www.linkconnector.com/help_api.htm
 *
 *   Function=getFeedPromotion
 *     → merchant promotions feed. Carries merchant name, promo description,
 *       coupon code, and the affiliate tracking URL. Used by listProgrammes /
 *       getProgramme (it is the closest thing the publisher API exposes to a
 *       per-merchant catalogue with tracking links).
 *   Function=getReportTransaction
 *     → current status of all commissionable events credited to the account.
 *       Carries commission, sale amount, transaction status, invalidation
 *       reason, original date, and funded date. The workhorse for
 *       listTransactions + getEarningsSummary.
 *   Function=getReportTransactionDelta
 *     → changes to transactions, one row per update with a delta date. Not used
 *       at v0.1 (the full report is the canonical record); documented here so a
 *       future contributor knows where incremental sync lives.
 *
 * --- Field-name caution -----------------------------------------------------
 *
 * LinkConnector's per-function help pages are not crawlable, so the exact JSON
 * key casing is not publicly confirmed. Every transformer therefore reads a
 * small set of candidate key names defensively and preserves the verbatim row
 * on `rawNetworkData`. When LinkConnector returns a shape we do not recognise,
 * the user sees the raw payload rather than a fabricated value (principle 4.1).
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * LinkConnector is a US network; amounts are assumed to be in major currency
 * units (US dollars), not minor units (cents). This is recorded in
 * `META.knownLimitations` and `network.json` as an explicit assumption to be
 * confirmed against a live account.
 */

import { linkconnectorRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiKey } from './auth.js';
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

const log = createLogger('linkconnector.adapter');

const SLUG = 'linkconnector';
const NAME = 'LinkConnector';

/**
 * Default reporting currency. LinkConnector is a US network and the per-row
 * currency is not reliably present on the transaction surface; we assume USD.
 * Verbatim rows on `rawNetworkData` let the user confirm.
 */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://www.linkconnector.com',
  // Custom: API key passed via the `Key` POST/query parameter, not a Bearer
  // header. See client.ts.
  authModel: 'custom',
  docsUrl: 'https://www.linkconnector.com/help_api.htm',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: the adapter has not been validated against a live
  // LinkConnector account, and the JSON field-name casing is inferred from the
  // public (non-crawlable) docs rather than confirmed.
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: not yet validated against a live LinkConnector account; JSON field names are inferred from the public documentation and read defensively.',
    'Amounts are assumed to be in major currency units (US dollars); LinkConnector is a US network. The unit has not been confirmed against a live account.',
    'Click-level data is not exposed via the public LinkConnector publisher API; listClicks is unsupported.',
    'Tracking links are issued by LinkConnector per merchant (via the promotions feed), not constructed deterministically from a destination URL; generateTrackingLink is unsupported.',
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
//
// Why listTransactions gets a longer timeout: LinkConnector's report engine
// can be slow for wide windows. Mirrors the Awin rationale.

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
// LinkConnector response shapes (deliberately minimal + defensive)
// ---------------------------------------------------------------------------
//
// We do NOT model these with strict schemas. LinkConnector's documented JSON
// key casing is not crawlable, so transformers read several candidate names
// and treat every field as possibly absent. The verbatim row is always kept on
// `rawNetworkData`.

interface LinkConnectorPromotionRaw {
  // Merchant / campaign identity — name varies by casing across docs versions.
  MerchantId?: string | number;
  Merchant_ID?: string | number;
  CampaignId?: string | number;
  MerchantName?: string;
  Merchant?: string;
  CampaignName?: string;
  // Coupon / promo content.
  PromotionDescription?: string;
  Description?: string;
  CouponCode?: string;
  PromoCode?: string;
  // Tracking + display URLs.
  AffiliateUrl?: string;
  AffiliateURL?: string;
  TrackingURL?: string;
  ClickUrl?: string;
  MerchantUrl?: string;
  Category?: string;
  Categories?: string;
  Currency?: string;
  [key: string]: unknown;
}

interface LinkConnectorTransactionRaw {
  // Identity.
  TransactionId?: string | number;
  TransactionID?: string | number;
  OrderId?: string | number;
  OrderNumber?: string | number;
  MerchantId?: string | number;
  CampaignId?: string | number;
  MerchantName?: string;
  CampaignName?: string;
  Merchant?: string;
  // Amounts.
  OrderAmount?: string | number;
  SaleAmount?: string | number;
  Commission?: string | number;
  CommissionAmount?: string | number;
  Currency?: string;
  // Status + reversal context.
  Status?: string;
  TransactionStatus?: string;
  InvalidReason?: string;
  InvalidationReason?: string;
  // Dates.
  ClickDate?: string;
  TransactionDate?: string;
  OrderDate?: string;
  OriginalDate?: string;
  FundedDate?: string;
  PaidDate?: string;
  [key: string]: unknown;
}

/**
 * LinkConnector wraps function results in a top-level envelope whose key varies
 * (`Promotions`, `Transactions`, `Result`, `Records`, ...). We unwrap defensively
 * to the first array we find, falling back to treating the body itself as the
 * array.
 */
function unwrapRows<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['Promotions', 'Transactions', 'Records', 'Result', 'Results', 'Data', 'Rows']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as T[];
    }
    // A single nested object (e.g. one record) — wrap it.
    for (const key of ['Promotion', 'Transaction', 'Record']) {
      const v = obj[key];
      if (v && typeof v === 'object') return [v as T];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstString(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function toNumber(...values: Array<unknown>): number {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      // Strip currency symbols / thousands separators before parsing.
      const n = Number(v.replace(/[^0-9.-]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Status normalisation: LinkConnector → canonical.
 *
 * LinkConnector reports transaction status as a free-text string. The
 * observed/ documented states are approximated as follows:
 *
 *   approved / valid / confirmed   → 'approved'
 *   pending / open / new           → 'pending'
 *   paid / funded                  → 'paid'
 *   invalid / declined / reversed
 *     / void / cancelled           → 'reversed'
 *   anything else                  → 'other'
 *
 * Why we map 'invalid' to 'reversed': LinkConnector calls a clawed-back or
 * rejected commission "invalid" and exposes an invalidation reason; the
 * user-facing intent is the same as every other network's "reversed" (the
 * sale did not pay out). We never invent a status the user did not see — an
 * unrecognised string maps to 'other'.
 */
export function mapTransactionStatus(raw: LinkConnectorTransactionRaw): TransactionStatus {
  const s = (firstString(raw.Status, raw.TransactionStatus) ?? '').toLowerCase();
  if (s === 'approved' || s === 'valid' || s === 'confirmed' || s === 'active') return 'approved';
  if (s === 'pending' || s === 'open' || s === 'new') return 'pending';
  if (s === 'paid' || s === 'funded') return 'paid';
  if (
    s === 'invalid' ||
    s === 'declined' ||
    s === 'reversed' ||
    s === 'void' ||
    s === 'voided' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'rejected'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Compute the age (in days) of a transaction at the moment this adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this number.
 *
 * Anchor preference: FundedDate (LinkConnector's "approved/funded" point) then
 * the original transaction/order date. For a pending transaction FundedDate is
 * absent, so we fall back to the conversion date.
 */
export function computeAgeDays(raw: LinkConnectorTransactionRaw, now: Date = new Date()): number {
  const anchor = firstString(
    raw.FundedDate,
    raw.OriginalDate,
    raw.TransactionDate,
    raw.OrderDate,
  );
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers (LinkConnector raw → canonical domain types)
// ---------------------------------------------------------------------------

/**
 * The promotions feed is the closest publisher-side view of a merchant the
 * LinkConnector API exposes. We surface each promotion's merchant as a
 * Programme. Status is `joined`: the promotion feed only returns merchants the
 * publisher is approved for, so every row is an active relationship.
 */
export function toProgramme(raw: LinkConnectorPromotionRaw): Programme {
  const id =
    firstString(raw.MerchantId, raw.Merchant_ID, raw.CampaignId) ?? '';
  const name = firstString(raw.MerchantName, raw.Merchant, raw.CampaignName) ?? `LinkConnector merchant ${id}`;
  const categories = firstString(raw.Category, raw.Categories);
  return {
    id,
    name,
    network: SLUG,
    // Promotions are only returned for merchants the publisher works with.
    status: 'joined',
    currency: firstString(raw.Currency),
    advertiserUrl: firstString(raw.MerchantUrl, raw.ClickUrl),
    categories: categories ? [categories] : undefined,
    rawNetworkData: raw,
  };
}

export function toTransaction(
  raw: LinkConnectorTransactionRaw,
  now: Date = new Date(),
): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.Commission, raw.CommissionAmount);
  const amount = toNumber(raw.OrderAmount, raw.SaleAmount);
  const currency = firstString(raw.Currency) ?? DEFAULT_CURRENCY;

  const transactionDate =
    nullableIso(firstString(raw.TransactionDate, raw.OrderDate, raw.OriginalDate)) ??
    new Date(0).toISOString();
  const clickDate = nullableIso(firstString(raw.ClickDate));
  const fundedDate = nullableIso(firstString(raw.FundedDate));
  const paidDate = nullableIso(firstString(raw.PaidDate));

  return {
    id: firstString(raw.TransactionId, raw.TransactionID, raw.OrderId, raw.OrderNumber) ?? '',
    network: SLUG,
    programmeId: firstString(raw.MerchantId, raw.CampaignId) ?? '',
    programmeName: firstString(raw.MerchantName, raw.CampaignName, raw.Merchant) ?? '',
    status,
    amount,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    // FundedDate is LinkConnector's approval/validation point.
    dateApproved: fundedDate,
    datePaid: status === 'paid' ? paidDate ?? fundedDate : paidDate,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — reversed transactions surface LinkConnector's invalidation
    // reason where one is present.
    reversalReason:
      status === 'reversed'
        ? firstString(raw.InvalidReason, raw.InvalidationReason)
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class LinkconnectorAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the merchants the publisher works with, derived from the promotions
   * feed (`getFeedPromotion`).
   *
   * Why the promotions feed rather than a dedicated merchant endpoint: the
   * documented publisher surface does not expose a "list my programmes" call.
   * The promotions feed returns one row per active promotion and is the only
   * per-merchant view with tracking URLs. We de-duplicate by merchant id so a
   * merchant with several promotions appears once.
   *
   * Status filtering: every merchant in the feed is `joined` (the feed only
   * contains merchants the publisher is approved for). A caller asking for any
   * other status gets an empty list rather than a fabricated one.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');

    const body = await linkconnectorRequest<unknown>({
      operation: 'listProgrammes',
      func: 'getFeedPromotion',
      apiKey,
      query: { RowStart: 0, RowsPerCall: 500 },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = unwrapRows<LinkConnectorPromotionRaw>(body);

    // De-duplicate by merchant id; keep the first promotion seen per merchant.
    const byId = new Map<string, Programme>();
    for (const row of rows) {
      const programme = toProgramme(row);
      const key = programme.id || programme.name;
      if (!byId.has(key)) byId.set(key, programme);
    }
    let programmes = [...byId.values()];

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
   * Fetch a single merchant by id.
   *
   * The promotions feed does not support a per-merchant lookup parameter in the
   * documented surface, so we fetch the feed and filter client-side. This is a
   * deliberate trade: one feed pull is cheap relative to the alternative
   * (which does not exist). An unknown id surfaces as a config_error envelope
   * pointing the caller at listProgrammes.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A merchant id is required.',
          hint: 'List programmes first (affiliate_linkconnector_list_programmes) to find the correct id.',
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
          message: `No LinkConnector merchant with id "${programmeId}" was found in the promotions feed.`,
          hint: 'The merchant may not be active for your account, or the id may be wrong. Use list programmes to confirm.',
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
   * programme filters, via `getReportTransaction`.
   *
   * Date params: LinkConnector's report takes day-granular `StartDate` /
   * `EndDate` as `YYYY-MM-DD`. We default to the last 30 days when the caller
   * supplies no window.
   *
   * Pagination: `RowStart` + `RowsPerCall`. We page through the result set
   * until a page returns fewer rows than requested, so a caller asking for a
   * wide window does not silently truncate. Each page is a separate call under
   * the resilience layer.
   *
   * Filters (status, programme, age) are applied client-side after the rows are
   * normalised, mirroring the Awin pattern. Age filters are applied AFTER status
   * filtering so `{ status: 'approved', minAgeDays: 180 }` is meaningful
   * (PRD §15.9).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startDate = dateOnly(from);
    const endDate = dateOnly(to);

    const PAGE_SIZE = 500;
    const MAX_PAGES = 50; // hard ceiling so a misbehaving feed cannot loop forever
    const allRaw: LinkConnectorTransactionRaw[] = [];
    let rowStart = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await linkconnectorRequest<unknown>({
        operation: 'listTransactions',
        func: 'getReportTransaction',
        apiKey,
        query: {
          StartDate: startDate,
          EndDate: endDate,
          RowStart: rowStart,
          RowsPerCall: PAGE_SIZE,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const rows = unwrapRows<LinkConnectorTransactionRaw>(body);
      allRaw.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      rowStart += PAGE_SIZE;
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
   * We derive from `listTransactions` (not a dedicated report endpoint) for the
   * same reasons Awin does: the per-transaction `ageDays` is needed for
   * `oldestUnpaidAgeDays`, and a single source of truth the user can reproduce
   * is preferable to a second, possibly-stale report surface. `getReportTransactionDelta`
   * exists for incremental sync but is not the canonical totals source.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({ ...query, from, to, limit: undefined });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: DEFAULT_CURRENCY,
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
          programmeName: t.programmeName || `LinkConnector merchant ${key}`,
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
      currency: firstCurrency ?? DEFAULT_CURRENCY,
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
   * LinkConnector does not expose click-level data via its public publisher
   * API. We throw `NotImplementedError` rather than returning an empty array —
   * "LinkConnector has no clicks endpoint" and "you had no clicks" are
   * different facts (principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'LinkConnector does not expose click-level data via the public publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * LinkConnector issues tracking URLs per merchant through the promotions
   * feed; it does not document a deterministic deep-link scheme that turns an
   * arbitrary destination URL into a tracked link (the way Awin's
   * `awin1.com/cread.php` does). Constructing one would mean guessing a URL
   * format, which risks producing links that do not track — worse than
   * admitting the gap.
   *
   * We therefore throw `NotImplementedError`. A caller wanting a tracked link
   * should read the affiliate URL from `listProgrammes` (the promotions feed
   * carries it per merchant).
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'LinkConnector does not document a deterministic deep-link scheme; tracking URLs are issued per merchant via the promotions feed (see listProgrammes).',
    );
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

    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known merchant id; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'LinkConnector does not expose click-level data via the public publisher API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'No documented deterministic deep-link scheme; tracking URLs come from the promotions feed.',
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
// Module-level registration (side effect on import). See Awin's adapter for
// the aggregator-import rationale.
// ---------------------------------------------------------------------------

export const linkconnectorAdapter = new LinkconnectorAdapter();
registerAdapter(linkconnectorAdapter);

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

/** Format a Date as `YYYY-MM-DD` for LinkConnector's day-granular report params. */
function dateOnly(d: Date): string {
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  unwrapRows,
  dateOnly,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
