/**
 * Indoleads adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and mirrors `src/networks/skimlinks/adapter.ts` closely. Read those
 * for the deep reasoning behind the structure. The load-bearing decisions
 * replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Indoleads API map ---------------------------------------------------------
 *
 * Base route: https://app.indoleads.com/api
 *   Auth: a single self-issued token (Account → API Settings), sent either as
 *   `Authorization: Bearer {token}` or as a `?token=` GET parameter. We use the
 *   header. Source: https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API
 *
 * Offers (CONFIRMED verbatim path):
 *   GET /api/offers
 *     Filters: type, category, status, geo, keyword.
 *     Pass `source_id` to include tracking links in the response.
 *     Confirmed curl example:
 *       curl -H 'Accept: application/json' -H "Authorization: Bearer ${TOKEN}" \
 *            https://app.indoleads.com/api/offers
 *   → maps to listProgrammes / getProgramme.
 *
 * Conversions report (endpoint documented; exact path/fields UNVERIFIED):
 *   GET /api/conversions   ← BLOCKED(verify): confirm path + payload shape.
 *     Documented as a self-serve "Get conversions report" endpoint. The public
 *     snippets do not pin down the response field names, so the transformer reads
 *     several plausible names defensively and preserves the raw payload.
 *   → maps to listTransactions / getEarningsSummary.
 *
 * Tracking link ("Get or create a tracking link"; offers carry links when
 * source_id is supplied):
 *   GET /api/offers?ids={offerId}&source_id={sourceId}   ← BLOCKED(verify)
 *   → maps to generateTrackingLink (real API call).
 *
 * Clicks: not exposed via the public publisher API → listClicks throws
 *   NotImplementedError.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `indoleadsRequest`.
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

import { indoleadsRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { requireCredential } from '../../shared/config.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CommissionRateStructured,
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

const log = createLogger('indoleads.adapter');

const SLUG = 'indoleads';
const NAME = 'Indoleads';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://app.indoleads.com/api',
  authModel: 'bearer',
  docsUrl: 'https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The exact conversions-report endpoint path and its response field names could not be confirmed from the public documentation snippets (the full Confluence API page is access-gated); the adapter targets GET /api/conversions and reads field names defensively. BLOCKED(verify): confirm the path and payload shape against a live account.',
    'listClicks is not exposed via the public Indoleads publisher API; the operation throws NotImplementedError.',
    'getProgramme has no single-offer endpoint documented publicly; it is derived by filtering the GET /api/offers listing client-side.',
    'The Indoleads API token can be supplied either as an Authorization: Bearer header or as a ?token= GET parameter; this adapter uses the Authorization header.',
    'Maximum date window per conversions-report call is not publicly documented; a live account test is required to confirm no server-side cap exists.',
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
// Indoleads raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal and defensive: the public documentation snippets do
// not pin down every field name, and the conversions payload shape is unverified
// against a live account. Treating every field as possibly absent and preserving
// the original under `rawNetworkData` keeps the adapter robust to upstream drift.

interface IndoleadsConversionRaw {
  // BLOCKED(verify): field names are best-effort guesses based on common
  // affiliate-API conventions and the documented postback macros (status values:
  // pending | declined | approved | overaged; plus reversed/canceled). The
  // adapter reads several plausible names for each concept. Live verification is
  // required before bumping claim_status to 'partial'.
  id?: string | number;
  conversion_id?: string | number;
  transaction_id?: string | number;
  status?: string;
  payout?: number | string; // commission to the publisher
  commission?: number | string; // synonym
  amount?: number | string; // gross sale amount
  sale_amount?: number | string; // synonym
  currency?: string;
  offer_id?: string | number;
  offer_name?: string;
  offer?: string;
  click_date?: string;
  click_time?: string;
  conversion_date?: string;
  created_at?: string;
  date?: string;
  approved_date?: string;
  approved_at?: string;
  paid_date?: string;
  paid_at?: string;
  decline_reason?: string;
  reason?: string;
}

interface IndoleadsConversionsResponse {
  // Indoleads list responses are commonly wrapped in `data` with `meta`/`links`
  // (Laravel-style pagination). We read `data` first, then fall back to a
  // top-level `conversions` array, then to the raw array itself.
  data?: IndoleadsConversionRaw[];
  conversions?: IndoleadsConversionRaw[];
}

interface IndoleadsOfferRaw {
  id?: string | number;
  offer_id?: string | number;
  name?: string;
  title?: string;
  status?: string;
  currency?: string;
  payout?: number | string;
  commission?: string;
  commission_rate?: string;
  payout_type?: string; // e.g. 'percent' | 'fixed'
  category?: string | string[];
  categories?: string[];
  geo?: string | string[];
  countries?: string[];
  preview_url?: string;
  url?: string;
  tracking_link?: string;
  tracking_url?: string;
}

interface IndoleadsOffersResponse {
  data?: IndoleadsOfferRaw[];
  offers?: IndoleadsOfferRaw[];
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Indoleads conversion status string to the canonical TransactionStatus.
 *
 * Indoleads status → canonical (status vocabulary confirmed from the public
 * postback documentation: pending | declined | approved | overaged, plus
 * reversed/canceled observed in the dashboard):
 *   pending                       → 'pending'  (awaiting validation)
 *   approved / confirmed          → 'approved' (validated, not yet paid out)
 *   paid / settled                → 'paid'     (included in a payment)
 *   declined / rejected / reversed
 *     / canceled / cancelled      → 'reversed' (did not pay out)
 *   overaged                      → 'other'    (held past the validation window;
 *                                               not a clean pending/approved/
 *                                               reversed state — keep verbatim)
 *   anything else                 → 'other'
 *
 * Why 'declined' → 'reversed': from the publisher's perspective a declined
 * conversion did not pay out — semantically a reversal, which is what every
 * other network calls this state. The verbatim status is preserved in
 * `rawNetworkData`.
 *
 * Why 'overaged' → 'other': "overaged" means the conversion sat past its
 * validation window without resolving. It is neither a clean pending nor a
 * confirmed reversal, so mapping it to a wrong guess would mislead earnings
 * roll-ups. 'other' keeps it visible without inventing a verdict.
 */
function mapTransactionStatus(raw: IndoleadsConversionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'pending') return 'pending';
  if (s === 'approved' || s === 'confirmed') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (
    s === 'declined' ||
    s === 'rejected' ||
    s === 'reversed' ||
    s === 'canceled' ||
    s === 'cancelled'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map an Indoleads offer status to the canonical ProgrammeStatus.
 *
 * Indoleads offer access is governed by an approval model: the offers endpoint
 * returns a status indicating whether the publisher can run the offer
 * ("allow") or must request approval ("need approval"). We default to
 * 'unknown' for any value we cannot confidently map.
 *
 *   allow / active / approved / joined → 'joined'    (publisher can run it now)
 *   need approval / pending            → 'pending'   (approval required)
 *   declined / rejected                → 'declined'
 *   available / not joined             → 'available'
 *   paused / suspended / stopped       → 'suspended'
 *   anything else                      → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'allow' || s === 'active' || s === 'approved' || s === 'joined') return 'joined';
  if (s === 'need approval' || s === 'need_approval' || s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'not joined' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'stopped') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of an Indoleads conversion at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: approved date (how long has this been approved-but-not-paid?)
 * falls back to the conversion date, then the click date. For pending
 * conversions, the conversion date is the earliest reliable anchor.
 */
function computeAgeDays(raw: IndoleadsConversionRaw, now: Date = new Date()): number {
  const anchor =
    raw.approved_date ??
    raw.approved_at ??
    raw.conversion_date ??
    raw.created_at ??
    raw.date ??
    raw.click_date ??
    raw.click_time;
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

function toTransaction(raw: IndoleadsConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.payout ?? raw.commission);
  const sale = toAmount(raw.amount ?? raw.sale_amount);
  const currency = (raw.currency ?? 'USD').toUpperCase();

  const conversionDate =
    nullableIso(raw.conversion_date ?? raw.created_at ?? raw.date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date ?? raw.click_time);
  const approvedDate = nullableIso(raw.approved_date ?? raw.approved_at);
  const paidDate = nullableIso(raw.paid_date ?? raw.paid_at);

  const id = String(raw.id ?? raw.conversion_id ?? raw.transaction_id ?? '');
  const programmeId = String(raw.offer_id ?? '');

  return {
    id,
    network: SLUG,
    programmeId,
    programmeName: raw.offer_name ?? raw.offer ?? `Indoleads offer ${programmeId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: conversionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.decline_reason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toCommissionRate(raw: IndoleadsOfferRaw): string | CommissionRateStructured | undefined {
  // Prefer a structured rate when the payout type is known; otherwise return the
  // raw commission string verbatim. Never invent a value.
  const text = raw.commission ?? raw.commission_rate;
  const payoutType = (raw.payout_type ?? '').toLowerCase().trim();
  const numeric = raw.payout !== undefined ? toAmount(raw.payout) : undefined;

  if (payoutType === 'percent' || payoutType === 'percentage') {
    const structured: CommissionRateStructured = { type: 'percent' };
    if (numeric !== undefined) structured.value = numeric;
    if (raw.currency) structured.currency = raw.currency;
    if (text) structured.description = text;
    return structured;
  }
  if (payoutType === 'fixed' || payoutType === 'flat' || payoutType === 'cpa') {
    const structured: CommissionRateStructured = { type: 'flat' };
    if (numeric !== undefined) structured.value = numeric;
    if (raw.currency) structured.currency = raw.currency;
    if (text) structured.description = text;
    return structured;
  }
  return text ?? undefined;
}

function toCategories(raw: IndoleadsOfferRaw): string[] | undefined {
  if (Array.isArray(raw.categories) && raw.categories.length > 0) return raw.categories;
  if (Array.isArray(raw.category)) return raw.category;
  if (typeof raw.category === 'string' && raw.category.trim() !== '') return [raw.category];
  return undefined;
}

function toProgramme(raw: IndoleadsOfferRaw): Programme {
  const id = String(raw.id ?? raw.offer_id ?? '');
  const categories = toCategories(raw);
  const commissionRate = toCommissionRate(raw);
  const programme: Programme = {
    id,
    name: raw.name ?? raw.title ?? `Indoleads offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency;
  if (commissionRate !== undefined) programme.commissionRate = commissionRate;
  if (categories) programme.categories = categories;
  const advertiserUrl = raw.preview_url ?? raw.url;
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  return programme;
}

function geoMatches(raw: IndoleadsOfferRaw, geo: string): boolean {
  const wanted = geo.toLowerCase().trim();
  const pool: string[] = [];
  if (Array.isArray(raw.geo)) pool.push(...raw.geo);
  else if (typeof raw.geo === 'string') pool.push(raw.geo);
  if (Array.isArray(raw.countries)) pool.push(...raw.countries);
  return pool.some((g) => String(g).toLowerCase().trim() === wanted);
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireToken(operation: string): string {
  return requireCredential('INDOLEADS_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set INDOLEADS_API_TOKEN in ~/.affiliate-mcp/.env. ' +
      'Generate a token at https://app.indoleads.com → Account → API Settings.',
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class IndoleadsAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Indoleads offers as programmes.
   *
   * Endpoint (CONFIRMED verbatim path):
   *   GET /api/offers
   *     Filters: type, category, status, geo, keyword.
   *
   * The `search`, `categories`, and `status` query fields map onto the
   * documented `keyword`, `category`, and `status` filters. Geo filtering is not
   * a field on ProgrammeQuery, so it is not applied here; geo can be passed
   * through `search` if needed. Status filtering is also re-applied client-side
   * after normalisation so canonical statuses with no single upstream equivalent
   * still behave correctly.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');

    const params: Record<string, string | number | undefined> = {};
    if (query?.search) params['keyword'] = query.search;
    if (query?.categories && query.categories.length > 0) {
      params['category'] = query.categories.join(',');
    }
    const statusFilter = toProgrammeStatusList(query?.status);
    const singleUpstream = mapCanonicalToIndoleadsOfferStatus(statusFilter);
    if (singleUpstream) params['status'] = singleUpstream;
    if (typeof query?.limit === 'number') params['limit'] = query.limit;

    const response = await indoleadsRequest<IndoleadsOffersResponse>({
      operation: 'listProgrammes',
      path: '/offers',
      token,
      query: params,
      resilience: RESILIENCE.default,
    });

    const rawOffers = extractOffers(response);
    let programmes = rawOffers.map((r) => toProgramme(r));

    // Re-apply canonical status filter client-side after normalisation.
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
   * Fetch a single offer by id.
   *
   * Indoleads does not publicly document a single-offer endpoint, so we derive
   * the result by filtering the offers listing client-side. We throw a clear
   * config_error (not an empty/invented object) when the offer is not found.
   *
   * BLOCKED(verify): if a live account exposes GET /api/offers/{id}, switch to
   * that for efficiency.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the Indoleads offer id.',
        }),
      );
    }
    const token = requireToken('getProgramme');

    const response = await indoleadsRequest<IndoleadsOffersResponse>({
      operation: 'getProgramme',
      path: '/offers',
      token,
      query: { ids: programmeId },
      resilience: RESILIENCE.default,
    });

    const rawOffers = extractOffers(response);
    const match = rawOffers
      .map((r) => toProgramme(r))
      .find((p) => p.id === String(programmeId));

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Indoleads offer ${programmeId} was not found in the offers listing.`,
          hint: 'Check the offer id is correct and that your account has access to it.',
        }),
      );
    }

    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Indoleads conversions across a date window with optional status / age /
   * programme filters.
   *
   * Endpoint (path + payload BLOCKED(verify); see META.knownLimitations):
   *   GET /api/conversions
   *     ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
   *     [&status=...][&offer_id=...][&limit=N]
   *
   * The public snippets confirm a self-serve "Get conversions report" endpoint
   * exists but do not pin down the path or field names. We default to a 30-day
   * window when none is specified and read response fields defensively.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` returns ONLY transactions whose computed `ageDays` is
   * >= the threshold. Applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Declined / canceled / reversed conversions are normalised to 'reversed' and
   * their reason surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    };

    const statusFilter = toTransactionStatusList(query?.status);
    const singleStatusUpstream = mapCanonicalToIndoleadsStatus(statusFilter);
    if (singleStatusUpstream) params['status'] = singleStatusUpstream;

    if (query?.programmeId) params['offer_id'] = query.programmeId;

    const response = await indoleadsRequest<IndoleadsConversionsResponse>({
      operation: 'listTransactions',
      path: '/conversions',
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawConversions = extractConversions(response);
    let transactions = rawConversions.map((r) => toTransaction(r, now));

    // Client-side canonical status filter — always applied when a status filter
    // was requested, even when a server-side filter was also sent. The upstream
    // status names ('declined') normalise to canonical names ('reversed'), so
    // filtering on the normalised status after transformation is always correct.
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (same reasoning as Awin/Skimlinks): a
   * dedicated report endpoint would be a second source of truth for the same
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
          programmeName: t.programmeName || `Indoleads offer ${key}`,
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
   * Indoleads does not expose click-level data via the public publisher API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Indoleads does not expose click-level data via the public publisher API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Generate an Indoleads tracking link for an offer (real API call).
   *
   * Indoleads' offers endpoint returns a tracking link for an offer when a
   * `source_id` is supplied (documented behaviour). There is no deterministic,
   * client-constructable link format published, so we call the API and read the
   * tracking link from the offer payload.
   *
   *   GET /api/offers?ids={offerId}&source_id={sourceId}
   *     → offer object carrying a `tracking_link` / `tracking_url` field.
   *
   * BLOCKED(verify): the exact query parameter names (`ids`, `source_id`) and the
   * tracking-link field name are best-effort from the public docs; confirm
   * against a live account.
   *
   * The `destinationUrl` is appended to the tracking link as a deep-link target
   * when supplied. Indoleads tracking links resolve the merchant from the offer,
   * so the destination is optional from the network's perspective; we keep it on
   * the returned object for the caller's reference and pass it through as a query
   * parameter when present.
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
          message: 'programmeId is required.',
          hint: 'Pass the Indoleads offer id to generate a tracking link for.',
        }),
      );
    }

    const token = requireToken('generateTrackingLink');

    const response = await indoleadsRequest<IndoleadsOffersResponse>({
      operation: 'generateTrackingLink',
      path: '/offers',
      token,
      query: { ids: input.programmeId, source_id: 1 },
      resilience: RESILIENCE.default,
    });

    const rawOffers = extractOffers(response);
    const offer = rawOffers.find(
      (o) => String(o.id ?? o.offer_id ?? '') === String(input.programmeId),
    );

    const baseTracking = offer?.tracking_link ?? offer?.tracking_url;
    if (!offer || !baseTracking) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Indoleads did not return a tracking link for offer ${input.programmeId}.`,
          hint: 'Confirm the offer id is correct and that your account is approved to run it.',
        }),
      );
    }

    // Append the destination as a deep-link target when supplied. We use the
    // common `url` parameter; the exact deep-link parameter name is unverified.
    let trackingUrl = baseTracking;
    if (input.destinationUrl) {
      const sep = baseTracking.includes('?') ? '&' : '?';
      trackingUrl = `${baseTracking}${sep}url=${encodeURIComponent(input.destinationUrl)}`;
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: offer,
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials via a cheap one-row offers call.
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
   * listClicks is known-unsupported and recorded without probing.
   * generateTrackingLink and getProgramme require a real offer id, so they are
   * recorded as supported-but-not-probed (probing them blind would require an
   * id we do not have).
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

    // Known-unsupported op — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Indoleads does not expose click-level data via the public publisher API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }), 'GET /api/offers');
    await probe(
      'listTransactions',
      () => this.listTransactions({ limit: 1 }),
      'GET /api/conversions (path/fields BLOCKED(verify))',
    );
    await probe(
      'getEarningsSummary',
      () => this.getEarningsSummary({ limit: 1 }),
      'Derived from listTransactions.',
    );

    // getProgramme and generateTrackingLink need a real offer id; record as
    // experimental-but-supported without a blind probe.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Derived by filtering GET /api/offers client-side; needs a real offer id to probe.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Real API call to GET /api/offers with source_id; needs a real offer id to probe. Query/field names BLOCKED(verify).',
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
// Registration
// ---------------------------------------------------------------------------

export const indoleadsAdapter = new IndoleadsAdapter();
registerAdapter(indoleadsAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function extractConversions(response: IndoleadsConversionsResponse): IndoleadsConversionRaw[] {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.conversions)) return response.conversions;
  if (Array.isArray(response)) return response as IndoleadsConversionRaw[];
  return [];
}

function extractOffers(response: IndoleadsOffersResponse): IndoleadsOfferRaw[] {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.offers)) return response.offers;
  if (Array.isArray(response)) return response as IndoleadsOfferRaw[];
  return [];
}

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

/**
 * Map a set of canonical TransactionStatus values to a single Indoleads API
 * status parameter. Returns undefined if the set requires client-side filtering
 * (multiple statuses, or statuses with no single upstream equivalent).
 *
 * Canonical → Indoleads API:
 *   pending   → 'pending'
 *   approved  → 'approved'
 *   reversed  → 'declined'
 *   paid      → 'paid'
 *   other     → (no mapping; filter client-side)
 */
function mapCanonicalToIndoleadsStatus(statuses?: TransactionStatus[]): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'reversed':
      return 'declined';
    case 'paid':
      return 'paid';
    default:
      return undefined;
  }
}

/**
 * Map a set of canonical ProgrammeStatus values to a single Indoleads offer
 * status filter. Returns undefined when client-side filtering is required.
 *
 * Canonical → Indoleads offer status:
 *   joined    → 'allow'
 *   pending   → 'need approval'
 *   others    → (no clean single-value mapping; filter client-side)
 */
function mapCanonicalToIndoleadsOfferStatus(statuses?: ProgrammeStatus[]): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'joined':
      return 'allow';
    case 'pending':
      return 'need approval';
    default:
      return undefined;
  }
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
  toCommissionRate,
  geoMatches,
  mapCanonicalToIndoleadsStatus,
  mapCanonicalToIndoleadsOfferStatus,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
