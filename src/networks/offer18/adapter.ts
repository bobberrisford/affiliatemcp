/**
 * Offer18 adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and `src/networks/everflow/adapter.ts`. Read those (and their header comments)
 * before modifying this one.
 *
 * --- What makes Offer18 different -------------------------------------------
 *
 * Offer18 is a tenant network engine: ONE parameterised API powers every
 * Offer18-hosted network. There is no fixed base URL. The base is the per-tenant
 * instance host, read from the OFFER18_BASE_URL credential (validated as a URL in
 * client.ts). This is the "multiplier" base-URL pattern — the same adapter
 * addresses any Offer18 instance.
 *
 * Auth is custom: affiliate endpoints (`/api/af/...`) carry three query
 * parameters on every call — `key` (API key), `aid` (affiliate id), `mid`
 * (network/advertiser MID). See auth.ts for how OFFER18_* env vars map to them.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Docs: https://knowledgebase.offer18.com/affiliate/affiliate-apis
 *
 *   GET  {base}/api/af/offers
 *     ?key=..&aid=..&mid=.. [&offer_id=..&page=..&category=..&model=..&country=..
 *      &offer_status=1&authorized=1]
 *     → list of offers (programmes) visible to this affiliate.
 *   GET  {base}/api/af/offers?...&offer_id={id}
 *     → single offer (filter the list by offer_id).
 *   GET  {base}/api/af/report
 *     ?key=..&aid=..&mid=.. [&date_from=YYYY-MM-DD&date_end=YYYY-MM-DD
 *      &datetime_from=..&datetime_end=..&page=..&results=..&timezone=0.0&offer=..]
 *     → conversion/performance report rows.
 *   GET  {base}/api/af/coupon?...&offer_id={id}&status=approved
 *     → coupon codes (NOTE ONLY — not surfaced by any canonical operation).
 *
 * --- Cardinal rules (see Awin/Everflow headers for full rationale) ----------
 *
 *   1. NEVER call `fetch` directly. Use `offer18Request` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. The user-visible noun is "programme" not "program".
 *
 * --- Amount-unit assumption -------------------------------------------------
 *
 * Offer18 report rows expose `affiliate_price` (the affiliate's payout) and
 * `advertiser_price` as plain decimal numbers with a separate `currency` string.
 * The docs give no minor-unit indication, so we treat all amounts as MAJOR
 * currency units (e.g. 5.00 = five units of `currency`). This is recorded in
 * known_limitations and must be confirmed against a live tenant.
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live account.
 *   - Per-tenant base URL: there is no fixed host. OFFER18_BASE_URL must point
 *     at your Offer18 instance API host.
 *   - Amount unit assumed to be major currency units; not confirmed live.
 *   - Click-level data is not exposed as a distinct affiliate endpoint;
 *     listClicks is unsupported.
 *   - Tracking links are not deterministically constructible from the affiliate
 *     API (the per-affiliate click domain is not returned); generateTrackingLink
 *     is unsupported.
 */

import { offer18Request, requireBaseUrl } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireAuthParams } from './auth.js';
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

const log = createLogger('offer18.adapter');

const SLUG = 'offer18';
const NAME = 'Offer18';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Placeholder: the real base is the per-tenant instance host supplied via
  // OFFER18_BASE_URL. This value is informational only; client.ts never uses it.
  baseUrl: 'https://api.offer18.com',
  // Custom: key + secret + mid as query parameters is non-standard (not Bearer).
  authModel: 'custom',
  docsUrl: 'https://knowledgebase.offer18.com/affiliate/affiliate-apis',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: built from public docs; not verified against a live tenant.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Offer18 is a tenant network engine: there is no fixed base URL. The real base is the per-tenant instance host supplied via OFFER18_BASE_URL.',
    'Amount unit assumed to be major currency units (e.g. 5.00 = five units of the reported currency); not confirmed against a live tenant.',
    'Click-level data is not exposed as a distinct affiliate endpoint; listClicks is unsupported.',
    'Tracking links are not deterministically constructible from the affiliate API; generateTrackingLink is unsupported.',
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
 * The report endpoint can be slow over wide date windows. Give it (and the
 * earnings summary derived from it) a 60s timeout and 3 retries, matching the
 * pattern in Awin/Everflow.
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
// Offer18 raw response shapes (deliberately minimal — see Awin for rationale)
// ---------------------------------------------------------------------------

/** Minimal shape of one offer record from GET /api/af/offers */
interface Offer18OfferRaw {
  // Offer18 uses `offerid` (no underscore) in the offers response.
  offerid?: number | string;
  name?: string;
  logo?: string;
  // Offer status string, e.g. "active" / "paused" / "pending".
  status?: string;
  // Comma-joined or array of categories depending on tenant; read defensively.
  category?: string;
  currency?: string;
  // Payout amount for the offer. Plain decimal; unit assumed major (see header).
  price?: number | string;
  // Commission model, e.g. "CPA", "CPC", "CPL", "CPS".
  model?: string;
  date_start?: string;
  date_end?: string;
  preview_url?: string;
  offer_terms?: string;
  // Whether this affiliate is authorised/assigned to the offer (1 = assigned).
  authorized?: number | string;
}

/** Envelope from GET /api/af/offers. Offer18 wraps rows under `data`. */
interface Offer18OffersEnvelope {
  status?: number | string;
  // Tenants vary: some return `data`, some `offers`. Read both.
  data?: Offer18OfferRaw[];
  offers?: Offer18OfferRaw[];
  page?: number;
  results?: number;
  total?: number;
}

/** Minimal shape of one report row from GET /api/af/report */
interface Offer18ReportRaw {
  // Transaction / row id fields seen across tenants.
  tid?: string;
  i_id?: string;
  offer?: number | string;
  offer_name?: string;
  // Conversion count for an aggregated row; 1 for a single-conversion row.
  conversion?: number | string;
  clicks?: number | string;
  // Affiliate payout for the row. Plain decimal; unit assumed major.
  affiliate_price?: number | string;
  advertiser_price?: number | string;
  currency?: string;
  // Date / time of the row.
  date?: string;
  time?: string;
  hour?: string;
  // Conversion status. Offer18 typically uses "approved" / "pending" /
  // "rejected"; `status_type` carries a finer-grained label on some tenants.
  status?: string;
  status_type?: string;
  // Reversal / rejection context, where present.
  filter_log?: string;
}

/** Envelope from GET /api/af/report. Rows wrapped under `data` on most tenants. */
interface Offer18ReportEnvelope {
  status?: number | string;
  data?: Offer18ReportRaw[];
  report?: Offer18ReportRaw[];
  page?: number;
  results?: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Status normalisation: Offer18 offer status → canonical ProgrammeStatus.
 *
 * Offer18's affiliate offers carry a free-text `status` plus an `authorized`
 * flag (1 = the affiliate is assigned/approved for the offer). We prefer the
 * authorisation flag to decide the affiliate's relationship, then fall back to
 * the offer's own status string.
 *
 *   authorized = 1                     → 'joined'   (assigned to this affiliate)
 *   status active / running / live     → 'available'
 *   status paused / stopped / inactive → 'suspended'
 *   status pending / review            → 'pending'
 *   status rejected / declined         → 'declined'
 *   anything else                      → 'unknown'
 */
function mapProgrammeStatus(raw: Offer18OfferRaw): ProgrammeStatus {
  const authorised = toNumber(raw.authorized) === 1 || String(raw.authorized) === '1';
  if (authorised) return 'joined';

  const s = (raw.status ?? '').toLowerCase();
  if (s === 'active' || s === 'running' || s === 'live') return 'available';
  if (s === 'paused' || s === 'stopped' || s === 'inactive' || s === 'disabled') return 'suspended';
  if (s === 'pending' || s === 'review' || s === 'in_review') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'denied') return 'declined';
  return 'unknown';
}

/**
 * Status normalisation: Offer18 report status → canonical TransactionStatus.
 *
 * Offer18 conversion statuses observed in the affiliate report:
 *   approved / confirmed / paid → see below
 *   pending / hold / pending_approval → 'pending'
 *   rejected / declined / cancelled / invalid → 'reversed'
 *   paid → 'paid'
 *   anything else → 'other'
 *
 * Note: `status_type` is preferred when present (finer-grained), falling back
 * to `status`. We never invent a status the tenant did not return.
 */
function mapTransactionStatus(raw: Offer18ReportRaw): TransactionStatus {
  const s = (raw.status_type ?? raw.status ?? '').toLowerCase();
  if (s === 'paid') return 'paid';
  if (s === 'approved' || s === 'confirmed' || s === 'completed') return 'approved';
  if (s === 'pending' || s === 'hold' || s === 'on_hold' || s === 'pending_approval') return 'pending';
  if (
    s === 'rejected' ||
    s === 'declined' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'reversed' ||
    s === 'invalid'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Build an ISO datetime from Offer18's separate `date` (+ optional `time`)
 * fields. Offer18 reports `date` as `YYYY-MM-DD` and `time` as `HH:mm:ss`.
 */
function rowToIso(raw: Offer18ReportRaw): string | undefined {
  if (!raw.date) return undefined;
  const candidate = raw.time ? `${raw.date}T${raw.time}Z` : `${raw.date}T00:00:00Z`;
  const t = Date.parse(candidate);
  if (Number.isNaN(t)) {
    const t2 = Date.parse(raw.date);
    return Number.isNaN(t2) ? undefined : new Date(t2).toISOString();
  }
  return new Date(t).toISOString();
}

/**
 * Compute the age in days of a report row relative to `now`, anchored on the
 * row's conversion date. PRD §15.9 — the unpaid-age affordance depends on this.
 */
function computeAgeDays(raw: Offer18ReportRaw, now: Date = new Date()): number {
  const iso = rowToIso(raw);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function splitCategories(raw: Offer18OfferRaw): string[] {
  if (!raw.category) return [];
  return raw.category
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: Offer18OfferRaw): Programme {
  const id = String(raw.offerid ?? '');
  const price = raw.price !== undefined ? toNumber(raw.price) : undefined;
  return {
    id,
    name: raw.name ?? `Offer18 offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? undefined,
    commissionRate:
      price !== undefined
        ? {
            // CPS is percentage-of-sale; everything else is a flat per-action payout.
            type: (raw.model ?? '').toUpperCase() === 'CPS' ? 'percent' : 'flat',
            value: price,
            currency: raw.currency,
            description: raw.model ? `${raw.model.toUpperCase()} ${price}` : String(price),
          }
        : undefined,
    categories: splitCategories(raw),
    advertiserUrl: raw.preview_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: Offer18ReportRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.affiliate_price);
  const sale = toNumber(raw.advertiser_price);
  const currency = raw.currency ?? 'USD';
  const offerId = String(raw.offer ?? '');
  const dateConverted = rowToIso(raw) ?? new Date(0).toISOString();

  return {
    id: String(raw.tid ?? raw.i_id ?? ''),
    network: SLUG,
    programmeId: offerId,
    programmeName: raw.offer_name ?? `Offer18 offer ${offerId}`,
    status,
    amount: sale,
    currency,
    commission,
    // Offer18's affiliate report does not expose a separate click date per row.
    dateClicked: undefined,
    dateConverted,
    // No documented approval-date field; use the conversion date for approved
    // rows as a best-effort proxy, leave undefined otherwise.
    dateApproved: status === 'approved' || status === 'paid' ? dateConverted : undefined,
    // No documented payment-date field on the affiliate report.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.filter_log ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** Format a Date as Offer18's `YYYY-MM-DD` date filter value (UTC). */
function formatOffer18Date(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function extractOffers(env: Offer18OffersEnvelope | Offer18OfferRaw[]): Offer18OfferRaw[] {
  if (Array.isArray(env)) return env;
  return env.data ?? env.offers ?? [];
}

function extractReportRows(env: Offer18ReportEnvelope | Offer18ReportRaw[]): Offer18ReportRaw[] {
  if (Array.isArray(env)) return env;
  return env.data ?? env.report ?? [];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class Offer18Adapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Offer18 offers (programmes) visible to this affiliate.
   *
   * Endpoint: GET /api/af/offers?key=..&aid=..&mid=..[&page=..&offer_status=1]
   *
   * We fetch the first page and apply client-side search/status/category/limit
   * filters for consistency with the other adapters. Offer18's `offer_status=1`
   * filters to active offers server-side; we leave filtering client-side so the
   * canonical ProgrammeStatus mapping is the single source of truth.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const baseUrl = requireBaseUrl('listProgrammes');
    const auth = requireAuthParams('listProgrammes');

    const env = await offer18Request<Offer18OffersEnvelope | Offer18OfferRaw[]>({
      operation: 'listProgrammes',
      baseUrl,
      path: '/api/af/offers',
      query: { key: auth.key, aid: auth.aid, mid: auth.mid, page: 1 },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = extractOffers(env).map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.advertiserUrl ?? '').toLowerCase().includes(needle),
      );
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
   * Fetch a single Offer18 offer by ID.
   *
   * Offer18 has no dedicated single-offer affiliate endpoint; we filter the
   * offers list by `offer_id`. The response is the same envelope; we take the
   * first matching row.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Offer18 offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_offer18_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const baseUrl = requireBaseUrl('getProgramme');
    const auth = requireAuthParams('getProgramme');

    const env = await offer18Request<Offer18OffersEnvelope | Offer18OfferRaw[]>({
      operation: 'getProgramme',
      baseUrl,
      path: '/api/af/offers',
      query: { key: auth.key, aid: auth.aid, mid: auth.mid, offer_id: programmeId },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const rows = extractOffers(env);
    const match = rows.find((r) => String(r.offerid ?? '') === programmeId) ?? rows[0];

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Offer18 returned no offer for id ${programmeId}.`,
          hint: 'Confirm the offer id with affiliate_offer18_list_programmes.',
        }),
      );
    }

    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions via the Offer18 affiliate report.
   *
   * Endpoint: GET /api/af/report
   *   ?key=..&aid=..&mid=..&date_from=YYYY-MM-DD&date_end=YYYY-MM-DD
   *    [&offer=..&page=..&results=..&timezone=0.0]
   *
   * Date window default: last 30 days. Offer18 paginates with `page` (zero-based)
   * + `results`; we request a generous `results` and the first page. The docs do
   * not state a maximum window per call, but we chunk wide ranges into 31-day
   * slices defensively to avoid tenant-specific caps and keep payloads bounded.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const baseUrl = requireBaseUrl('listTransactions');
    const auth = requireAuthParams('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Chunk into ≤31-day slices defensively (tenants may cap wide windows).
    const slices = chunkDateRange(from, to, 31);

    const allRows: Offer18ReportRaw[] = [];
    for (const slice of slices) {
      const env = await offer18Request<Offer18ReportEnvelope | Offer18ReportRaw[]>({
        operation: 'listTransactions',
        baseUrl,
        path: '/api/af/report',
        query: {
          key: auth.key,
          aid: auth.aid,
          mid: auth.mid,
          date_from: formatOffer18Date(slice.start),
          date_end: formatOffer18Date(slice.end),
          // Offer filter is server-side via `offer` (comma list of offer ids).
          offer: query?.programmeId,
          // Default UTC. Offer18 expects a decimal timezone offset.
          timezone: '0.0',
          results: 1000,
          page: 0,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRows.push(...extractReportRows(env));
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    // programmeId filter — also applied client-side in case the server-side
    // `offer` filter is ignored by a tenant.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9. Applied AFTER status filtering.
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
   * Aggregate the affiliate report into an earnings summary.
   *
   * Derived from `listTransactions` for the same reason as Awin/Everflow: the
   * per-transaction `ageDays` is needed for `oldestUnpaidAgeDays`, so we already
   * have the raw rows; deriving keeps the summary auditable.
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
          programmeName: t.programmeName || `Offer18 offer ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved).
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
   * Offer18 does not expose a distinct click-level affiliate endpoint.
   *
   * The affiliate report aggregates clicks as a count per row, but there is no
   * documented per-click stream for affiliates. We throw NotImplementedError
   * rather than returning an empty array — the difference between "no clicks"
   * and "no API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Offer18 does not expose click-level data via a distinct affiliate API endpoint',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Offer18 tracking links are NOT deterministically constructible from the
   * affiliate API.
   *
   * The click URL takes the form `https://<tenant-click-domain>/c?o=<offerid>&m=<id>`,
   * but the per-tenant click domain is not returned by the affiliate offers or
   * report endpoints (the offers response carries `preview_url`, not the
   * affiliate's tracking link). Without the click domain we cannot build a valid
   * link, so we surface NotImplementedError rather than fabricate one.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Offer18 tracking links require the per-tenant click domain, which is not exposed via the affiliate API',
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

    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known offer ID; not probed automatically.',
    };

    operations['listClicks'] = {
      supported: false,
      note: 'Offer18 does not expose click-level data via a distinct affiliate API endpoint.',
    };

    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Tracking links require the per-tenant click domain, which is not exposed via the affiliate API.',
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

export const offer18Adapter = new Offer18Adapter();
registerAdapter(offer18Adapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Mirrors Awin/Everflow.
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

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  rowToIso,
  toProgramme,
  toTransaction,
  splitCategories,
  chunkDateRange,
  formatOffer18Date,
  extractOffers,
  extractReportRows,
};

// Silence unused-import lint for the logger.
void log;
