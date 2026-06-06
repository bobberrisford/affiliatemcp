/**
 * ShopMy adapter — publisher side, single-brand brand partner.
 *
 * ShopMy (https://shopmy.us) is a US creator commerce network. This adapter
 * integrates the **Brand Partner API** (https://docs.shopmy.us/), which issues a
 * single long-lived token scoped to one brand. That shapes the adapter:
 *
 *   - A brand partner token does not browse a catalogue of merchants — it
 *     represents exactly one brand. So `listProgrammes` returns the single
 *     configured brand as one Programme, and `getProgramme` returns the same.
 *   - The workhorse is the order report (`/v1/Partners/OrderReport`), which
 *     lists commissionable orders attributed to the brand across all of
 *     ShopMy's affiliate sources.
 *
 * Built on the Awin reference pattern (`src/networks/awin/adapter.ts`); read
 * that file's header for the six cardinal rules. The non-obvious ShopMy
 * decisions are documented inline.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — returns the single configured brand as one programme.
 *   getProgramme        — drill-down on that same brand.
 *   listTransactions    — order report: earnings, status, ageing.
 *   getEarningsSummary  — aggregation derived from listTransactions.
 *   listClicks          — NOT exposed via the Brand Partner API → NotImplemented.
 *   generateTrackingLink— requires the OAuth `write_links` developer API, a
 *                         different credential model → NotImplemented.
 *   verifyAuth          — cheap order-report probe (see auth.ts).
 *
 * --- ShopMy API map (verify against https://docs.shopmy.us/) ----------------
 *
 *   GET /v1/Partners/OrderReport
 *     → brand order report. Orders by transaction date descending. Max 500
 *       per page; 200 requests/day rate limit. A 30-day return window applies
 *       from the transaction date before amounts lock.
 *     Docs: https://docs.shopmy.us/reference/fetch-order-report
 *
 *   POST create-link (OAuth `write_links` scope)
 *     → creates a ShopMy link on behalf of an authenticated ShopMy user. Needs
 *       OAuth, not the single-brand partner token, so it is out of scope here.
 *     Docs: https://docs.shopmy.us/reference/create-link
 *
 * --- Assumptions to verify against a live brand partner account --------------
 *
 *   - Auth header: `x-api-key` (see client.ts).
 *   - Amount unit: order/commission amounts are treated as integer **cents**
 *     and divided by 100 (see `centsToMajor` / `AMOUNT_UNIT`). US APIs commonly
 *     report cents; if ShopMy reports major units, flip `AMOUNT_UNIT`.
 *   - Order report response field names are read defensively across plausible
 *     spellings because the public reference does not pin an exact schema.
 */

import { shopmyRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential, getCredential } from '../../shared/config.js';
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

const log = createLogger('shopmy.adapter');

const SLUG = 'shopmy';
const NAME = 'ShopMy';

/**
 * Amount unit divisor. ShopMy order/commission amounts are assumed to be
 * integer cents; dividing by 100 yields major currency units. Flip to `1` if a
 * live account shows the API already reports major units.
 */
const AMOUNT_UNIT = 100;

/** ShopMy reports US dollars. */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.shopmy.us',
  // ShopMy's brand partner token is a static secret sent under a custom header
  // (`x-api-key`); it is not a standard OAuth bearer flow.
  authModel: 'custom',
  docsUrl: 'https://docs.shopmy.us/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: the adapter has not been validated against a live ShopMy
  // brand partner account, and the auth header, amount unit, and order-report
  // field names are assumptions.
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: not yet validated against a live ShopMy brand partner account; the auth header, order-report field names, and status mapping are unconfirmed assumptions.',
    'Order and commission amounts are assumed to be reported in integer cents and divided by 100; confirm the unit against a real account before relying on totals.',
    'Click-level data is not exposed via the Brand Partner API; listClicks is unsupported.',
    'Tracking-link creation requires the OAuth write_links developer API and an authenticated ShopMy user, not the single-brand partner token; generateTrackingLink is unsupported.',
    'A brand partner token addresses one brand, so listProgrammes returns that single brand rather than a merchant catalogue.',
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
 * The order report can be slow over wide windows and is the only paginated
 * endpoint, so it gets a longer timeout and an extra retry. Other ops use the
 * default profile.
 */
const ORDER_REPORT_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: ORDER_REPORT_RESILIENCE,
  getEarningsSummary: ORDER_REPORT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// ShopMy response shapes (deliberately minimal / defensive)
// ---------------------------------------------------------------------------
//
// The public reference does not pin an exact order-report schema, so we read
// keys defensively across plausible spellings and always keep the verbatim
// payload on `rawNetworkData`. We never reject an unexpected shape here.
// ---------------------------------------------------------------------------

interface ShopmyOrderRaw {
  id?: string | number;
  order_id?: string | number;
  orderId?: string | number;
  // Status: ShopMy moves orders pending → locked → paid, with cancelled for
  // returns. Field name varies; read several.
  status?: string;
  order_status?: string;
  commission_status?: string;
  // Sale / order value. Assumed cents.
  amount?: number;
  order_amount?: number;
  order_value?: number;
  sale_amount?: number;
  // Commission earned by the brand partner. Assumed cents.
  commission?: number;
  commission_amount?: number;
  commission_cents?: number;
  // Dates (ISO 8601).
  order_date?: string;
  transaction_date?: string;
  date?: string;
  locked_date?: string;
  paid_date?: string;
  currency?: string;
  // Attribution context — surfaced through rawNetworkData regardless.
  source?: string;
  user_name?: string;
}

/** The order report response may be a bare array or an envelope. */
interface ShopmyOrderReportEnvelope {
  orders?: ShopmyOrderRaw[];
  results?: ShopmyOrderRaw[];
  data?: ShopmyOrderRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: ShopMy → canonical.
 *
 *   pending             → 'pending'   (return window still open)
 *   locked              → 'approved'  (return window closed, eligible for payout)
 *   paid                → 'paid'      (included in a weekly payout)
 *   cancelled/returned  → 'reversed'  (the order did not pay out)
 *   anything else       → 'other'
 *
 * We map ShopMy's `locked` to our `approved` because, like Awin's "approved",
 * it is the "validated but not yet paid" state the unpaid-age affordance cares
 * about. The raw value stays on `rawNetworkData`.
 */
function mapTransactionStatus(raw: ShopmyOrderRaw): TransactionStatus {
  const s = (raw.status ?? raw.order_status ?? raw.commission_status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'locked' || s === 'approved' || s === 'confirmed') return 'approved';
  if (s === 'paid') return 'paid';
  if (s === 'cancelled' || s === 'canceled' || s === 'returned' || s === 'reversed') {
    return 'reversed';
  }
  return 'other';
}

function readAmountCents(...candidates: Array<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === 'number' && !Number.isNaN(c)) return c;
  }
  return 0;
}

/** Convert an assumed-cents integer to major currency units. */
function centsToMajor(cents: number): number {
  return cents / AMOUNT_UNIT;
}

/**
 * Compute the age (in days) of an order at the moment this adapter responded.
 *
 * We anchor on `locked_date` (the "approved" moment) when present, then
 * `transaction_date`/`order_date`. This makes "how long has this been
 * locked-but-unpaid" meaningful for the unpaid-age affordance.
 */
function computeAgeDays(raw: ShopmyOrderRaw, now: Date = new Date()): number {
  const anchor = raw.locked_date ?? raw.transaction_date ?? raw.order_date ?? raw.date;
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

function toTransaction(
  raw: ShopmyOrderRaw,
  programmeId: string,
  programmeName: string,
  now: Date = new Date(),
): Transaction {
  const status = mapTransactionStatus(raw);
  const amount = centsToMajor(
    readAmountCents(raw.amount, raw.order_amount, raw.order_value, raw.sale_amount),
  );
  const commission = centsToMajor(
    readAmountCents(raw.commission, raw.commission_amount, raw.commission_cents),
  );
  const currency = raw.currency ?? DEFAULT_CURRENCY;

  const converted =
    nullableIso(raw.transaction_date ?? raw.order_date ?? raw.date) ?? new Date(0).toISOString();

  return {
    id: String(raw.id ?? raw.order_id ?? raw.orderId ?? ''),
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount,
    currency,
    commission,
    dateClicked: undefined,
    dateConverted: converted,
    dateApproved: nullableIso(raw.locked_date),
    datePaid: nullableIso(raw.paid_date),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

/**
 * The synthetic programme that represents the configured brand. A brand partner
 * token addresses exactly one brand, so this is the only programme the adapter
 * exposes. The label comes from the optional SHOPMY_BRAND_NAME env var.
 */
function brandProgramme(): Programme {
  const brand = getCredential('SHOPMY_BRAND_NAME');
  const id = brand ?? 'brand';
  return {
    id,
    name: brand ?? 'ShopMy brand',
    network: SLUG,
    // The token only exists because the brand partnership is active.
    status: 'joined',
    currency: DEFAULT_CURRENCY,
    rawNetworkData: {
      note: 'Synthetic programme: a ShopMy brand partner token addresses a single brand.',
      brandLabel: brand,
    },
  };
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. ShopMy returns up to 500
 * orders per page; to keep individual calls bounded over wide windows we slice
 * the date range and page within each slice. 31 days mirrors the Awin chunk
 * size and keeps each call's result set small.
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

/** ShopMy date params accept ISO-8601; strip milliseconds for parser safety. */
function formatShopmyDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

function unwrapOrders(raw: ShopmyOrderReportEnvelope | ShopmyOrderRaw[]): ShopmyOrderRaw[] {
  if (Array.isArray(raw)) return raw;
  return raw.orders ?? raw.results ?? raw.data ?? [];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class ShopmyAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * Return the single configured brand as one programme.
   *
   * A ShopMy brand partner token does not browse a merchant catalogue — it
   * represents one brand. We require the token to be configured so a
   * half-configured environment fails here rather than at first transaction
   * fetch, then return the synthetic brand programme. Client-side `search` /
   * `status` / `categories` / `limit` filters are applied for contract parity
   * with the other adapters.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    requireCredential('SHOPMY_API_TOKEN', {
      network: SLUG,
      operation: 'listProgrammes',
      hint: 'Run `affiliate-networks-mcp setup shopmy` to set SHOPMY_API_TOKEN.',
    });

    let programmes = [brandProgramme()];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      programmes = programmes.filter((p) => wanted.has(p.status));
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
   * Return the configured brand. The `programmeId` is informational only: a
   * brand partner token addresses exactly one brand, so there is no other
   * programme to fetch.
   */
  async getProgramme(_programmeId: string): Promise<Programme> {
    requireCredential('SHOPMY_API_TOKEN', {
      network: SLUG,
      operation: 'getProgramme',
      hint: 'Run `affiliate-networks-mcp setup shopmy` to set SHOPMY_API_TOKEN.',
    });
    return brandProgramme();
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List brand orders across a date window with optional status / age filters.
   *
   * ShopMy endpoint:
   *   GET /v1/Partners/OrderReport?fromDate=...&toDate=...&limit=500&page=N
   *
   * ShopMy returns up to 500 orders per page (200 requests/day rate limit),
   * ordered by transaction date descending. We chunk wide windows into 31-day
   * slices and page within each slice until a short page signals the end.
   *
   * Unpaid-age filter (PRD §15.9): `minAgeDays` returns only orders whose
   * computed `ageDays` is >= the threshold, applied after status filtering.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireCredential('SHOPMY_API_TOKEN', {
      network: SLUG,
      operation: 'listTransactions',
      hint: 'Run `affiliate-networks-mcp setup shopmy` to set SHOPMY_API_TOKEN.',
    });

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const PAGE_SIZE = 500;
    const slices = chunkDateRange(from, to, 31);

    const allRaw: ShopmyOrderRaw[] = [];
    for (const slice of slices) {
      let page = 1;
      // Guard against runaway pagination: 200 requests/day cap means a sane
      // ceiling is well under that, but bound it anyway.
      for (;;) {
        const raw = await shopmyRequest<ShopmyOrderReportEnvelope | ShopmyOrderRaw[]>({
          operation: 'listTransactions',
          path: '/v1/Partners/OrderReport',
          token,
          query: {
            fromDate: formatShopmyDate(slice.start),
            toDate: formatShopmyDate(slice.end),
            limit: PAGE_SIZE,
            page,
          },
          resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
        });
        const orders = unwrapOrders(raw);
        allRaw.push(...orders);
        // A short page (fewer than the requested limit) is the last page.
        if (orders.length < PAGE_SIZE) break;
        page += 1;
        if (page > 50) break;
      }
    }

    const programme = brandProgramme();
    let transactions = allRaw.map((r) => toTransaction(r, programme.id, programme.name, now));

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
   * Aggregate orders into an earnings summary, derived from listTransactions so
   * the user can reproduce the totals. We count commission (the brand partner's
   * earnings), never the gross sale amount. `oldestUnpaidAgeDays` is the maximum
   * age among pending/approved orders.
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
          programmeName: t.programmeName || 'ShopMy brand',
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
   * ShopMy's Brand Partner API does not expose click-level data. We throw
   * rather than return an empty array — "no API" is not "no clicks" (PRD
   * principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'ShopMy does not expose click-level data via the Brand Partner API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Link creation on ShopMy (`create-link`) is part of the OAuth developer API
   * and requires the `write_links` scope granted by an authenticated ShopMy
   * user. That is a different credential model from the single-brand partner
   * token this adapter holds, so we cannot construct or request a tracking link
   * here. We throw rather than fabricate a URL.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'ShopMy tracking-link creation requires the OAuth write_links developer API and an ' +
        'authenticated ShopMy user, not the single-brand brand partner token used by this adapter',
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

    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Returns the single configured brand; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'ShopMy does not expose click-level data via the Brand Partner API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Requires the OAuth write_links developer API, not the brand partner token',
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
// Module-level registration (see Awin's note on the aggregator pattern).
// ---------------------------------------------------------------------------

export const shopmyAdapter = new ShopmyAdapter();
registerAdapter(shopmyAdapter);

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  centsToMajor,
  toTransaction,
  brandProgramme,
  chunkDateRange,
  formatShopmyDate,
  unwrapOrders,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
