/**
 * Adservice adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and its sibling `src/networks/skimlinks/adapter.ts`. The load-bearing
 * decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- Adservice API map ---------------------------------------------------------
 *
 * Adservice is a Nordic publisher-side affiliate network (now part of the merged
 * Adtraction/Adservice group; the first-party publisher API docs at
 * publisher.adservice.com/doc/publisher/API/ are titled "Adtraction Platform").
 * It is a multi-market, multi-currency network — currency is read per row, never
 * hardcoded.
 *
 * Base URL: https://api.adservice.com/cgi-bin/publisher/API/
 *
 * Auth (auth_model: custom): UID + LoginToken supplied as COOKIES on every request,
 * obtained via /Account.pl/loginToken.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *
 * Reporting endpoint (GET Statistics.pl):
 *   ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
 *   [&camp_id=N][&country_id=N]
 *   [&group_by=camp_title|banner_id|agent_id|year|monthyear|weekyear|stamp|medianame|sub]
 *   [&showPending=1|0][&period=day|month][&currency=...][&limit=N]
 *   Returns AGGREGATE statistics (impressions, clicks, leads, earnings, pending
 *   conversions) grouped by the requested dimension.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *
 * Campaign listing (GET Campaigns.pl): programme/campaign listing.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Campaigns_pl.html
 *
 * --- IMPORTANT DIVERGENCE FROM THE CANONICAL TYPES ----------------------------
 *
 * The Adservice public, self-serve reporting API (Statistics.pl) returns
 * AGGREGATED statistics grouped by a dimension — NOT row-level conversions or
 * individual click events.
 *
 *   - `listTransactions` maps each aggregate statistics row (grouped by campaign
 *     and date) to a Transaction whose `commission` is that group's summed
 *     earnings and `status` reflects pending vs. settled. These are SUMMARY rows,
 *     not individual sales. BLOCKED(verify): whether a row-level conversion
 *     endpoint exists in the publisher API could not be confirmed (the docs host
 *     returns HTTP 403 to automated fetches).
 *   - `listClicks` throws NotImplementedError: Statistics.pl exposes aggregate
 *     click COUNTS only; no row-level click-event endpoint (with per-click
 *     timestamp/referrer) is documented in the accessible public API. Returning
 *     fabricated per-click rows would violate "never invent data".
 *   - `generateTrackingLink` throws NotImplementedError: the deeplink/redirect
 *     URL format is not documented in any accessible public source.
 *
 * These gaps are recorded in META.knownLimitations and capabilitiesCheck.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `adserviceRequest`.
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

import { adserviceRequest, STATISTICS_PATH, CAMPAIGNS_PATH } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireCredentials } from './auth.js';
import { setupSteps } from './setup.js';
import { NotImplementedError, NetworkError, buildErrorEnvelope } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
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

const log = createLogger('adservice.adapter');

const SLUG = 'adservice';
const NAME = 'Adservice';

/** Fallback currency used only when a row carries no currency at all. */
const FALLBACK_CURRENCY = 'EUR';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.adservice.com/cgi-bin/publisher/API',
  authModel: 'custom',
  docsUrl: 'https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Authentication uses a UID and a LoginToken supplied as cookies on every request, obtained via /Account.pl/loginToken; auth_model is "custom". The login exchange shape is BLOCKED(verify) — the documentation host returns HTTP 403 to automated fetches, so the adapter takes UID and LoginToken as configured credentials.',
    'The Statistics.pl reporting endpoint returns AGGREGATE statistics grouped by a dimension (campaign, date, etc.), not row-level conversions. listTransactions maps each aggregate group to a summary Transaction (summed commission, pending vs. settled status); it does not return individual sales. Whether a row-level conversion endpoint exists is BLOCKED(verify).',
    'listClicks throws NotImplementedError: Statistics.pl exposes aggregate click counts only; no row-level click-event endpoint (per-click timestamp/referrer) is documented in the accessible public API.',
    'generateTrackingLink throws NotImplementedError: the deeplink/redirect URL format is not documented in any accessible public source.',
    'Exact Statistics.pl / Campaigns.pl response field names and the precise base host (api.adservice.com vs publisher.adservice.com) are inferred from public docs and third-party guides; BLOCKED(verify) against a live account. Every field is read defensively and the verbatim payload is preserved in rawNetworkData.',
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
// Adservice raw response shapes (defensive — every field optional)
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: the exact Statistics.pl field set is not confirmable
// from the accessible public documentation. We read several plausible synonyms
// for each concept and preserve the original under `rawNetworkData`.

interface AdserviceStatRowRaw {
  // Identity / grouping
  camp_id?: string | number;
  campid?: string | number;
  campaign_id?: string | number;
  camp_title?: string;
  campaign?: string;
  title?: string;
  // Date dimension (depends on group_by/period)
  stamp?: string;
  date?: string;
  day?: string;
  monthyear?: string;
  year?: string | number;
  // Metrics
  earnings?: number | string;
  earning?: number | string;
  revenue?: number | string;
  commission?: number | string;
  pending?: number | string; // sum of pending conversions when showPending=1
  pending_earnings?: number | string;
  clicks?: number | string;
  total_clicks?: number | string;
  leads?: number | string;
  conversions?: number | string;
  sale?: number | string;
  sales?: number | string;
  order_value?: number | string;
  // Currency
  currency?: string;
  cur?: string;
}

interface AdserviceStatisticsResponse {
  // The docs describe statistics grouped by a dimension; the array key is not
  // confirmable. We probe several plausible container keys defensively.
  statistics?: AdserviceStatRowRaw[];
  stats?: AdserviceStatRowRaw[];
  data?: AdserviceStatRowRaw[];
  rows?: AdserviceStatRowRaw[];
  result?: AdserviceStatRowRaw[];
}

interface AdserviceCampaignRaw {
  camp_id?: string | number;
  campid?: string | number;
  campaign_id?: string | number;
  id?: string | number;
  camp_title?: string;
  campaign?: string;
  title?: string;
  name?: string;
  status?: string;
  state?: string;
  currency?: string;
  url?: string;
  campaign_url?: string;
  category?: string;
  categories?: string[];
  country?: string;
  country_id?: string | number;
}

interface AdserviceCampaignsResponse {
  campaigns?: AdserviceCampaignRaw[];
  programs?: AdserviceCampaignRaw[];
  data?: AdserviceCampaignRaw[];
  rows?: AdserviceCampaignRaw[];
  result?: AdserviceCampaignRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceRows<T>(...candidates: Array<T[] | undefined>): T[] {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function toCount(v: number | string | undefined): number {
  const n = toAmount(v);
  return Math.max(0, Math.round(n));
}

function firstDefined<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Adservice aggregate statistics row to a canonical TransactionStatus.
 *
 * Statistics.pl does not carry a per-row lifecycle status; it reports settled
 * earnings and, when showPending=1, a separate pending sum. We therefore derive
 * the status from which bucket the row represents:
 *   - a row that carries only pending earnings → 'pending'
 *   - a row that carries settled earnings      → 'approved'
 * The caller (`listTransactions`) sets `isPending` based on which figure it read.
 *
 * Why 'approved' rather than 'paid' for settled earnings: Statistics.pl does not
 * distinguish "approved but not yet paid out" from "paid in a publisher payment",
 * so we choose the more conservative 'approved'. The verbatim figures are
 * preserved in `rawNetworkData`.
 */
function mapAggregateStatus(isPending: boolean): TransactionStatus {
  return isPending ? 'pending' : 'approved';
}

/**
 * Map an Adservice campaign status string to the canonical ProgrammeStatus.
 *
 * BLOCKED(verify): the exact status vocabulary is not confirmable from the
 * accessible docs. We map the obvious values and default to 'unknown'.
 *
 *   active / live / approved / joined → 'joined'
 *   pending / applied                 → 'pending'
 *   declined / rejected               → 'declined'
 *   available / open / notjoined      → 'available'
 *   paused / suspended / closed       → 'suspended'
 *   anything else / absent            → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string; state?: string }): ProgrammeStatus {
  const s = (firstDefined(raw.status, raw.state) ?? '').toString().toLowerCase().trim();
  if (s === 'active' || s === 'live' || s === 'approved' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'applied') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'open' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'closed') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

function rowCampaignId(raw: AdserviceStatRowRaw): string {
  return String(firstDefined(raw.camp_id, raw.campid, raw.campaign_id) ?? '');
}

function rowCampaignName(raw: AdserviceStatRowRaw): string {
  const id = rowCampaignId(raw);
  return (
    firstDefined(raw.camp_title, raw.campaign, raw.title) ??
    (id ? `Adservice campaign ${id}` : 'Adservice campaign')
  );
}

function rowDate(raw: AdserviceStatRowRaw): string | undefined {
  return nullableIso(
    firstDefined(raw.stamp, raw.date, raw.day, raw.monthyear, raw.year ? String(raw.year) : undefined),
  );
}

/**
 * Compute the age (in days) of an aggregate statistics row at response time.
 * PRD §15.9 — the unpaid-age affordance depends on this. The only anchor an
 * aggregate row carries is its period/date. When absent, age is 0.
 */
function computeAgeDays(raw: AdserviceStatRowRaw, now: Date = new Date()): number {
  const anchor = rowDate(raw);
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Map an aggregate statistics row to a summary Transaction.
 *
 * `isPending` selects which figure the row represents (pending vs. settled). The
 * `id` is synthesised from campaign + date + bucket because aggregate rows have
 * no natural transaction id. The verbatim row is preserved in `rawNetworkData`.
 */
function toTransaction(
  raw: AdserviceStatRowRaw,
  opts: { isPending: boolean; now?: Date },
): Transaction {
  const now = opts.now ?? new Date();
  const status = mapAggregateStatus(opts.isPending);
  const commission = opts.isPending
    ? toAmount(firstDefined(raw.pending, raw.pending_earnings))
    : toAmount(firstDefined(raw.earnings, raw.earning, raw.revenue, raw.commission));
  const sale = toAmount(firstDefined(raw.sale, raw.sales, raw.order_value));
  const currency = (firstDefined(raw.currency, raw.cur) ?? FALLBACK_CURRENCY).toString().toUpperCase();
  const dateConverted = rowDate(raw) ?? new Date(0).toISOString();
  const campaignId = rowCampaignId(raw);
  const bucket = opts.isPending ? 'pending' : 'settled';
  const id = `${campaignId || 'campaign'}:${dateConverted}:${bucket}`;

  return {
    id,
    network: SLUG,
    programmeId: campaignId,
    programmeName: rowCampaignName(raw),
    status,
    amount: sale,
    currency,
    commission,
    dateConverted,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toProgramme(raw: AdserviceCampaignRaw): Programme {
  const id = String(firstDefined(raw.camp_id, raw.campid, raw.campaign_id, raw.id) ?? '');
  const name = firstDefined(raw.camp_title, raw.campaign, raw.title, raw.name) ?? (id ? `Adservice campaign ${id}` : 'Adservice campaign');
  const categories = Array.isArray(raw.categories)
    ? raw.categories
    : raw.category
      ? [raw.category]
      : undefined;
  const programme: Programme = {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  const currency = firstDefined(raw.currency);
  if (currency) programme.currency = currency.toUpperCase();
  const advertiserUrl = firstDefined(raw.url, raw.campaign_url);
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  if (categories) programme.categories = categories;
  return programme;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdserviceAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the publisher's campaigns (programmes) via Campaigns.pl.
   *
   * BLOCKED(verify): the exact Campaigns.pl path, parameters, and response fields
   * are inferred from the public docs index; they have not been confirmed against
   * a live account. Every field is read defensively.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const credentials = requireCredentials('listProgrammes');

    const response = await adserviceRequest<AdserviceCampaignsResponse>({
      operation: 'listProgrammes',
      path: CAMPAIGNS_PATH,
      credentials,
      query: {},
      resilience: RESILIENCE.default,
    });

    const rawCampaigns = coerceRows(
      response.campaigns,
      response.programs,
      response.data,
      response.rows,
      response.result,
    );

    let programmes = rawCampaigns.map(toProgramme);

    // Client-side filters — Campaigns.pl filter params are unconfirmed, so we
    // filter on the normalised result.
    const statusFilter = toProgrammeStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single campaign by id. Adservice's Campaigns.pl is a listing
   * endpoint; we list and filter rather than assume a single-resource path.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the Adservice campaign id (camp_id).',
        }),
      );
    }
    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Adservice campaign found with id "${programmeId}".`,
          hint: 'Confirm the campaign id via listProgrammes.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Adservice earnings as summary Transactions over a date window.
   *
   * IMPORTANT: Statistics.pl returns AGGREGATE statistics, not row-level
   * conversions. We request the rows grouped by campaign + date (group_by=stamp)
   * with showPending=1 so both settled and pending earnings are present, then
   * emit one Transaction per (campaign, date) for the settled figure and, where
   * a pending figure exists, a second 'pending' Transaction. See the file header
   * for the BLOCKED(verify) note on row-level data.
   *
   * Statistics.pl endpoint:
   *   GET /Statistics.pl/?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
   *     &group_by=stamp&showPending=1 [&camp_id=N]
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   * `query.minAgeDays` / `maxAgeDays` filter on the computed `ageDays` (anchored
   * on the row's period date), applied after status filtering.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const credentials = requireCredentials('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      from_date: from.toISOString().slice(0, 10),
      to_date: to.toISOString().slice(0, 10),
      group_by: 'stamp',
      showPending: 1,
    };
    if (query?.programmeId) {
      params['camp_id'] = query.programmeId;
    }

    const response = await adserviceRequest<AdserviceStatisticsResponse>({
      operation: 'listTransactions',
      path: STATISTICS_PATH,
      credentials,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawRows = coerceRows(
      response.statistics,
      response.stats,
      response.data,
      response.rows,
      response.result,
    );

    const transactions: Transaction[] = [];
    for (const r of rawRows) {
      // Always emit the settled figure as an 'approved' transaction.
      transactions.push(toTransaction(r, { isPending: false, now }));
      // Emit a separate 'pending' transaction when a pending figure is present.
      const pending = toAmount(firstDefined(r.pending, r.pending_earnings));
      if (pending > 0) {
        transactions.push(toTransaction(r, { isPending: true, now }));
      }
    }

    let result = transactions;

    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      result = result.filter((t) => set.has(t.status));
    }

    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') {
      result = result.filter((t) => t.ageDays >= minAge);
    }
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') {
      result = result.filter((t) => t.ageDays <= maxAge);
    }

    if (typeof query?.limit === 'number') {
      result = result.slice(0, query.limit);
    }

    log.debug({ count: result.length }, 'listTransactions complete');
    return result;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * We derive from `listTransactions` (one source of truth) rather than calling a
   * separate aggregated report; the per-transaction `ageDays` is needed anyway to
   * compute `oldestUnpaidAgeDays`.
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
      currency: FALLBACK_CURRENCY,
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
          programmeName: t.programmeName || `Adservice campaign ${key}`,
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
      currency: firstCurrency ?? FALLBACK_CURRENCY,
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
   * Adservice's Statistics.pl exposes aggregate click COUNTS, not individual
   * click events. The canonical Click type requires per-event records (timestamp,
   * referrer, destination); no row-level click-event endpoint is documented in
   * the accessible public publisher API.
   *
   * We throw NotImplementedError rather than returning an empty array or
   * fabricating per-click rows — the difference between "no clicks" and "clicks
   * not exposed at row level" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Adservice exposes aggregate click counts via Statistics.pl but no row-level click-event ' +
        'endpoint (per-click timestamp/referrer); listClicks is not supported. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Adservice's deeplink/redirect URL format is not documented in any accessible
   * public source, so a deterministic link cannot be constructed without
   * inventing the URL shape. We throw NotImplementedError rather than guess.
   *
   * BLOCKED(verify): confirm the tracking-link format against a live account;
   * if the campaign listing returns a per-campaign tracking URL, this could be
   * implemented by reading it from listProgrammes.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Adservice tracking-link construction is not documented in any accessible public source; ' +
        'the deeplink format could not be confirmed (BLOCKED(verify)). generateTrackingLink is not supported.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials with a minimal Statistics.pl read.
   *
   * On success: returns { ok: true, identity }.
   * On failure: returns { ok: false, reason }. Never throws — verifyAuth is
   * called by error handlers.
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
   * Probe each operation with a minimal call. listClicks and generateTrackingLink
   * are known-unsupported and are recorded without probing.
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
        const r = await fn();
        const sampleSize = Array.isArray(r) ? r.length : 1;
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
      note: 'Adservice exposes aggregate click counts only; no row-level click-event endpoint.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Tracking-link format is not documented in any accessible public source (BLOCKED(verify)).',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe(
      'listProgrammes',
      () => this.listProgrammes({ limit: 1 }),
      'Campaigns.pl shape is BLOCKED(verify) against a live account.',
    );
    await probe('getProgramme', async () => {
      const list = await this.listProgrammes({ limit: 1 });
      const first = list[0];
      if (!first) return list;
      return this.getProgramme(first.id);
    });
    await probe(
      'listTransactions',
      () => this.listTransactions({ limit: 1 }),
      'Rows are aggregate statistics summaries, not row-level conversions (BLOCKED(verify)).',
    );
    await probe('getEarningsSummary', () => this.getEarningsSummary({}));

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

export const adserviceAdapter = new AdserviceAdapter();
registerAdapter(adserviceAdapter);

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
  mapAggregateStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toAmount,
  toCount,
  firstDefined,
  rowCampaignId,
  rowCampaignName,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
