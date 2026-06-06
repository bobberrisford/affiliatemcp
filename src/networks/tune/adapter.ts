/**
 * TUNE (HasOffers) adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * (the canonical reference) and `src/networks/affise/adapter.ts` (the per-tenant
 * "multiplier" base-URL pattern). Read those files and their header comments
 * before modifying this one.
 *
 * --- What TUNE is -----------------------------------------------------------
 *
 * TUNE (formerly HasOffers) is a CPA platform engine: many independent networks
 * each run their own TUNE instance under their own subdomain
 * (`https://{network_id}.api.hasoffers.com`). There is no single shared API.
 * ONE adapter parameterised by a NetworkId + affiliate api_key therefore covers
 * every HasOffers-powered network. Modelled as side: publisher,
 * credential_scope: single-brand.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:  Two query parameters on every call — `api_key` (affiliate key from the
 *        publisher dashboard) and `NetworkId`.
 * Base:  PER-TENANT — built from the TUNE_NETWORK_ID credential as
 *        `https://{network_id}.api.hasoffers.com`, validated in client.ts. NOT
 *        hard-coded.
 * Route: Target/Method convention — `…/Apiv3/json?Target=X&Method=y&…`.
 * Docs:  https://developers.tune.com/affiliate/
 *
 * --- Endpoint map (affiliate API) -------------------------------------------
 *
 *   Affiliate_Offer::findAll
 *     → offers the affiliate can run (the "programmes"). Response data carries
 *       `page` / `pageCount` / `count` and a `data` map keyed by offer id, each
 *       value `{ Offer: {…} }`. Offer fields used: id, name, status, currency,
 *       default_payout, preview_url, offer_url.
 *   Affiliate_Report::getConversions
 *     → conversions for a datetime window. Response data carries the same
 *       pagination keys and a `data` map of rows `{ Stat: {…}, Offer: {…},
 *       Conversion: {…} }`. Stat fields used: id, payout, currency, datetime,
 *       status (approved | pending | rejected), offer_id, affiliate_info*.
 *   Affiliate_Offer::generateTrackingLink
 *     → builds a tracking link for one offer; data carries `click_url`.
 *
 * Date filtering: HasOffers recommends filtering conversions on `Stat.datetime`
 * (not `Stat.date`) and splitting wide windows into multiple calls to avoid
 * intermittent timeouts. We pass `filters[Stat.datetime][start|end]` and chunk
 * windows wider than 31 days (see `chunkDateRange`).
 *
 * Amount unit: `Stat.payout` is the affiliate-facing commission. HasOffers
 * documents amounts as decimal currency values (major units), NOT minor units /
 * cents. If a live account proves otherwise this is the single place to adjust;
 * the assumption is recorded as a known limitation.
 *
 * --- Sources used (recorded 2026-06-05) -------------------------------------
 *
 *   https://developers.tune.com/affiliate/
 *   https://developers.tune.com/affiliate/affiliate_offer-findall/
 *   https://developers.tune.com/affiliate/affiliate_report-getconversions/
 *   https://developers.tune.com/affiliate/affiliate_offer-generatetrackinglink/
 *   https://developers.tune.com/affiliate-docs/getting-started-with-the-hasoffers-affiliate-api/
 *   https://github.com/jthi3rry/hasoffers (envelope: response.status/data, page/pageCount)
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `tuneRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 */

import { tuneRequest, resolveBaseUrl } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiKey, requireNetworkId } from './auth.js';
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

const log = createLogger('tune.adapter');

const SLUG = 'tune';
const NAME = 'TUNE';

const KNOWN_LIMITATIONS = [
  'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
  'The API base URL is per-tenant: TUNE (HasOffers) is a CPA platform engine and each network runs its own instance, so one adapter serves any HasOffers-powered network via its NetworkId (the host is https://{network_id}.api.hasoffers.com); there is no single shared host.',
  'Amounts (Stat.payout) are assumed to be in major currency units (not minor units / cents); confirm against a live account before promoting beyond experimental.',
  'Click-level data is not exposed via the affiliate API; listClicks is not implemented.',
];

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Representative placeholder only. The REAL base is per-tenant, built from the
  // NetworkId as https://{network_id}.api.hasoffers.com — see known limitations.
  baseUrl: 'https://api.hasoffers.com',
  // TUNE uses api_key + NetworkId query parameters, not Authorization: Bearer.
  authModel: 'custom',
  docsUrl: 'https://developers.tune.com/affiliate/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: implemented from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: KNOWN_LIMITATIONS,
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // The affiliate self-serves the key from the dashboard; no approval gate here.
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Conversion reporting (listTransactions / getEarningsSummary) can be slow on
 * wide windows — HasOffers itself recommends splitting big windows. Give those
 * ops a 60s timeout and 3 retries, matching Awin's reporting profile.
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
// TUNE raw response shapes (deliberately minimal — see Awin adapter for rationale)
// ---------------------------------------------------------------------------

/** One Offer model row (under the `Offer` key of each findAll data row). */
interface TuneOfferRaw {
  id?: string | number;
  name?: string;
  // Offer lifecycle status, e.g. "active", "paused", "pending", "expired".
  status?: string;
  currency?: string;
  default_payout?: string | number;
  payout_type?: string;
  preview_url?: string;
  offer_url?: string;
  description?: string;
  // The affiliate's approval state on this offer, where HasOffers exposes it.
  approval_status?: string;
}

/** One Stat model row (under the `Stat` key of each getConversions data row). */
interface TuneStatRaw {
  id?: string | number;
  offer_id?: string | number;
  affiliate_id?: string | number;
  payout?: string | number;
  sale_amount?: string | number;
  revenue?: string | number;
  currency?: string;
  // Conversion approval status: "approved" | "pending" | "rejected".
  status?: string;
  // HasOffers datetime, "YYYY-MM-DD HH:mm:SS" (network timezone).
  datetime?: string;
  // The reason a conversion was rejected, where exposed.
  note?: string;
}

/** A getConversions data row: nested model objects keyed by model name. */
interface TuneConversionRow {
  Stat?: TuneStatRaw;
  Offer?: { id?: string | number; name?: string };
  Conversion?: Record<string, unknown>;
}

/** A findAll data row for offers. */
interface TuneOfferRow {
  Offer?: TuneOfferRaw;
}

/**
 * The inner `response.data` shape for a paginated findAll/getConversions call.
 *
 * HasOffers nests the result rows under `data` as a MAP keyed by row id (not an
 * array), alongside `page` / `pageCount` / `count`. We normalise the map to an
 * array of values in `dataRows`.
 */
interface TunePagedData<TRow> {
  page?: number;
  pageCount?: number;
  count?: number;
  data?: Record<string, TRow> | TRow[];
}

/** The `response.data` shape for generateTrackingLink. */
interface TuneTrackingLinkData {
  click_url?: string;
  impression_url?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve all three credentials for an operation; base URL validated inside resolveBaseUrl. */
function requireCreds(operation: string): { apiKey: string; baseUrl: string; networkId: string } {
  const baseUrl = resolveBaseUrl(operation);
  const networkId = requireNetworkId(operation);
  const apiKey = requireApiKey(operation);
  return { apiKey, baseUrl, networkId };
}

/**
 * Normalise the HasOffers `data` map (keyed by id) to an array of row values.
 * HasOffers returns paginated results as an object keyed by row id; we flatten
 * to an array so transformers can map uniformly. An array form is tolerated too.
 */
function dataRows<TRow>(paged: TunePagedData<TRow> | undefined): TRow[] {
  const d = paged?.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return Object.values(d);
}

/**
 * Status normalisation: TUNE offer status → canonical ProgrammeStatus.
 *
 * HasOffers exposes the affiliate's approval state (`approval_status`) where
 * available; we prefer it (does THIS affiliate have access?) then fall back to
 * the offer's own lifecycle `status`:
 *
 *   approval_status approved              → 'joined'
 *   approval_status pending               → 'pending'
 *   approval_status rejected              → 'declined'
 *   status active / public                → 'available'
 *   status paused / private / suspended   → 'suspended'
 *   anything else                         → 'unknown' (prefer over a wrong guess)
 */
function mapProgrammeStatus(raw: TuneOfferRaw): ProgrammeStatus {
  const approval = (raw.approval_status ?? '').toLowerCase();
  if (approval === 'approved') return 'joined';
  if (approval === 'pending') return 'pending';
  if (approval === 'rejected') return 'declined';

  const status = (raw.status ?? '').toLowerCase();
  if (status === 'active' || status === 'public') return 'available';
  if (status === 'paused' || status === 'private' || status === 'suspended') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: TUNE conversion status → canonical TransactionStatus.
 *
 * HasOffers conversion status is one of "approved" | "pending" | "rejected":
 *   approved → 'approved'
 *   pending  → 'pending'
 *   rejected → 'reversed'  (the affiliate is not paid; "reversed" is what every
 *                           other network calls this state)
 *   anything else → 'other' (prefer "other" over a wrong guess)
 *
 * HasOffers does not expose a distinct "paid" status on the conversion list;
 * "approved" is the payable state. We never synthesise a 'paid' status.
 */
function mapTransactionStatus(raw: TuneStatRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined') return 'reversed';
  return 'other';
}

/**
 * Compute the age in days of a transaction relative to `now`.
 *
 * We anchor on `Stat.datetime` (when the conversion was recorded). HasOffers
 * uses "YYYY-MM-DD HH:mm:SS"; `Date.parse` handles that form. There is no
 * separate validation/approval date on the conversion list, so `datetime` is
 * the only reliable anchor.
 */
function computeAgeDays(raw: TuneStatRaw, now: Date = new Date()): number {
  const anchor = raw.datetime;
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

/** Parse a HasOffers numeric-ish field (often a string) to a number, default 0. */
function toNumber(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** Format a Date as HasOffers' datetime filter value: "YYYY-MM-DD HH:mm:SS" (UTC). */
function formatTuneDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. HasOffers recommends splitting
 * wide windows to avoid intermittent timeouts on `Stat.datetime` filtering; we
 * chunk so callers can request wider windows naturally and the adapter handles
 * the slicing. Returns at least one slice.
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

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: TuneOfferRaw): Programme {
  const id = String(raw.id ?? '');
  const payout = raw.default_payout !== undefined ? toNumber(raw.default_payout) : undefined;
  const isPercent = (raw.payout_type ?? '').toLowerCase().includes('percent');

  return {
    id,
    name: raw.name ?? `TUNE offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate:
      payout !== undefined
        ? {
            type: isPercent ? 'percent' : 'flat',
            value: payout,
            currency: isPercent ? undefined : raw.currency,
            description: isPercent
              ? `Payout ${payout}%`
              : `Payout ${payout}${raw.currency ? ` ${raw.currency}` : ''}`,
          }
        : undefined,
    advertiserUrl: raw.preview_url ?? raw.offer_url,
    rawNetworkData: raw,
  };
}

function toTransaction(row: TuneConversionRow, now: Date = new Date()): Transaction {
  const stat = row.Stat ?? {};
  const status = mapTransactionStatus(stat);
  // `payout` is the affiliate's commission; `sale_amount` (else `revenue`) is
  // the sale value.
  const commission = toNumber(stat.payout);
  const amount = stat.sale_amount !== undefined ? toNumber(stat.sale_amount) : toNumber(stat.revenue);
  const currency = stat.currency ?? 'USD';
  const offerId = String(stat.offer_id ?? row.Offer?.id ?? '');
  const programmeName = row.Offer?.name ?? `TUNE offer ${offerId}`;

  const dateConverted = nullableIso(stat.datetime) ?? new Date(0).toISOString();

  return {
    id: String(stat.id ?? ''),
    network: SLUG,
    programmeId: offerId,
    programmeName,
    status,
    amount,
    currency,
    commission,
    // HasOffers conversion list does not expose a distinct click timestamp here.
    dateClicked: undefined,
    dateConverted,
    // No separate approval date on the conversion list. For approved rows we use
    // the conversion datetime as a best-effort proxy; left undefined otherwise.
    dateApproved: status === 'approved' ? dateConverted : undefined,
    // No payment date is exposed on the conversion list.
    datePaid: undefined,
    ageDays: computeAgeDays(stat, now),
    reversalReason: status === 'reversed' ? stat.note ?? undefined : undefined,
    rawNetworkData: row,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class TuneAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the offers (programmes) available to this affiliate.
   *
   * TUNE call: Affiliate_Offer::findAll
   *   Returns offers paginated via `page` / `pageCount`. We fetch the first page
   *   (up to `query.limit` or 100) and apply client-side search/status/limit
   *   filters for cross-network consistency.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const { apiKey, baseUrl, networkId } = requireCreds('listProgrammes');
    const limit = Math.min(query?.limit ?? 100, 500);

    const data = await tuneRequest<TunePagedData<TuneOfferRow>>({
      operation: 'listProgrammes',
      target: 'Affiliate_Offer',
      apiMethod: 'findAll',
      apiKey,
      baseUrl,
      networkId,
      query: { limit, page: 1 },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = dataRows(data)
      .map((row) => row.Offer)
      .filter((o): o is TuneOfferRaw => o !== undefined)
      .map(toProgramme);

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
   * Fetch a single offer by its numeric offer ID.
   *
   * TUNE call: Affiliate_Offer::findAll with `filters[id]={offerId}` and limit 1.
   *   We reuse findAll (rather than findById) so the call stays affiliate-scoped
   *   and returns the same Offer shape the list uses. The first matching offer
   *   is returned.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `TUNE offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_tune_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const { apiKey, baseUrl, networkId } = requireCreds('getProgramme');

    const data = await tuneRequest<TunePagedData<TuneOfferRow>>({
      operation: 'getProgramme',
      target: 'Affiliate_Offer',
      apiMethod: 'findAll',
      apiKey,
      baseUrl,
      networkId,
      query: { filters: { id: programmeId }, limit: 1, page: 1 },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const offer = dataRows(data)[0]?.Offer;
    if (!offer) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `TUNE returned no offer for ID ${programmeId}.`,
          hint: 'Confirm the offer ID exists and is available to your affiliate account via affiliate_tune_list_programmes.',
        }),
      );
    }

    return toProgramme(offer);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions via the affiliate conversions report.
   *
   * TUNE call: Affiliate_Report::getConversions
   *   Params: filters[Stat.datetime][start|end] ("YYYY-MM-DD HH:mm:SS"), page,
   *   limit, and optionally filters[Stat.offer_id]. HasOffers recommends
   *   filtering on Stat.datetime (not Stat.date) and splitting wide windows, so
   *   we chunk into ≤31-day slices and concatenate the rows.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *   `minAgeDays` / `maxAgeDays` filter on the computed `ageDays`, applied AFTER
   *   status filtering so `{ status: 'approved', minAgeDays: 180 }` is meaningful.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *   Rejected conversions (canonical 'reversed') are returned unless excluded
   *   via `status`; `reversalReason` is populated from `Stat.note` where present.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { apiKey, baseUrl, networkId } = requireCreds('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Chunk wide windows into ≤31-day slices (HasOffers timeout guidance).
    const slices = chunkDateRange(from, to, 31);

    const allRows: TuneConversionRow[] = [];
    for (const slice of slices) {
      const filters: { [key: string]: string | number } = {
        'Stat.datetime][start': formatTuneDatetime(slice.start),
        'Stat.datetime][end': formatTuneDatetime(slice.end),
      };
      if (query?.programmeId) {
        filters['Stat.offer_id'] = query.programmeId;
      }

      const data = await tuneRequest<TunePagedData<TuneConversionRow>>({
        operation: 'listTransactions',
        target: 'Affiliate_Report',
        apiMethod: 'getConversions',
        apiKey,
        baseUrl,
        networkId,
        query: {
          // `filters` is flattened by the client to `filters[key]=value`. The
          // datetime keys already carry the bracketed sub-path so the wire form
          // becomes `filters[Stat.datetime][start]=…`.
          filters,
          limit: Math.min(query?.limit ?? 500, 1000),
          page: 1,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRows.push(...dataRows(data));
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
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
   * Aggregate the conversion list into an earnings summary.
   *
   * Derived from `listTransactions` (not a separate aggregated stats endpoint)
   * so the per-transaction `ageDays` is available for `oldestUnpaidAgeDays` and
   * so the user can reproduce the figures by listing the same transactions.
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
          programmeName: t.programmeName || `TUNE offer ${key}`,
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
   * TUNE's affiliate API does not expose raw click-level records: click data is
   * available only as aggregated stats. We surface this honestly rather than
   * returning an empty array (principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'TUNE does not expose raw click-level data via the affiliate API; only aggregated click stats are available.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Produce a TUNE tracking link for an offer.
   *
   * TUNE call: Affiliate_Offer::generateTrackingLink
   *   Generates an offer tracking link for the calling affiliate; the response
   *   data carries `click_url`. We pass the destination as the `params[url]`
   *   override where the offer supports a redirect target. This requires an API
   *   round-trip (the link is signed per-affiliate), unlike Awin's deterministic
   *   construction.
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
          message: 'TUNE tracking links require the offer (programme) ID.',
          hint: 'Pass `programmeId`. Use affiliate_tune_list_programmes to discover offer IDs.',
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
          message: `TUNE offer IDs are numeric; received "${input.programmeId}".`,
          hint: 'Use affiliate_tune_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const { apiKey, baseUrl, networkId } = requireCreds('generateTrackingLink');

    const data = await tuneRequest<TuneTrackingLinkData>({
      operation: 'generateTrackingLink',
      target: 'Affiliate_Offer',
      apiMethod: 'generateTrackingLink',
      apiKey,
      baseUrl,
      networkId,
      query: {
        offer_id: input.programmeId,
        // `params` is flattened to `params[url]=…` — the redirect override.
        params: { url: input.destinationUrl },
      },
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const trackingUrl = data?.click_url;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `TUNE returned no tracking link for offer ${input.programmeId}.`,
          hint: 'Confirm the offer is available to your affiliate account via affiliate_tune_list_programmes.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: data,
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
      note: 'TUNE affiliate API does not expose raw click-level data.',
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
      note: 'Requires a known offer ID; not probed automatically.',
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

export const tuneAdapter = new TuneAdapter();
registerAdapter(tuneAdapter);

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  formatTuneDatetime,
  chunkDateRange,
  dataRows,
  toNumber,
};

// Silence unused-import lint for the logger.
void log;
