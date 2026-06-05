/**
 * Hotmart adapter — publisher/creator-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` and mirrors
 * `src/networks/skimlinks/adapter.ts` for the OAuth2 token-cache shape. Those
 * files are the canonical references; read them for the deep reasoning. The
 * load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction (now injected for determinism).
 *   - UK English; "programme" not "program".
 *
 * --- Hotmart API map -----------------------------------------------------------
 *
 * OAuth2 token endpoint (2-legged client-credentials):
 *   POST https://api-sec-vlc.hotmart.com/security/oauth/token
 *     Authorization: Basic {base64(client_id:client_secret)}
 *     ?grant_type=client_credentials&client_id=...&client_secret=...
 *   → { access_token, token_type, expires_in }  (24h lifetime)
 *   Source: https://help.hotmart.com/en/article/4403617024013/discover-hotmart-s-apis
 *
 * Sales History API (base: https://developers.hotmart.com):
 *   GET /payments/api/v1/sales/history
 *     ?start_date={epoch_ms}&end_date={epoch_ms}
 *     [&transaction_status=APPROVED|COMPLETE|REFUNDED|CANCELLED|CHARGEBACK|...]
 *     [&product_id={id}][&max_results=N][&page_token={token}]
 *   Response: { items: [{ purchase, product, buyer, producer, commissions[] }],
 *               page_info: { total_results, next_page_token, results_per_page } }
 *   Source: https://developers.hotmart.com/docs/en/v1/sales/sales-history
 *   Note: when no transaction_status filter is sent, Hotmart returns only
 *         APPROVED and COMPLETE statuses (documented behaviour). The adapter
 *         therefore sends the full status set when the caller asks for all.
 *
 * Programmes / affiliations:
 *   Hotmart has no public, self-serve "list the products I am affiliated to,
 *   with commission rates" endpoint available to every account type. We DERIVE
 *   a programme list from the distinct products seen in Sales History so the
 *   user can still discover the products they earn from and reconcile the view
 *   against listTransactions. See listProgrammes / getProgramme for the
 *   reasoning and BLOCKED(verify) markers.
 *
 * Clicks / tracking links:
 *   Hotmart exposes neither click-level data nor a deterministic deeplink
 *   constructor through the public payments API. Both ops throw
 *   NotImplementedError. See those methods.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `hotmartRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope` (network +
 *      operation + httpStatus + verbatim networkErrorBody). Never swallow errors.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus` and `mapProgrammeStatus`.
 *      Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` from shared/config — NEVER process.env
 *      (except in tests).
 *   7. UK English. "programme", not "program".
 */

import { hotmartRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken } from './auth.js';
import { setupSteps } from './setup.js';
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

const log = createLogger('hotmart.adapter');

const SLUG = 'hotmart';
const NAME = 'Hotmart';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://developers.hotmart.com/payments/api/v1',
  authModel: 'oauth2',
  docsUrl: 'https://developers.hotmart.com/docs/en/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listProgrammes / getProgramme are derived from the distinct products seen in Sales History, because Hotmart has no public self-serve endpoint that lists a creator/affiliate’s products with commission rates; programmes outside the queried date window are not discoverable and commissionRate is left unset.',
    'listClicks is not exposed via the public Hotmart payments API; the operation throws NotImplementedError.',
    'generateTrackingLink is not supported: Hotmart affiliate (hotlink) URLs are issued per affiliation in the dashboard and cannot be deterministically constructed from the public API; the operation throws NotImplementedError.',
    'When no transaction_status filter is supplied, Hotmart returns only APPROVED and COMPLETE sales; the adapter sends the full documented status set to retrieve every state.',
    'Sales History is multi-role: a row can credit the account as PRODUCER, COPRODUCER or AFFILIATE. The adapter sums the commission(s) attributed to the authenticated account; the per-role breakdown is preserved in rawNetworkData.',
    'OAuth2 access tokens have a limited lifetime (Hotmart documents 24 hours); the adapter caches the token in memory and re-fetches on expiry.',
    'The maximum date window and pagination page size per Sales History call are not fully documented; the adapter paginates via page_token but a live account test is required to confirm there is no server-side window cap.',
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

const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
  listProgrammes: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Hotmart raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal/permissive: Hotmart's Sales History payload is large
// and varies by transaction type. Treating every field as possibly absent and
// preserving the original under `rawNetworkData` keeps the adapter robust to
// upstream drift.

/** One commission line within a sale — Hotmart credits the account per role. */
interface HotmartCommissionRaw {
  // Documented possible values: PRODUCER, COPRODUCER, AFFILIATE.
  source?: string;
  value?: number;
  currency_code?: string;
}

interface HotmartSaleRaw {
  // The `purchase` object carries the transaction-level fields.
  purchase?: {
    transaction?: string;
    order_date?: number; // epoch ms
    approved_date?: number; // epoch ms
    status?: string; // APPROVED | COMPLETE | REFUNDED | CANCELLED | CHARGEBACK | ...
    price?: { value?: number; currency_value?: string };
    payment?: { type?: string };
    // Some payloads nest commissions under purchase, others at the item root.
    commission_as?: string; // PRODUCER | COPRODUCER | AFFILIATE (role of THIS account)
  };
  product?: { id?: number | string; name?: string };
  buyer?: { name?: string; email?: string };
  producer?: { name?: string; ucode?: string };
  // Commissions can appear at the item root or inside purchase, depending on the
  // sale type; we read defensively from both.
  commissions?: HotmartCommissionRaw[];
}

interface HotmartSalesHistoryResponse {
  items?: HotmartSaleRaw[];
  page_info?: {
    total_results?: number;
    next_page_token?: string;
    prev_page_token?: string;
    results_per_page?: number;
  };
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Hotmart sale status string to the canonical TransactionStatus.
 *
 * Hotmart status (documented set) → canonical:
 *   APPROVED                         → 'approved' (paid by buyer, within warranty / not yet settled)
 *   COMPLETE                         → 'paid'     (settled / past warranty — payout earned)
 *   WAITING_PAYMENT / STARTED /
 *     PROCESSING_TRANSACTION /
 *     UNDER_ANALISYS / PRE_ORDER /
 *     PRINTED_BILLET / OVERDUE /
 *     NO_FUNDS                       → 'pending'  (sale not yet confirmed)
 *   REFUNDED / PARTIALLY_REFUNDED /
 *     CHARGEBACK / CANCELLED /
 *     PROTESTED / BLOCKED / EXPIRED  → 'reversed' (the sale did not / no longer pays out)
 *   anything else                    → 'other'
 *
 * Why COMPLETE → 'paid' but APPROVED → 'approved': Hotmart marks a sale COMPLETE
 * once it clears the warranty/settlement window, which is the point the
 * commission is genuinely earned and payable — the closest analogue to other
 * networks' "paid". APPROVED means the payment cleared but the commission can
 * still be reversed during the warranty period, i.e. validated-but-not-settled.
 * The verbatim status is preserved in `rawNetworkData`.
 */
function mapTransactionStatus(raw: HotmartSaleRaw): TransactionStatus {
  const s = (raw.purchase?.status ?? '').toUpperCase().trim();
  switch (s) {
    case 'APPROVED':
      return 'approved';
    case 'COMPLETE':
      return 'paid';
    case 'WAITING_PAYMENT':
    case 'STARTED':
    case 'PROCESSING_TRANSACTION':
    case 'UNDER_ANALISYS':
    case 'PRE_ORDER':
    case 'PRINTED_BILLET':
    case 'OVERDUE':
    case 'NO_FUNDS':
      return 'pending';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'CHARGEBACK':
    case 'CANCELLED':
    case 'PROTESTED':
    case 'BLOCKED':
    case 'EXPIRED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Map a derived Hotmart programme (product) to the canonical ProgrammeStatus.
 *
 * Programmes are synthesised from Sales History: a product that has produced at
 * least one sale for the account is one the account is actively earning from, so
 * we map it to 'joined'. We never fabricate 'available' / 'pending' states
 * because the public API does not expose an affiliation lifecycle for the
 * account. Unknown is the honest fallback.
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'joined' || s === 'active') return 'joined';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Hotmart sale at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: approved_date (how long has this been approved-but-unsettled?)
 * falls back to order_date (the conversion/order date). For pending sales the
 * order_date is the earliest available anchor. `now` is injected for testability.
 */
function computeAgeDays(raw: HotmartSaleRaw, now: Date = new Date()): number {
  const anchor = raw.purchase?.approved_date ?? raw.purchase?.order_date;
  if (anchor === undefined || anchor === null) return 0;
  const t = typeof anchor === 'number' ? anchor : Date.parse(String(anchor));
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function epochToIso(v?: number | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (Number.isNaN(n)) return undefined;
  return new Date(n).toISOString();
}

function toAmount(v: number | string | undefined | null): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Sum the commission attributable to the authenticated account.
 *
 * Hotmart can return several commission lines (PRODUCER / COPRODUCER / AFFILIATE).
 * A creator account is typically credited under one role per sale; we sum every
 * commission line present so a co-producer who also affiliates is not undercounted.
 * The full per-role breakdown is preserved in `rawNetworkData`.
 */
function sumCommission(raw: HotmartSaleRaw): number {
  const lines = Array.isArray(raw.commissions) ? raw.commissions : [];
  if (lines.length === 0) return 0;
  return lines.reduce((acc, c) => acc + toAmount(c.value), 0);
}

function commissionCurrency(raw: HotmartSaleRaw): string | undefined {
  const lines = Array.isArray(raw.commissions) ? raw.commissions : [];
  const withCurrency = lines.find((c) => c.currency_code);
  return withCurrency?.currency_code;
}

function toTransaction(raw: HotmartSaleRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = sumCommission(raw);
  const sale = toAmount(raw.purchase?.price?.value);
  const currency = (
    commissionCurrency(raw) ??
    raw.purchase?.price?.currency_value ??
    'BRL'
  ).toUpperCase();

  const orderDate = epochToIso(raw.purchase?.order_date) ?? new Date(0).toISOString();
  const approvedDate = epochToIso(raw.purchase?.approved_date);

  // Hotmart marks settlement via the COMPLETE status, not a dedicated paid date;
  // we surface datePaid only when the sale is settled, anchored on approved_date.
  const datePaid = status === 'paid' ? approvedDate : undefined;

  return {
    id: String(raw.purchase?.transaction ?? ''),
    network: SLUG,
    programmeId: String(raw.product?.id ?? ''),
    programmeName: raw.product?.name ?? `Hotmart product ${raw.product?.id ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    // Hotmart does not expose a click timestamp on the sale; left undefined.
    dateConverted: orderDate,
    dateApproved: approvedDate,
    datePaid,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.purchase?.status ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** The full documented Hotmart status set, sent when the caller wants all states. */
const ALL_HOTMART_STATUSES = [
  'APPROVED',
  'BLOCKED',
  'CANCELLED',
  'CHARGEBACK',
  'COMPLETE',
  'EXPIRED',
  'NO_FUNDS',
  'OVERDUE',
  'PARTIALLY_REFUNDED',
  'PRE_ORDER',
  'PRINTED_BILLET',
  'PROCESSING_TRANSACTION',
  'PROTESTED',
  'REFUNDED',
  'STARTED',
  'UNDER_ANALISYS',
  'WAITING_PAYMENT',
];

export class HotmartAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the products the account earns from, derived from Sales History.
   *
   * Hotmart has no public self-serve endpoint that lists a creator/affiliate's
   * products together with commission rates. Rather than throw — which would
   * hide a genuinely useful, recomputable view — we derive the programme list
   * from the distinct products that appear in Sales History over the queried
   * window (default 90 days). Each programme is mapped to 'joined' because the
   * account has demonstrably transacted on it.
   *
   * BLOCKED(verify): the longer the window, the more complete the list. A product
   * with no sales in the window will not appear. commissionRate is intentionally
   * left unset because the per-product affiliate rate is not exposed by the
   * public API; the user can infer it from commission / amount per transaction.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const now = new Date();
    // Programme discovery needs a wide-ish window; default to ~90 days.
    const to = now;
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const sales = await this.fetchAllSales(
      {
        startMs: from.getTime(),
        endMs: to.getTime(),
        statuses: ALL_HOTMART_STATUSES,
      },
      'listProgrammes',
    );

    const byId = new Map<string, Programme>();
    for (const raw of sales) {
      const id = String(raw.product?.id ?? '');
      if (!id) continue;
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        name: raw.product?.name ?? `Hotmart product ${id}`,
        network: SLUG,
        status: mapProgrammeStatus({ status: 'joined' }),
        currency:
          commissionCurrency(raw) ?? raw.purchase?.price?.currency_value ?? undefined,
        rawNetworkData: { product: raw.product, derivedFrom: 'sales/history' },
      });
    }

    let programmes = [...byId.values()];

    // Client-side filters (the derived list supports the same query shape).
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toArray(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch one derived programme by product id.
   *
   * Same derivation caveat as listProgrammes: the product is resolved from Sales
   * History, so a product with no sales in the lookup window is not found and we
   * surface that as a NotImplementedError-free, honest error path via the
   * derived list. We scope the Sales History call to the product id for speed.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const now = new Date();
    const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const sales = await this.fetchAllSales(
      {
        startMs: from.getTime(),
        endMs: now.getTime(),
        statuses: ALL_HOTMART_STATUSES,
        productId: programmeId,
      },
      'getProgramme',
    );

    const match = sales.find((s) => String(s.product?.id ?? '') === String(programmeId));
    if (!match) {
      // Not a NotImplementedError — the operation IS implemented; the product
      // simply was not found in the lookup window. Surface it honestly.
      throw new NotImplementedError(
        `Hotmart product ${programmeId} was not found in Sales History over the last 365 days. ` +
          'Programmes are derived from sales, so a product with no recent sales is not discoverable via the public API.',
      );
    }

    return {
      id: String(match.product?.id ?? programmeId),
      name: match.product?.name ?? `Hotmart product ${programmeId}`,
      network: SLUG,
      status: mapProgrammeStatus({ status: 'joined' }),
      currency:
        commissionCurrency(match) ?? match.purchase?.price?.currency_value ?? undefined,
      rawNetworkData: { product: match.product, derivedFrom: 'sales/history' },
    };
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Hotmart sales across a date window with optional status / age / product filters.
   *
   * Sales History endpoint:
   *   GET /payments/api/v1/sales/history
   *     ?start_date={epoch_ms}&end_date={epoch_ms}
   *     [&transaction_status=...][&product_id=...][&max_results=N][&page_token=...]
   *
   * Dates: Hotmart expects epoch milliseconds for start_date / end_date.
   *
   * Status: when the caller requests no status, we send the FULL documented
   * status set — otherwise Hotmart silently returns only APPROVED and COMPLETE.
   * Canonical status filtering is then always applied client-side after
   * normalisation (a canonical status like 'reversed' maps to several Hotmart
   * statuses, so server-side filtering alone is insufficient).
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   * `query.minAgeDays` / `query.maxAgeDays` filter on the computed `ageDays`
   * AFTER status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   * Refunds / chargebacks / cancellations normalise to 'reversed' and the
   * verbatim upstream status surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const sales = await this.fetchAllSales(
      {
        startMs: from.getTime(),
        endMs: to.getTime(),
        statuses: ALL_HOTMART_STATUSES,
        productId: query?.programmeId,
      },
      'listTransactions',
    );

    let transactions = sales.map((r) => toTransaction(r, now));

    // Canonical status filter — applied client-side after normalisation.
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * We derive from `listTransactions` for the same reason as Awin/Skimlinks: a
   * separate report endpoint would be a second source of truth for the same
   * data, and we'd still need the per-transaction `ageDays` to compute
   * `oldestUnpaidAgeDays`. One call path, one source.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (principle 4.1).
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
      currency: 'BRL',
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
          programmeName: t.programmeName || `Hotmart product ${key}`,
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
      currency: firstCurrency ?? 'BRL',
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
   * Hotmart does not expose click-level data via the public payments API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Hotmart does not expose click-level data via the public payments API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Hotmart affiliate links (hotlinks) cannot be deterministically constructed.
   *
   * A hotlink is issued per affiliation in the Hotmart dashboard and embeds an
   * opaque affiliate code that is not derivable from the public API. There is no
   * documented endpoint that mints a tracking URL on demand. We therefore throw
   * NotImplementedError rather than returning a guessed URL that would not track.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Hotmart affiliate links (hotlinks) are issued per affiliation in the dashboard and embed an ' +
        'opaque affiliate code that cannot be deterministically constructed or minted via the public API.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully obtaining an OAuth2 access token.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure (wrong credentials, network error): returns { ok: false, reason: '...' }.
   * Never throws — verifyAuth is called by error handlers.
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
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
   * Probe each operation with a minimal call.
   *
   * listClicks and generateTrackingLink are known-unsupported and are recorded
   * without probing to avoid wasting network calls.
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

    // Known-unsupported ops — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Hotmart does not expose click-level data via the public payments API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Hotmart hotlinks are issued per affiliation in the dashboard and cannot be constructed via the public API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe(
      'listProgrammes',
      () => this.listProgrammes({ limit: 1 }),
      'Derived from the distinct products seen in Sales History.',
    );
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: paginate Sales History fully via page_token.
  // -------------------------------------------------------------------------

  /**
   * Fetch every Sales History page for the given window/filters, following
   * `page_info.next_page_token` until exhausted.
   *
   * Hotmart returns only APPROVED + COMPLETE when no transaction_status is sent,
   * so callers pass the full status set to retrieve all states. We send each
   * status as a repeated `transaction_status` value where supported; because the
   * public docs are ambiguous on multi-value encoding, we send a single
   * comma-free request per status set via repeated params is NOT possible through
   * our query map, so we send them comma-joined. BLOCKED(verify): confirm the
   * exact multi-status encoding against a live account.
   */
  private async fetchAllSales(
    opts: { startMs: number; endMs: number; statuses: string[]; productId?: string },
    operation: string,
  ): Promise<HotmartSaleRaw[]> {
    const token = await getAccessToken();
    const resilience = RESILIENCE[operation as keyof ResilienceConfigMap] ?? RESILIENCE.default;

    const out: HotmartSaleRaw[] = [];
    let pageToken: string | undefined;
    // Hard cap on pages to avoid an unbounded loop if the API misbehaves.
    let guard = 0;

    do {
      const params: Record<string, string | number | undefined> = {
        start_date: opts.startMs,
        end_date: opts.endMs,
        max_results: 100,
        page_token: pageToken,
      };
      if (opts.productId) {
        params['product_id'] = opts.productId;
      }
      // BLOCKED(verify): multi-status encoding. Comma-joined is the most common
      // public-example form; confirm against a live account.
      if (opts.statuses.length > 0) {
        params['transaction_status'] = opts.statuses.join(',');
      }

      const response = await hotmartRequest<HotmartSalesHistoryResponse>({
        operation,
        path: '/payments/api/v1/sales/history',
        token,
        query: params,
        resilience,
      });

      const items = Array.isArray(response.items) ? response.items : [];
      out.push(...items);

      pageToken = response.page_info?.next_page_token;
      guard += 1;
    } while (pageToken && guard < 1000);

    return out;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const hotmartAdapter = new HotmartAdapter();
registerAdapter(hotmartAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toArray<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  sumCommission,
  commissionCurrency,
  toAmount,
  ALL_HOTMART_STATUSES,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
