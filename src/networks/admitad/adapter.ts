/**
 * Admitad adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and its OAuth2 sibling `src/networks/skimlinks/adapter.ts`. The
 * load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- Admitad API map -----------------------------------------------------------
 *
 * OAuth2 token endpoint (client_credentials):
 *   POST https://api.admitad.com/token/
 *     Authorization: Basic base64(client_id:client_secret)
 *     grant_type=client_credentials&client_id=...&scope=statistics advcampaigns deeplink_generator private_data
 *   → { access_token, token_type, expires_in, scope }
 *   Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *
 * Data API (base: https://api.admitad.com), paginate as { results, _meta }:
 *   GET /me/                                              scope private_data
 *   GET /statistics/actions/?date_start=DD.MM.YYYY&...    scope statistics
 *   GET /statistics/dates/                                scope statistics
 *   GET /advcampaigns/   GET /advcampaigns/{id}/          scope advcampaigns
 *   GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp=...  scope deeplink_generator
 *   Sources: https://developers.admitad.com/en/doc/api_en/methods/statistics/statistics-actions/
 *            https://developers.admitad.com/en/doc/api_en/methods/advcampaigns/advcampaigns-list/
 *            https://developers.admitad.com/knowledge-base/article/deeplink-generator_1
 *            trezorg/admitad-python-api pyadmitad/items/{statistics,campaigns,me}.py
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `admitadRequest`.
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

import { admitadRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken } from './auth.js';
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

const log = createLogger('admitad.adapter');

const SLUG = 'admitad';
const NAME = 'Admitad';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.admitad.com',
  authModel: 'oauth2',
  docsUrl: 'https://developers.admitad.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listClicks is not exposed for publishers via the public Admitad API; the publisher reports surface only aggregated statistics (statistics/actions, statistics/dates), so the operation throws NotImplementedError.',
    "listProgrammes / getProgramme are mapped from /advcampaigns/ and require the OAuth scope 'advcampaigns'. Admitad's programme connection status is per-website; the adapter reports the campaign-level status it can read and preserves the raw payload in rawNetworkData.",
    'generateTrackingLink calls the Admitad deeplink generator (GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp=...), which requires the OAuth scope deeplink_generator, a connected ad space, and ADMITAD_WEBSITE_ID. A deeplink can only be generated for a campaign your ad space is connected to; otherwise the API returns an error which surfaces verbatim.',
    "Admitad action statuses are normalised: 'pending' -> pending; 'approved' / 'approved_but_stalled' -> approved; 'declined' -> reversed; the separate payment_status flag (1 = paid) maps to paid. Unknown statuses map to 'other' and the raw value is preserved.",
    'OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry. Cached tokens are lost on process restart.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 15,
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

// Admitad's statistics/actions limit caps at 500 per page (default 20).
// Source: https://developers.admitad.com/knowledge-base/article/limit-offset-parameters_3
const ACTIONS_PAGE_LIMIT = 500;
const MAX_ACTION_PAGES = 50; // hard ceiling so a pathological account can't loop forever

// ---------------------------------------------------------------------------
// Admitad raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Admitad's field set varies across endpoints and over
// time. Treating every field as possibly absent and preserving the original under
// `rawNetworkData` keeps the adapter robust to upstream drift.

interface AdmitadMeta {
  count?: number;
  limit?: number;
  offset?: number;
}

interface AdmitadActionRaw {
  // Confirmed against the statistics/actions documentation and the Python
  // wrapper. Live verification against a real account is required before bumping
  // claim_status to 'partial'.
  action_id?: string | number;
  advcampaign_id?: string | number;
  advcampaign_name?: string;
  status?: string; // pending | approved | approved_but_stalled | declined
  payment?: number | string; // commission to the publisher
  cart?: number | string; // gross order/cart amount
  currency?: string;
  click_date?: string;
  action_date?: string; // when the action occurred (conversion)
  closing_date?: string; // when the action was confirmed/closed
  status_updated?: string;
  // payment_status: 0 = not yet paid to publisher, 1 = paid.
  payment_status?: number | string;
  comment?: string; // reason / note (e.g. why declined)
  subid?: string;
  order_id?: string | number;
}

interface AdmitadActionsResponse {
  results?: AdmitadActionRaw[];
  _meta?: AdmitadMeta;
}

interface AdmitadCampaignRaw {
  id?: string | number;
  name?: string;
  status?: string; // active | suspended | ...
  // connection_status reflects the publisher's relationship with the campaign.
  connection_status?: string; // active | pending | declined | ...
  currency?: string;
  site_url?: string;
  categories?: Array<{ name?: string }>;
  // Some Admitad payloads expose a parametrised commission description.
  max_payment?: string;
  raw_payment?: string;
}

interface AdmitadCampaignsResponse {
  results?: AdmitadCampaignRaw[];
  _meta?: AdmitadMeta;
}

interface AdmitadDeeplinkResponse {
  // The deeplink generator returns an array of generated links.
  results?: string[];
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Admitad action to the canonical TransactionStatus.
 *
 * Admitad status (+ payment_status) → canonical:
 *   payment_status == 1                         → 'paid'     (paid out to publisher)
 *   declined                                    → 'reversed' (advertiser rejected it)
 *   approved / approved_but_stalled / confirmed → 'approved' (validated, not yet paid)
 *   pending / on_hold                           → 'pending'  (awaiting processing)
 *   anything else                               → 'other'
 *
 * Why payment_status takes priority: an action can be both 'approved' AND already
 * paid out. From the publisher's perspective the most useful canonical state is
 * 'paid' once the money has been disbursed. The verbatim status and payment_status
 * are preserved in `rawNetworkData`.
 *
 * Why 'declined' → 'reversed': from the publisher's perspective a declined action
 * means the sale did not pay out — semantically a reversal, which is what every
 * other network calls this state.
 */
function mapTransactionStatus(raw: AdmitadActionRaw): TransactionStatus {
  if (isPaid(raw)) return 'paid';
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'declined' || s === 'rejected' || s === 'reversed') return 'reversed';
  if (s === 'approved' || s === 'approved_but_stalled' || s === 'confirmed') return 'approved';
  if (s === 'pending' || s === 'on_hold') return 'pending';
  return 'other';
}

function isPaid(raw: AdmitadActionRaw): boolean {
  const ps = raw.payment_status;
  if (ps === undefined || ps === null) return false;
  const n = typeof ps === 'number' ? ps : parseInt(String(ps), 10);
  return n === 1;
}

/**
 * Map an Admitad campaign relationship to the canonical ProgrammeStatus.
 *
 * Admitad exposes a per-campaign `status` (the campaign's own state) and, for
 * the publisher, a `connection_status` (whether this publisher's ad space is
 * connected). We prefer `connection_status` because it answers the user's real
 * question — "am I in this programme?". We default to 'unknown' for any value we
 * cannot confidently map.
 *
 *   active / connected   → 'joined'
 *   pending / moderation → 'pending'
 *   declined / rejected  → 'declined'
 *   not_connected / new  → 'available'
 *   suspended / stopped  → 'suspended'
 *   anything else        → 'unknown'
 */
function mapProgrammeStatus(raw: { connection_status?: string; status?: string }): ProgrammeStatus {
  const s = (raw.connection_status ?? raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'connected' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'moderation' || s === 'on_moderation') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'not_connected' || s === 'new' || s === 'available') return 'available';
  if (s === 'suspended' || s === 'stopped' || s === 'paused') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of an Admitad action at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: closing_date (how long has this been confirmed?) falls back to
 * action_date (conversion date), then click_date. For pending actions, the
 * action_date is the earliest meaningful anchor.
 */
function computeAgeDays(raw: AdmitadActionRaw, now: Date = new Date()): number {
  const anchor = raw.closing_date ?? raw.action_date ?? raw.click_date;
  if (!anchor) return 0;
  const t = parseAdmitadDate(anchor);
  if (t === undefined) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Parse an Admitad timestamp into epoch ms.
 *
 * Admitad's action timestamps are documented as ISO-like
 * "YYYY-MM-DD HH:MM:SS" (space-separated, no timezone marker). `Date.parse`
 * handles the ISO 'T' form; for the space form we substitute a 'T' and treat it
 * as UTC. Returns undefined when the value cannot be parsed.
 */
function parseAdmitadDate(value: string): number | undefined {
  if (!value) return undefined;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const iso = value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = parseAdmitadDate(d);
  return ts === undefined ? undefined : new Date(ts).toISOString();
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function toTransaction(raw: AdmitadActionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.payment);
  const sale = toAmount(raw.cart);
  const currency = (raw.currency ?? 'EUR').toUpperCase();

  const actionDate = nullableIso(raw.action_date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date);
  // closing_date is when the action was confirmed/closed → maps to dateApproved.
  const approvedDate = status === 'approved' || status === 'paid' ? nullableIso(raw.closing_date) : undefined;
  const paidDate = status === 'paid' ? nullableIso(raw.closing_date ?? raw.status_updated) : undefined;

  return {
    id: String(raw.action_id ?? ''),
    network: SLUG,
    programmeId: String(raw.advcampaign_id ?? ''),
    programmeName: raw.advcampaign_name ?? `Admitad campaign ${raw.advcampaign_id ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: actionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.comment ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: AdmitadCampaignRaw): Programme {
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => c.name).filter((n): n is string => typeof n === 'string')
    : undefined;

  const programme: Programme = {
    id: String(raw.id ?? ''),
    name: raw.name ?? `Admitad campaign ${raw.id ?? ''}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  if (raw.max_payment) programme.commissionRate = raw.max_payment;
  if (categories && categories.length > 0) programme.categories = categories;
  if (raw.site_url) programme.advertiserUrl = raw.site_url;
  return programme;
}

// ---------------------------------------------------------------------------
// Date formatting — Admitad statistics use DD.MM.YYYY
// ---------------------------------------------------------------------------

/**
 * Admitad's statistics endpoints accept date_start / date_end in DD.MM.YYYY form
 * (e.g. date_start=01.01.2011). Source: the client-authorization curl example and
 * the statistics/actions documentation.
 */
function toAdmitadDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdmitadAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the affiliate programmes (advcampaigns) the publisher can see.
   *
   *   GET /advcampaigns/?limit=N&offset=M   (scope advcampaigns)
   *   Response: { results: [...], _meta: { count, limit, offset } }
   *
   * Filtering by status / search is applied client-side after normalisation,
   * because Admitad's campaign filter parameters do not map cleanly onto our
   * canonical ProgrammeStatus.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = await getAccessToken();

    const params: Record<string, string | number | undefined> = {
      limit: typeof query?.limit === 'number' ? Math.min(query.limit, ACTIONS_PAGE_LIMIT) : ACTIONS_PAGE_LIMIT,
      offset: 0,
    };

    const response = await admitadRequest<AdmitadCampaignsResponse>({
      operation: 'listProgrammes',
      path: '/advcampaigns/',
      token,
      query: params,
      resilience: RESILIENCE.default,
    });

    const rawCampaigns: AdmitadCampaignRaw[] = Array.isArray(response.results) ? response.results : [];
    let programmes = rawCampaigns.map(toProgramme);

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
   * Fetch a single programme (advcampaign) by id.
   *
   *   GET /advcampaigns/{id}/   (scope advcampaigns)
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the numeric Admitad campaign id.',
        }),
      );
    }

    const token = await getAccessToken();
    const raw = await admitadRequest<AdmitadCampaignRaw>({
      operation: 'getProgramme',
      path: `/advcampaigns/${encodeURIComponent(programmeId)}/`,
      token,
      resilience: RESILIENCE.default,
    });

    return toProgramme(raw);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Admitad actions (conversions) across a date window with optional
   * status / age / programme filters.
   *
   *   GET /statistics/actions/?date_start=DD.MM.YYYY&date_end=DD.MM.YYYY
   *       [&advcampaign={campaignId}][&limit=N&offset=M]   (scope statistics)
   *   Response: { results: [...], _meta: { count, limit, offset } }
   *
   * Pagination: Admitad uses limit/offset (max limit 500). We page through using
   * _meta.count up to a hard ceiling so we return the full window the caller
   * asked for rather than one page.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *   `query.minAgeDays` / `maxAgeDays` filter on the computed `ageDays`, applied
   *   after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *   Declined actions (`status: declined`) normalise to 'reversed' and their
   *   `comment` surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = await getAccessToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const baseParams: Record<string, string | number | undefined> = {
      date_start: toAdmitadDate(from),
      date_end: toAdmitadDate(to),
    };
    if (query?.programmeId) {
      baseParams['advcampaign'] = query.programmeId;
    }

    // Page through the window. Admitad returns _meta.count = total matching rows.
    const rawActions: AdmitadActionRaw[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_ACTION_PAGES; page += 1) {
      const response = await admitadRequest<AdmitadActionsResponse>({
        operation: 'listTransactions',
        path: '/statistics/actions/',
        token,
        query: { ...baseParams, limit: ACTIONS_PAGE_LIMIT, offset },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      const pageResults = Array.isArray(response.results) ? response.results : [];
      rawActions.push(...pageResults);

      const total = response._meta?.count;
      offset += ACTIONS_PAGE_LIMIT;
      if (pageResults.length === 0) break;
      if (typeof total === 'number' && offset >= total) break;
    }

    let transactions = rawActions.map((r) => toTransaction(r, now));

    // Canonical status filter — applied client-side after normalisation, since
    // payment_status (paid) and 'approved_but_stalled' do not map onto a single
    // server-side status value.
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate actions into an earnings summary.
   *
   * We derive from `listTransactions` for the same reason as Awin: a dedicated
   * reports endpoint would be a second source of truth for the same data, and
   * we still need the per-transaction `ageDays` to compute `oldestUnpaidAgeDays`.
   * One source.
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
      currency: 'EUR',
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
          programmeName: t.programmeName || `Admitad campaign ${key}`,
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
      currency: firstCurrency ?? 'EUR',
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
   * Admitad does not expose click-level records to publishers via the public API.
   * The publisher reporting surface offers only aggregated statistics
   * (statistics/actions = conversions, statistics/dates = daily rollups); there
   * is no per-click feed.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Admitad does not expose click-level data to publishers via the public API; only aggregated statistics (statistics/actions, statistics/dates) are available.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Generate an Admitad deeplink via the deeplink generator API.
   *
   *   GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp={encoded destination}
   *   (scope deeplink_generator)
   *   Response: { results: ["https://ad.admitad.com/goto/..."] }
   *
   * Unlike Skimlinks/Awin, Admitad deeplinks are NOT deterministic: the goto
   * token is minted server-side and is scoped to the publisher's ad space and the
   * specific campaign. A deeplink can only be generated for a campaign the ad
   * space is connected to; otherwise the API returns an error, which surfaces
   * verbatim through the envelope. We therefore make the API call rather than
   * constructing a URL locally.
   *
   * Inputs are validated before the call: a non-empty destinationUrl and a
   * programmeId (the campaign id), plus the configured ADMITAD_WEBSITE_ID.
   *
   * Source: https://developers.admitad.com/knowledge-base/article/deeplink-generator_1
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the advertiser page you want to link to.',
        }),
      );
    }
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'programmeId (Admitad campaign id) is required.',
          hint: 'Admitad deeplinks are minted per campaign; pass the numeric campaign id your ad space is connected to.',
        }),
      );
    }

    const websiteId = requireCredential('ADMITAD_WEBSITE_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint: 'Set ADMITAD_WEBSITE_ID (your ad space / website id) in ~/.affiliate-mcp/.env. The deeplink generator is scoped to one ad space.',
    });
    const token = await getAccessToken();

    const response = await admitadRequest<AdmitadDeeplinkResponse>({
      operation: 'generateTrackingLink',
      path: `/deeplink/${encodeURIComponent(websiteId)}/advcampaign/${encodeURIComponent(input.programmeId)}/`,
      token,
      query: { ulp: input.destinationUrl },
      resilience: RESILIENCE.default,
    });

    const trackingUrl = Array.isArray(response.results) ? response.results[0] : undefined;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          networkErrorBody: JSON.stringify(response),
          message: 'Admitad deeplink generator returned no link.',
          hint: 'Confirm your ad space (ADMITAD_WEBSITE_ID) is connected to this campaign and the deeplink_generator scope is enabled.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: response,
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by obtaining an OAuth2 access token (and reading /me/).
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
   * listClicks is known-unsupported and recorded without probing to avoid wasting
   * a network call.
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

    operations['listClicks'] = {
      supported: false,
      note: 'Admitad does not expose click-level data to publishers via the public API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    // getProgramme and generateTrackingLink need a real id we do not have here;
    // record them as supported-with-caveat (their endpoints are exercised by the
    // operations above / the unit tests) without an unscoped live probe.
    operations['getProgramme'] = {
      supported: true,
      note: 'Mapped from GET /advcampaigns/{id}/ (scope advcampaigns); not probed here as it needs a specific campaign id.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Calls the deeplink generator (scope deeplink_generator); not probed here as it needs a campaign your ad space is connected to.',
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

export const admitadAdapter = new AdmitadAdapter();
registerAdapter(admitadAdapter);

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
  parseAdmitadDate,
  toAdmitadDate,
  toTransaction,
  toProgramme,
  toAmount,
  isPaid,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
