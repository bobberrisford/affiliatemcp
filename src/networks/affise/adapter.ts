/**
 * Affise adapter — publisher / affiliate (partner) side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and `src/networks/everflow/adapter.ts`. Read those files and their header
 * comments before modifying this one.
 *
 * --- What Affise is ---------------------------------------------------------
 *
 * Affise is a CPA "tenant engine": many independent networks each run their own
 * Affise instance under their own host. There is no single shared API. ONE
 * adapter parameterised by a per-tenant base URL + API key therefore covers
 * every Affise-powered network. Modelled as side: publisher,
 * credential_scope: single-brand.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `API-Key: <key>` (affiliate panel → Settings → Security).
 * Base:    PER-TENANT — the network's tracking domain (Settings → Tracking
 *          domains), supplied via the AFFISE_BASE_URL credential and validated
 *          in client.ts. NOT hard-coded.
 * Docs:    https://api.affise.com/docs3.1/
 *
 * --- Endpoint map (affiliate / partner endpoints, API v3.0) -----------------
 *
 *   GET  /3.0/partner/offers
 *     → offers the partner is connected to (the "programmes"). Paginated via a
 *       `pagination` object { page, per_page, total_count }. Filterable by
 *       `countries[]` and similar. Each offer carries a ready-to-use tracking
 *       `url`, a `preview_url`, `payments[]`, and `currency`.
 *   GET  /3.0/stats/conversions
 *     → conversion list for a `date_from`/`date_to` window. Filters: `status[]`,
 *       `offer[]`, `goal[]`. Paginated. Each conversion carries `id`,
 *       `action_id`, `status` (string), `currency`, `payouts`/`sum`/`revenue`,
 *       and string timestamps `created_at` / `click_time`.
 *
 * Amount unit: the affiliate-facing amount is `payouts` (the sum paid to the
 * affiliate). Affise documents amounts as decimal currency values (major units),
 * NOT minor units / cents — see the `commission` mapping and the known-limitation
 * note. If a live account proves otherwise this is the single place to adjust.
 *
 * --- Sources used (recorded 2026-06-05) -------------------------------------
 *
 *   https://api.affise.com/docs3.1/
 *   https://help-center.affise.com/en/articles/6790455-start-with-api-affiliates
 *   https://help-center.affise.com/en/articles/6812840-api-for-offers-and-statistics-affiliates
 *   https://help-center.affise.com/en/articles/6618579-conversion-statuses
 *   (statuses: 1 Approved, 2 Pending, 3 Declined, 5 Hold; string forms
 *    "confirmed"/"pending"/"declined"/"hold"/"trash")
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `affiseRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter implemented from public API docs; not yet validated against a
 *     live account (claim_status: experimental).
 *   - The API base URL is per-tenant (each network's tracking domain) supplied
 *     via AFFISE_BASE_URL; there is no single shared host.
 *   - Amounts assumed to be in major currency units (not cents).
 *   - No raw click-level affiliate endpoint is exposed; listClicks is
 *     NotImplemented.
 */

import { affiseRequest, resolveBaseUrl } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
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

const log = createLogger('affise.adapter');

const SLUG = 'affise';
const NAME = 'Affise';

const KNOWN_LIMITATIONS = [
  'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
  'The API base URL is per-tenant: each network runs its own Affise instance, so the base is the network\'s tracking domain supplied via AFFISE_BASE_URL — there is no single shared host.',
  'Amounts are assumed to be in major currency units (not minor units / cents); confirm against a live account before promoting beyond experimental.',
  'No raw click-level affiliate endpoint is exposed by the partner API; listClicks is not implemented.',
];

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Representative placeholder only. The REAL base is per-tenant (the network's
  // tracking domain) supplied via AFFISE_BASE_URL — see known limitations.
  baseUrl: 'https://api.affise.com',
  // Affise uses a custom `API-Key` header rather than `Authorization: Bearer`.
  authModel: 'custom',
  docsUrl: 'https://api.affise.com/docs3.1/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: implemented from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: KNOWN_LIMITATIONS,
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // The affiliate self-serves the key from Settings → Security; no approval gate.
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Conversion stats (listTransactions / getEarningsSummary) can be slow on wide
 * windows. Give them a 60s timeout and 3 retries, matching Everflow's reporting
 * profile.
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
// Affise raw response shapes (deliberately minimal — see Awin adapter for rationale)
// ---------------------------------------------------------------------------

/** One payment row attached to an offer (per-geo / per-payment-type payout). */
interface AffisePaymentRaw {
  country?: string[] | string;
  revenue?: number;
  total?: number; // affiliate payout amount on some payloads
  currency?: string;
  title?: string;
}

/** Minimal shape of one offer record from GET /3.0/partner/offers. */
interface AffiseOfferRaw {
  // Affise offer payloads expose both `id` (Mongo ObjectId string) and a numeric
  // `offer_id`. We prefer `offer_id` as the stable public identifier.
  id?: string;
  offer_id?: number;
  title?: string;
  // Offer status string, e.g. "active", "stopped", "suspended".
  status?: string;
  currency?: string;
  // Ready-to-use tracking URL for the offer (already includes the affiliate's
  // pid). `preview_url` is the direct landing-page link.
  url?: string;
  preview_url?: string;
  payments?: AffisePaymentRaw[];
  categories?: string[];
  // Whether the partner is connected to / approved on this offer. Affise exposes
  // a connection flag on partner offers; field name varies, so we read several.
  is_connected?: boolean;
  required_approval?: boolean;
}

/** Pagination envelope shared by partner offers + stats endpoints. */
interface AffisePagination {
  page?: number;
  per_page?: number;
  total_count?: number;
}

/** Envelope from GET /3.0/partner/offers. */
interface AffiseOffersEnvelope {
  // Affise wraps the success flag in a numeric `status` (1 = ok) at the envelope
  // level; the offer array is under `offers`.
  status?: number;
  offers?: AffiseOfferRaw[];
  pagination?: AffisePagination;
}

/** Minimal shape of one conversion record from GET /3.0/stats/conversions. */
interface AffiseConversionRaw {
  id?: string;
  action_id?: string;
  // Conversion status string. Confirmed values: "confirmed", "pending",
  // "declined", "hold", "trash".
  status?: string;
  currency?: string;
  // Amounts. `payouts` is the sum paid to the affiliate (the commission);
  // `revenue` is what the advertiser pays the network; `sum` is the afprice the
  // advertiser passed. We treat amounts as decimal major-currency values.
  payouts?: number;
  revenue?: number;
  sum?: number;
  goal?: string | null;
  offer_id?: number;
  offer?: { id?: number; title?: string };
  // String timestamps "YYYY-MM-DD HH:mm:SS".
  created_at?: string;
  updated_at?: string;
  click_time?: string;
  // Decline reason / comment, surfaced as reversalReason for declined rows.
  comment?: string;
  reason?: string;
}

/** Envelope from GET /3.0/stats/conversions. */
interface AffiseConversionsEnvelope {
  status?: number;
  conversions?: AffiseConversionRaw[];
  pagination?: AffisePagination;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(operation: string): string {
  return requireCredential('AFFISE_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your affiliate API key in your Affise partner panel under ' +
      'Settings → Security, then set AFFISE_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Resolve both credentials at once for an operation. The base URL is validated
 * inside `resolveBaseUrl`; a missing/invalid value throws a config_error.
 */
function requireCreds(operation: string): { apiKey: string; baseUrl: string } {
  const baseUrl = resolveBaseUrl(operation);
  const apiKey = requireApiKey(operation);
  return { apiKey, baseUrl };
}

/**
 * Status normalisation: Affise offer status → canonical ProgrammeStatus.
 *
 * Affise partner offers expose a free-text offer `status` plus a connection
 * flag. We prefer the connection state (does THIS partner have access?) when it
 * is present, then fall back to the offer's own lifecycle status.
 *
 * Connection: is_connected true → 'joined'; required_approval (and not
 * connected) → 'pending'.
 *
 * Offer lifecycle (confirmed-ish from public docs; verify live):
 *   active           → 'available'
 *   stopped/paused   → 'suspended'
 *   suspended        → 'suspended'
 *   anything else    → 'unknown'  (prefer unknown over a wrong guess)
 */
function mapProgrammeStatus(raw: AffiseOfferRaw): ProgrammeStatus {
  if (raw.is_connected === true) return 'joined';
  if (raw.is_connected === false && raw.required_approval === true) return 'pending';

  const status = (raw.status ?? '').toLowerCase();
  if (status === 'active') return 'available';
  if (status === 'stopped' || status === 'paused' || status === 'suspended') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: Affise conversion status → canonical TransactionStatus.
 *
 * Confirmed Affise conversion statuses (system codes / string forms):
 *   1 confirmed / approved → 'approved'
 *   2 pending              → 'pending'
 *   3 declined             → 'reversed'  (declined by advertiser postback)
 *   5 hold                 → 'pending'   (hold is a time-delayed approval)
 *   trash                  → 'reversed'  (fraud / discarded)
 *   anything else          → 'other'     (prefer "other" over a wrong guess)
 *
 * Note: Affise does not expose a distinct "paid" status on the conversion list;
 * "approved" is the payable state. We never synthesise a 'paid' status.
 */
function mapTransactionStatus(raw: AffiseConversionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'confirmed' || s === 'approved' || s === '1') return 'approved';
  if (s === 'pending' || s === '2' || s === 'hold' || s === '5') return 'pending';
  if (s === 'declined' || s === '3' || s === 'trash' || s === 'rejected') return 'reversed';
  return 'other';
}

/**
 * Compute the age in days of a transaction relative to `now`.
 *
 * We anchor on `created_at` (when the conversion was recorded). Affise uses
 * string timestamps "YYYY-MM-DD HH:mm:SS" (server timezone); `Date.parse`
 * handles that form. There is no separate validation/approval date on the
 * conversion list, so `created_at` is the only reliable anchor.
 */
function computeAgeDays(raw: AffiseConversionRaw, now: Date = new Date()): number {
  const anchor = raw.created_at;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (d === undefined || d === null) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** Format a Date as Affise's `YYYY-MM-DD` date-range parameter. */
function formatAffiseDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: AffiseOfferRaw): Programme {
  const id = String(raw.offer_id ?? raw.id ?? '');
  // First payment row is a reasonable representative for the commission/currency
  // when present; the full structure is preserved in rawNetworkData.
  const firstPayment = raw.payments?.[0];
  const payout = firstPayment?.total ?? firstPayment?.revenue;
  const currency = raw.currency ?? firstPayment?.currency;

  return {
    id,
    name: raw.title ?? `Affise offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency,
    commissionRate:
      payout !== undefined
        ? {
            type: 'flat',
            value: payout,
            currency,
            description: `Payout ${payout}${currency ? ` ${currency}` : ''}`,
          }
        : undefined,
    categories: raw.categories ?? [],
    advertiserUrl: raw.preview_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AffiseConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // `payouts` is the affiliate's commission; fall back to `sum` then `revenue`.
  const commission = raw.payouts ?? raw.sum ?? raw.revenue ?? 0;
  // The affiliate sale/revenue figure: prefer `revenue`, else `sum`.
  const amount = raw.revenue ?? raw.sum ?? 0;
  const currency = raw.currency ?? 'USD';
  const offerId = String(raw.offer_id ?? raw.offer?.id ?? '');
  const programmeName = raw.offer?.title ?? `Affise offer ${offerId}`;

  const dateConverted = nullableIso(raw.created_at) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.click_time);

  return {
    id: raw.id ?? raw.action_id ?? '',
    network: SLUG,
    programmeId: offerId,
    programmeName,
    status,
    amount,
    currency,
    commission,
    dateClicked,
    dateConverted,
    // Affise does not expose a separate approval date on the conversion list.
    // For approved rows we use updated_at as a best-effort proxy (the row was
    // last touched when its status changed); left undefined otherwise.
    dateApproved: status === 'approved' ? nullableIso(raw.updated_at) ?? dateConverted : undefined,
    // No payment date is exposed on the conversion list.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.comment ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AffiseAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the offers (programmes) this partner is connected to.
   *
   * Affise endpoint: GET /3.0/partner/offers
   *   Returns partner offers paginated via a `pagination` object. We fetch the
   *   first page (up to `query.limit` or 100) and apply client-side
   *   search/status/category/limit filters for cross-network consistency.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const { apiKey, baseUrl } = requireCreds('listProgrammes');
    const perPage = Math.min(query?.limit ?? 100, 500);

    const envelope = await affiseRequest<AffiseOffersEnvelope>({
      operation: 'listProgrammes',
      path: '/3.0/partner/offers',
      apiKey,
      baseUrl,
      query: { page: 1, limit: perPage },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (envelope.offers ?? []).map(toProgramme);

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
   * Fetch a single offer by its numeric offer ID.
   *
   * Affise endpoint: GET /3.0/partner/offers?ids[]={offerId}
   *   The partner offers endpoint accepts an id filter; we use it (rather than
   *   an admin single-offer endpoint) so the call stays partner-scoped. The
   *   first matching offer is returned.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Affise offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_affise_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const { apiKey, baseUrl } = requireCreds('getProgramme');

    const envelope = await affiseRequest<AffiseOffersEnvelope>({
      operation: 'getProgramme',
      path: '/3.0/partner/offers',
      apiKey,
      baseUrl,
      query: { ids: [Number(programmeId)], page: 1, limit: 1 },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const offer = envelope.offers?.[0];
    if (!offer) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Affise returned no offer for ID ${programmeId}.`,
          hint:
            'Confirm the offer ID exists and is connected to your partner account ' +
            'via affiliate_affise_list_programmes.',
        }),
      );
    }

    return toProgramme(offer);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions via the Affise conversions stats endpoint.
   *
   * Affise endpoint: GET /3.0/stats/conversions
   *   Params: date_from, date_to (YYYY-MM-DD), page, limit, status[], offer[].
   *
   * Date window default: last 30 days. Affise paginates conversions; we fetch
   * the first page (up to `limit` or 500). Wider, multi-page pulls are a v0.2
   * concern once the per-page cap is confirmed against a live account.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { apiKey, baseUrl } = requireCreds('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const reqQuery: Record<string, string | number | Array<string | number> | undefined> = {
      date_from: formatAffiseDate(from),
      date_to: formatAffiseDate(to),
      page: 1,
      limit: Math.min(query?.limit ?? 500, 1000),
    };

    if (query?.programmeId) {
      reqQuery['offer'] = [Number(query.programmeId)];
    }

    const envelope = await affiseRequest<AffiseConversionsEnvelope>({
      operation: 'listTransactions',
      path: '/3.0/stats/conversions',
      apiKey,
      baseUrl,
      query: reqQuery,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    let transactions = (envelope.conversions ?? []).map((r) => toTransaction(r, now));

    // Status filter (client-side) so the canonical status semantics apply
    // uniformly across networks.
    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — applied AFTER status filtering (PRD §15.9).
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
   * Aggregate the conversion list into an earnings summary.
   *
   * We derive the summary from `listTransactions` (not a separate aggregated
   * stats endpoint) so the per-transaction `ageDays` is available for the
   * `oldestUnpaidAgeDays` affordance and so the user can reproduce the figures
   * by listing the same transactions.
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
          programmeName: t.programmeName || `Affise offer ${key}`,
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
   * Affise's partner API does not expose a raw click-level endpoint: click data
   * is available only as aggregated traffic counts inside the stats slices, not
   * as individual click records. We surface this honestly rather than returning
   * an empty array (principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Affise does not expose raw click-level data via the partner API; only aggregated ' +
        'traffic counts are available in the stats slices.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Produce an Affise tracking URL for an offer.
   *
   * Affise offers carry a ready-to-use tracking `url` (already scoped to the
   * partner's pid). We fetch the offer via the partner offers endpoint, take its
   * `url`, and append the destination as the `url` deep-link parameter Affise
   * uses for landing-page override. This is deterministic given the offer's
   * tracking URL — no separate "build link" endpoint is required.
   *
   * If the offer carries no tracking URL (e.g. the partner is not connected), we
   * surface a network_api_error rather than inventing a link.
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
          message: 'Affise tracking links require the offer (programme) ID.',
          hint: 'Pass `programmeId`. Use affiliate_affise_list_programmes to discover offer IDs.',
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
          hint: 'Pass the URL of the page you want to link to within the advertiser\'s site.',
        }),
      );
    }
    if (!/^\d+$/.test(input.programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Affise offer IDs are numeric; received "${input.programmeId}".`,
          hint: 'Use affiliate_affise_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const { apiKey, baseUrl } = requireCreds('generateTrackingLink');

    const envelope = await affiseRequest<AffiseOffersEnvelope>({
      operation: 'generateTrackingLink',
      path: '/3.0/partner/offers',
      apiKey,
      baseUrl,
      query: { ids: [Number(input.programmeId)], page: 1, limit: 1 },
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const offer = envelope.offers?.[0];
    const baseTrackingUrl = offer?.url;

    if (!baseTrackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Affise returned no tracking URL for offer ${input.programmeId}.`,
          hint:
            'Confirm the offer is connected to your partner account ' +
            '(status joined) via affiliate_affise_list_programmes.',
        }),
      );
    }

    // Append the landing-page override as the `url` deep-link parameter.
    let trackingUrl: string;
    try {
      const u = new URL(baseTrackingUrl);
      u.searchParams.set('url', input.destinationUrl);
      trackingUrl = u.toString();
    } catch {
      // The offer URL was not absolute; fall back to the raw value so the user
      // still gets the offer link rather than a hard failure.
      trackingUrl = baseTrackingUrl;
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

    // listClicks is intentionally unsupported — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Affise partner API does not expose raw click-level data.',
    };

    // getProgramme + generateTrackingLink need a known offer ID — mark
    // experimental without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known offer ID; not probed automatically.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known connected offer ID; not probed automatically.',
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

export const affiseAdapter = new AffiseAdapter();
registerAdapter(affiseAdapter);

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  formatAffiseDate,
};

// Silence unused-import lint for the logger.
void log;
