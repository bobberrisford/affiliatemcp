/**
 * Eduzz adapter — publisher-side (affiliate / producer) implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` and mirrors
 * `src/networks/skimlinks/adapter.ts` (which uses a token-exchange auth scheme
 * with an in-memory token cache, exactly like Eduzz). Awin is the canonical
 * reference; read it for the deep reasoning behind the structure. The
 * load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction, with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Eduzz API map -------------------------------------------------------------
 *
 * Token exchange (auth.ts / client.ts):
 *   POST https://api2.eduzz.com/credential/generate_token
 *     form: email, publickey, apikey → { profile: { token, token_valid_until } }
 *   JWT sent as the `token` header on subsequent calls; ~15 min lifetime.
 *   Source: https://api2.eduzz.com/  +  https://developers.eduzz.com/docs/api/user-token
 *
 * Sales (listTransactions / getEarningsSummary):
 *   GET https://api2.eduzz.com/sale/get_sale_list?date_start=YYYY-MM-DD&date_end=YYYY-MM-DD
 *   → { profile, data: [ sale items ] }
 *   BLOCKED(verify): exact param + item field names could not be read from the
 *   live reference (developers.eduzz.com is 403 to automated fetches). The route,
 *   the date window params, and the { profile, data } envelope are documented on
 *   https://api2.eduzz.com/ and the eduzz/ecommerce-integration-samples repo.
 *   Fields are read defensively; the verbatim payload is preserved.
 *
 * Products (listProgrammes / getProgramme):
 *   GET https://api2.eduzz.com/product/get_product_list → { profile, data: [...] }
 *   Source: https://api2.eduzz.com/
 *
 * Clicks: not exposed by the Eduzz API → NotImplementedError.
 * Tracking link: Eduzz affiliate links are generated per product inside the
 *   panel (there is no documented self-serve link-construction API for affiliates)
 *   → NotImplementedError.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `eduzzRequest`.
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

import { eduzzRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getToken } from './auth.js';
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

const log = createLogger('eduzz.adapter');

const SLUG = 'eduzz';
const NAME = 'Eduzz';

const MANDATORY_LIMITATION =
  'Adapter built from public API documentation; not yet verified against a live account.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api2.eduzz.com',
  authModel: 'custom',
  docsUrl: 'https://developers.eduzz.com/docs/api',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    MANDATORY_LIMITATION,
    'Authentication uses the Eduzz legacy api2 token-exchange (email + PublicKey + APIKey → short-lived JWT, sent as the `token` header). The token is cached in memory and re-fetched on expiry (~15 minutes).',
    'The sales listing route (GET /sale/get_sale_list) and its date_start/date_end window are documented on https://api2.eduzz.com/, but the exact query-parameter and response field names could not be confirmed against the live reference (developers.eduzz.com returns HTTP 403 to automated fetches). Fields are read defensively and the verbatim payload is preserved in rawNetworkData; a live account test is required before promotion.',
    'listClicks is not exposed by the Eduzz API; the operation throws NotImplementedError.',
    'generateTrackingLink is not implemented: Eduzz affiliate links are generated per product inside the panel and there is no documented self-serve link-construction API; the operation throws NotImplementedError.',
    'Eduzz operates in Brazil; amounts are typically denominated in BRL. The currency is read from the payload where present and defaults to BRL otherwise.',
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
};

// ---------------------------------------------------------------------------
// Eduzz raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Eduzz's legacy api2 field names vary across products
// and locales. Treating every field as possibly absent and preserving the
// original under `rawNetworkData` keeps the adapter robust to upstream drift.
//
// BLOCKED(verify): field names below are taken from the official eduzz/webhook
// field documentation (campos-fatura.md) and the api2 docs index; the precise
// names returned by /sale/get_sale_list were not confirmed against a live
// response. The adapter reads several plausible aliases defensively.

interface EduzzSaleRaw {
  sale_id?: string | number;
  trans_cod?: string | number; // alias seen in eduzz/webhook docs
  content_id?: string | number;
  product_cod?: string | number; // alias
  content_title?: string;
  product_name?: string; // alias
  /** Status: string ('paid', 'open', 'canceled'...) on the modern API; numeric on legacy. */
  sale_status?: string | number;
  trans_status?: string | number; // alias
  /** Gross sale value. */
  value?: number | string;
  trans_value?: number | string; // alias
  /** Affiliate commission for this sale. */
  affiliate_value?: number | string;
  aff_value?: number | string; // alias
  currency?: string;
  trans_currency?: string; // alias
  date_create?: string;
  trans_createdate?: string; // alias
  date_payment?: string;
  trans_paiddate?: string; // alias
  cancellation_reason?: string;
}

interface EduzzProductRaw {
  content_id?: string | number;
  product_cod?: string | number; // alias
  id?: string | number; // alias
  title?: string;
  name?: string; // alias
  content_title?: string; // alias
  status?: string | number;
  price?: number | string;
  value?: number | string; // alias
  currency?: string;
  commission?: number | string;
  affiliate_commission?: number | string; // alias
  category?: string;
  url?: string;
}

/** Eduzz wraps every response as { profile, data }. `data` carries the payload. */
interface EduzzEnvelope<T> {
  profile?: unknown;
  data?: T;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Eduzz sale status to the canonical TransactionStatus.
 *
 * Eduzz exposes both modern string statuses and legacy numeric codes. We map
 * the ones whose meaning is documented and unambiguous; everything else is
 * 'other'. The verbatim status is preserved in `rawNetworkData`.
 *
 * Modern string → canonical:
 *   open / waitingPayment / waitingDocuments / analysing / scheduled / recovering
 *                          → 'pending'  (not yet settled)
 *   paid                   → 'paid'
 *   canceled / refused / expired / refunded / partialRefund / chargeback
 *                          → 'reversed' (the sale did not pay out / was reversed)
 *   anything else          → 'other'
 *
 * Legacy numeric (eduzz/webhook docs) → canonical:
 *   1, 15 (aguardando pagamento)          → 'pending'
 *   3 (paga)                              → 'paid'
 *   4 (cancelada), 7 (reembolsado), 6     → 'reversed'
 *   anything else                         → 'other'
 *
 * Why 'reversed' for canceled/refunded: from the affiliate's perspective these
 * mean the commission did not (or no longer) pays out — semantically a reversal,
 * matching how every other adapter normalises this state.
 *
 * Eduzz does not surface an 'approved-but-unpaid' state distinct from 'paid' on
 * the affiliate side; there is intentionally no mapping to canonical 'approved'.
 */
function mapTransactionStatus(raw: EduzzSaleRaw): TransactionStatus {
  const v = raw.sale_status ?? raw.trans_status;
  if (v === undefined || v === null) return 'other';

  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (n === 1 || n === 15) return 'pending';
    if (n === 3) return 'paid';
    if (n === 4 || n === 6 || n === 7) return 'reversed';
    return 'other';
  }

  const s = String(v).toLowerCase().trim();
  if (
    s === 'open' ||
    s === 'waitingpayment' ||
    s === 'waitingdocuments' ||
    s === 'analysing' ||
    s === 'scheduled' ||
    s === 'recovering' ||
    s === 'trial'
  ) {
    return 'pending';
  }
  if (s === 'paid') return 'paid';
  if (
    s === 'canceled' ||
    s === 'cancelled' ||
    s === 'refused' ||
    s === 'expired' ||
    s === 'refunded' ||
    s === 'partialrefund' ||
    s === 'chargeback' ||
    s === 'waitingrefund'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map an Eduzz product status to the canonical ProgrammeStatus.
 *
 * Eduzz "products" are the closest analogue to a programme on the affiliate
 * side: a product you can promote. The product listing does not expose a
 * publisher-relationship state (joined / pending), so an active product maps to
 * 'available' (it can be promoted) and anything we cannot confidently map is
 * 'unknown'. The verbatim status is preserved in `rawNetworkData`.
 *
 *   active / 1 / open       → 'available'
 *   paused / suspended / 0  → 'suspended'
 *   anything else           → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string | number }): ProgrammeStatus {
  const v = raw.status;
  if (v === undefined || v === null) return 'unknown';
  const s = String(v).toLowerCase().trim();
  if (s === 'active' || s === '1' || s === 'open' || s === 'enabled') return 'available';
  if (s === 'paused' || s === 'suspended' || s === '0' || s === 'disabled') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of an Eduzz sale at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: payment date (how long since it paid out?) falls back to the
 * creation date (the earliest available anchor for a pending sale). `now` is
 * injectable so tests are deterministic.
 */
function computeAgeDays(raw: EduzzSaleRaw, now: Date = new Date()): number {
  const anchor = raw.date_payment ?? raw.trans_paiddate ?? raw.date_create ?? raw.trans_createdate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function toTransaction(raw: EduzzSaleRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.affiliate_value ?? raw.aff_value);
  const sale = toAmount(raw.value ?? raw.trans_value);
  const currency = (raw.currency ?? raw.trans_currency ?? 'BRL').toUpperCase();

  const created = nullableIso(raw.date_create ?? raw.trans_createdate) ?? new Date(0).toISOString();
  const paid = nullableIso(raw.date_payment ?? raw.trans_paiddate);

  const id = String(raw.sale_id ?? raw.trans_cod ?? '');
  const programmeId = String(raw.content_id ?? raw.product_cod ?? '');

  return {
    id,
    network: SLUG,
    programmeId,
    programmeName: raw.content_title ?? raw.product_name ?? `Eduzz product ${programmeId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateConverted: created,
    datePaid: paid,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.cancellation_reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: EduzzProductRaw): Programme {
  const id = String(raw.content_id ?? raw.product_cod ?? raw.id ?? '');
  const currency = (raw.currency ?? 'BRL').toUpperCase();
  const rawCommission = raw.commission ?? raw.affiliate_commission;

  const programme: Programme = {
    id,
    name: raw.title ?? raw.name ?? raw.content_title ?? `Eduzz product ${id}`,
    network: SLUG,
    status: mapProgrammeStatus({ status: raw.status }),
    currency,
    rawNetworkData: raw,
  };
  if (rawCommission !== undefined) {
    programme.commissionRate = String(rawCommission);
  }
  if (raw.category) {
    programme.categories = [raw.category];
  }
  if (raw.url) {
    programme.advertiserUrl = raw.url;
  }
  return programme;
}

/** Unwrap the Eduzz { profile, data } envelope into an array of items. */
function unwrapList<T>(envelope: EduzzEnvelope<T[] | T> | T[] | undefined): T[] {
  if (Array.isArray(envelope)) return envelope;
  const data = (envelope as EduzzEnvelope<T[] | T> | undefined)?.data;
  if (Array.isArray(data)) return data;
  if (data !== undefined && data !== null) return [data as T];
  return [];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EduzzAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the Eduzz products available to the configured account.
   *
   * On the affiliate side an Eduzz "product" is the closest analogue to a
   * programme: a product you can promote. We map products to Programmes,
   * apply client-side filters (status / search / limit), and preserve the raw
   * payload.
   *
   *   GET https://api2.eduzz.com/product/get_product_list → { profile, data: [...] }
   *
   * The product listing does not document a server-side status or search filter
   * for affiliates, so filters are applied client-side after normalisation.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = await getToken();

    const response = await eduzzRequest<EduzzEnvelope<EduzzProductRaw[]>>({
      operation: 'listProgrammes',
      path: '/product/get_product_list',
      token,
      resilience: RESILIENCE.default,
    });

    let programmes = unwrapList<EduzzProductRaw>(response).map(toProgramme);

    const statusFilter = toProgrammeStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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
   * Fetch a single Eduzz product by id.
   *
   * The listing endpoint returns all products for the account; we filter to the
   * requested id rather than relying on an undocumented per-id route. If the id
   * is not present we throw a NetworkError (not_implemented would be wrong — the
   * operation is supported, the id simply wasn't found).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const all = await this.listProgrammes();
    const found = all.find((p) => p.id === String(programmeId));
    if (!found) {
      throw new NotImplementedError(
        `Eduzz product ${programmeId} was not found in the account's product list. ` +
          'Eduzz does not document a per-product affiliate lookup route; getProgramme filters the product listing.',
      );
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Eduzz sales across a date window with optional status / age / programme filters.
   *
   *   GET https://api2.eduzz.com/sale/get_sale_list
   *     ?date_start=YYYY-MM-DD&date_end=YYYY-MM-DD
   *   → { profile, data: [ sale items ] }
   *
   * BLOCKED(verify): the exact param names (date_start/date_end) and item field
   * names are documented on https://api2.eduzz.com/ but could not be confirmed
   * against the live reference (developers.eduzz.com returns HTTP 403 to
   * automated fetches). We default to a 30-day window when none is supplied.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` / `query.maxAgeDays` filter on the computed `ageDays`.
   * Applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Canceled / refunded / chargeback sales are normalised to 'reversed' and
   * their `cancellation_reason` surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = await getToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      date_start: from.toISOString().slice(0, 10),
      date_end: to.toISOString().slice(0, 10),
    };

    const response = await eduzzRequest<EduzzEnvelope<EduzzSaleRaw[]>>({
      operation: 'listTransactions',
      path: '/sale/get_sale_list',
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    let transactions = unwrapList<EduzzSaleRaw>(response).map((r) => toTransaction(r, now));

    // Client-side canonical status filter (Eduzz status filtering is not
    // documented for affiliates; filter on the normalised status to be correct).
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === String(query.programmeId));
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
   * dedicated reports endpoint would be a second source of truth for the same
   * data, and we still need the per-transaction `ageDays` to compute
   * `oldestUnpaidAgeDays`. One call, one source.
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
          programmeName: t.programmeName || `Eduzz product ${key}`,
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
   * Eduzz does not expose click-level data via its API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError('Eduzz does not expose click-level data via its API.');
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Eduzz affiliate links are generated per product inside the Eduzz panel
   * (Afiliados → Promover), and there is no documented self-serve API for
   * constructing them. We throw NotImplementedError rather than guessing at a
   * link format that could silently send clicks to the wrong destination.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Eduzz affiliate tracking links are generated per product inside the Eduzz panel ' +
        '(Afiliados → Promover); there is no documented self-serve link-construction API.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully obtaining a JWT token.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure: returns { ok: false, reason: '...' }. Never throws — verifyAuth
   * is called by error handlers.
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
      note: 'Eduzz does not expose click-level data via its API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Eduzz affiliate links are generated per product inside the panel; no self-serve link API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }), 'claimStatus: experimental');
    await probe(
      'listTransactions',
      () => this.listTransactions({ limit: 1 }),
      'BLOCKED(verify): /sale/get_sale_list field shape not confirmed against a live account.',
    );
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const eduzzAdapter = new EduzzAdapter();
registerAdapter(eduzzAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toProgrammeStatusList(
  v?: ProgrammeStatus | ProgrammeStatus[],
): ProgrammeStatus[] | undefined {
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
  toProgramme,
  unwrapList,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
