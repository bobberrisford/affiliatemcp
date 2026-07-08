/**
 * Kwanko advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. The brand-side twin of the publisher Kwanko adapter
 * (`src/networks/kwanko/`): same single-token Bearer auth and the same
 * defensive transformer style, but the operations address the advertiser's own
 * campaigns and the publishers running on them. Read the Impact advertiser
 * adapter (`src/networks/impact-advertiser/`) for the canonical advertiser
 * chassis (ctx threading, requireCtx, read-only client guard); this file
 * documents only the Kwanko-specific decisions.
 *
 * The adapter receives a `ctx?: AdapterCallContext` from the tool dispatcher
 * carrying `networkBrandId` (the Kwanko campaign / programme id for whichever
 * logical brand the caller asked about). Brand-scoped operations REQUIRE the
 * context — without it we cannot address a campaign. We throw a `config_error`
 * envelope rather than guessing.
 *
 * --- Kwanko advertiser API map -------------------------------------------------
 *
 * Base URL: https://api.kwanko.com  (Bearer token in the Authorization header)
 *   Sources: https://developers.kwanko.com/ ;
 *            https://helpdesk-advertiser.kwanko.com/ (advertiser API: retrieve
 *            your statistics and conversions);
 *            dltHub Kwanko source config (base_url, bearer auth, resources
 *            "conversions" + "statistics").
 *
 *   GET /advertiser/campaigns     list the advertiser's campaigns (programmes)
 *       ?page={n}&per_page={size}  (1-based page loop until a short page)
 *   GET /advertiser/conversions   conversions (leads / sales / downloads)
 *       ?debut=YYYY-MM-DD&fin=YYYY-MM-DD&camp={campaignId}
 *   GET /advertiser/statistics    aggregated stats by campaign, website
 *       (publisher), and date range (clicks, conversions, spending, bonuses)
 *       ?debut=YYYY-MM-DD&fin=YYYY-MM-DD&camp={campaignId}&group=website
 *
 * BLOCKED(verify): developers.kwanko.com and the advertiser help desk return
 * HTTP 403 to automated fetch, so the exact path segments, query-parameter
 * names, the per-publisher grouping parameter, and JSON field names above are
 * taken from public summaries of the Kwanko advertiser API. The adapter reads
 * every field defensively and preserves the verbatim payload in
 * `rawNetworkData`. A live-account test is required before promoting beyond
 * `experimental`.
 *
 * --- Operation coverage --------------------------------------------------------
 *
 *   listBrands             → /advertiser/campaigns (one brand per campaign the
 *                            token addresses)
 *   verifyAuth             → reuses the auth.ts statistics probe
 *   listProgrammes         → /advertiser/campaigns (brand-scoped to ctx campaign;
 *                            pages to completion on absent limit, capped at
 *                            MAX_PAGES with a logged warning)
 *   listTransactions       → /advertiser/conversions (brand-scoped)
 *   getProgrammePerformance→ /advertiser/statistics grouped by website (publisher)
 *   getProgramme / getEarningsSummary / listClicks / generateTrackingLink
 *                          → NotImplementedError
 *   listPublishers / listPublisherSectors → NotImplementedError
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. NEVER call fetch directly. Use `kwankoAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings; "programme", not "program".
 *   5. NEVER issue a non-GET request. The client enforces this; the adapter
 *      must not work around it.
 *   6. Read credentials via `requireToken` — NEVER process.env (except in tests).
 */

import { kwankoAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireToken, SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DiscoveredBrand,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
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

const log = createLogger('kwanko-advertiser.adapter');
const NAME = 'Kwanko (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.kwanko.com',
  authModel: 'bearer',
  docsUrl: 'https://developers.kwanko.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a read-only Kwanko API token for defence in depth.',
    'Exact endpoint paths, query-parameter names, and JSON field names are taken from public summaries of the Kwanko advertiser API (https://developers.kwanko.com/ and https://helpdesk-advertiser.kwanko.com/); the developer reference is not machine-readable, so field mapping is defensive and must be confirmed against a live response.',
    'getProgrammePerformance is built from the advertiser statistics endpoint grouped by website (publisher); the grouping parameter name is BLOCKED(verify) until confirmed against a live response.',
    'listBrands enumerates the advertiser campaigns the token addresses; there is no documented account-enumeration endpoint, so each addressable campaign is returned as a brand.',
    'listProgrammes pages /advertiser/campaigns (1-based page + per_page) until a short page and is capped at MAX_PAGES with a logged warning rather than a silent truncation; the paging parameter names are BLOCKED(verify) against a live response.',
    'generateTrackingLink, getProgramme, getEarningsSummary, and listClicks are publisher-side or unsupported on the advertiser surface and throw NotImplementedError.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

const HEAVY_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // conversions + statistics over wider windows can take a while; same
  // rationale as the publisher adapter's listTransactions profile.
  listTransactions: HEAVY_RESILIENCE,
  getProgrammePerformance: HEAVY_RESILIENCE,
};

/**
 * Campaign page size and the pagination backstop for listProgrammes. The page
 * loop stops on the first short page; MAX_PAGES is a backstop logged so a
 * truncated pull is never silent (principle 4.1). Same pattern as the Tolt and
 * Tapfiliate adapters.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Helpers — ctx
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on brand-scoped operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing — this can happen if a
 * future caller bypasses the tool dispatcher.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Kwanko advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Kwanko campaign id) via brands.json. Call `affiliate_resolve_brand` ' +
          'to see which brands are bound.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Kwanko advertiser raw response shapes (deliberately minimal + defensive)
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: the Kwanko developer reference is not machine-
// readable, so field names are not certain. Treating every field as possibly
// absent and preserving the original under `rawNetworkData` keeps the adapter
// robust to the real wire shape. BLOCKED(verify) against a live response.

interface KwankoAdvCampaignRaw {
  id?: string | number;
  campaign_id?: string | number;
  name?: string;
  title?: string;
  status?: string;
  state?: string;
  currency?: string;
  url?: string;
  site_url?: string;
  // Some summaries flag whether the campaign is API-addressable / live.
  api_enabled?: boolean | string;
  active?: boolean | string;
}

interface KwankoAdvCampaignsResponse {
  data?: KwankoAdvCampaignRaw[];
  campaigns?: KwankoAdvCampaignRaw[];
  items?: KwankoAdvCampaignRaw[];
}

interface KwankoAdvConversionRaw {
  id?: string | number;
  conversion_id?: string | number;
  campaign_id?: string | number;
  campaign_name?: string;
  status?: string;
  state?: string;
  amount?: number | string; // gross sale / order amount
  commission?: number | string; // commission paid to the publisher
  currency?: string;
  click_date?: string;
  conversion_date?: string;
  date?: string;
  validation_date?: string;
  payment_date?: string;
  reason?: string;
  refusal_reason?: string;
  // Publisher (website) association on the advertiser surface.
  site_id?: string | number;
  website_id?: string | number;
  publisher_id?: string | number;
  site_name?: string;
  website?: string;
  publisher_name?: string;
}

interface KwankoAdvConversionsResponse {
  data?: KwankoAdvConversionRaw[];
  conversions?: KwankoAdvConversionRaw[];
  items?: KwankoAdvConversionRaw[];
}

interface KwankoAdvStatRow {
  // Date dimension — daily where present, else monthly.
  date?: string;
  day?: string;
  month?: string;
  // Publisher (website) dimension.
  site_id?: string | number;
  website_id?: string | number;
  publisher_id?: string | number;
  site_name?: string;
  website?: string;
  publisher_name?: string;
  // Metrics.
  clicks?: string | number;
  conversions?: string | number;
  sales?: string | number;
  amount?: string | number;
  turnover?: string | number;
  commission?: string | number;
  spending?: string | number;
  currency?: string;
  status?: string;
  state?: string;
}

interface KwankoAdvStatsResponse {
  data?: KwankoAdvStatRow[];
  statistics?: KwankoAdvStatRow[];
  stats?: KwankoAdvStatRow[];
  items?: KwankoAdvStatRow[];
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Kwanko conversion status string to the canonical TransactionStatus.
 *
 * Kwanko status → canonical (semantics from public docs; exact strings
 * BLOCKED(verify) against a live response):
 *   waiting / pending / open       → 'pending'  (awaiting validation)
 *   validated / confirmed          → 'approved' (validated, not yet paid)
 *   paid / settled                 → 'paid'     (included in a payment)
 *   refused / cancelled / rejected → 'reversed' (did not pay out)
 *   anything else                  → 'other'
 */
function mapTransactionStatus(raw: { status?: string; state?: string }): TransactionStatus {
  const s = (raw.status ?? raw.state ?? '').toLowerCase().trim();
  if (s === 'pending' || s === 'waiting' || s === 'open' || s === 'wait') return 'pending';
  if (s === 'validated' || s === 'confirmed' || s === 'approved' || s === 'valid') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'refused' || s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'reversed')
    return 'reversed';
  return 'other';
}

/**
 * Map a Kwanko advertiser campaign relationship to the canonical
 * ProgrammeStatus. Default to 'unknown' for anything we cannot map.
 */
function mapProgrammeStatus(raw: { status?: string; state?: string }): ProgrammeStatus {
  const s = (raw.status ?? raw.state ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'open' || s === 'running' || s === 'live' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'waiting') return 'pending';
  if (s === 'refused' || s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'not_joined' || s === 'notjoined') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'closed' || s === 'stopped') return 'suspended';
  return 'unknown';
}

/**
 * Map a Kwanko statistics row status to the 3-value performance status. Rows
 * without a status default to 'pending' (Impact/CJ convention): an aggregate
 * stat with no explicit validation state is "not yet approved".
 */
function mapPerformanceStatus(raw: { status?: string; state?: string }): ProgrammePerformanceRow['status'] {
  const s = (raw.status ?? raw.state ?? '').toLowerCase().trim();
  if (s === 'validated' || s === 'confirmed' || s === 'approved' || s === 'paid' || s === 'settled')
    return 'approved';
  if (s === 'refused' || s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'reversed')
    return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function toNumber(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toBool(v: boolean | string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  return fallback;
}

/**
 * Compute the age (in days) of a Kwanko conversion at response time.
 * Anchor priority: validation_date → conversion_date → date → click_date.
 */
function computeAgeDays(raw: KwankoAdvConversionRaw, now: Date = new Date()): number {
  const anchor = raw.validation_date ?? raw.conversion_date ?? raw.date ?? raw.click_date;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: KwankoAdvCampaignRaw): Programme {
  const programme: Programme = {
    id: String(raw.id ?? raw.campaign_id ?? ''),
    name: raw.name ?? raw.title ?? `Kwanko campaign ${raw.id ?? raw.campaign_id ?? ''}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  const advertiserUrl = raw.url ?? raw.site_url;
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  return programme;
}

function toTransaction(raw: KwankoAdvConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.commission);
  const sale = toNumber(raw.amount);
  const currency = (raw.currency ?? 'EUR').toUpperCase();

  const transactionDate = nullableIso(raw.conversion_date ?? raw.date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date);
  const approvedDate = nullableIso(raw.validation_date);
  const paidDate = nullableIso(raw.payment_date);

  return {
    id: String(raw.id ?? raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign_id ?? ''),
    programmeName: raw.campaign_name ?? `Kwanko campaign ${raw.campaign_id ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.refusal_reason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toPerformanceRow(raw: KwankoAdvStatRow): ProgrammePerformanceRow {
  // Normalise the date down to yyyy-mm-dd (or yyyy-mm).
  const rawDate = raw.date ?? raw.day ?? raw.month ?? '';
  let date = '';
  if (rawDate) {
    const iso = nullableIso(rawDate);
    if (iso) {
      date = iso.slice(0, 10);
    } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(rawDate)) {
      date = rawDate;
    }
  }

  const publisherId = String(raw.site_id ?? raw.website_id ?? raw.publisher_id ?? '');
  const publisherName = raw.site_name ?? raw.website ?? raw.publisher_name ?? '';

  return {
    date,
    publisherId,
    publisherName,
    clicks: toNumber(raw.clicks),
    conversions: toNumber(raw.conversions ?? raw.sales),
    grossSale: toNumber(raw.amount ?? raw.turnover),
    commission: toNumber(raw.commission ?? raw.spending),
    currency: (raw.currency ?? 'EUR').toUpperCase(),
    status: mapPerformanceStatus(raw),
    rawNetworkData: raw,
  };
}

function toDiscoveredBrand(raw: KwankoAdvCampaignRaw): DiscoveredBrand {
  const id = String(raw.id ?? raw.campaign_id ?? '');
  // Default apiEnabled to true; only flip to false when a field explicitly says so.
  const apiEnabled = toBool(raw.api_enabled ?? raw.active, true);
  return {
    networkBrandId: id,
    displayName: raw.name ?? raw.title ?? `Kwanko campaign ${id}`,
    apiEnabled,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class KwankoAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the advertiser's campaigns the token addresses, one DiscoveredBrand
   * per campaign. The Kwanko advertiser API has no documented account-level
   * enumeration endpoint, so the campaign list IS the brand list.
   *
   * BLOCKED(verify): the collection key (`data` / `campaigns` / `items`) and the
   * api-enabled flag name are taken from public summaries; read defensively.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const token = requireToken('listBrands');
    const response = await kwankoAdvRequest<KwankoAdvCampaignsResponse>({
      operation: 'listProgrammes',
      path: '/advertiser/campaigns',
      token,
      query: { per_page: 1000 },
      resilience: RESILIENCE.default,
    });
    const raw = pickCampaignArray(response);
    return raw.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth — reuse the auth.ts statistics probe.
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — the brand's campaign(s), scoped to ctx.
  // -------------------------------------------------------------------------

  /**
   * List the advertiser's campaigns, scoped to the resolved campaign id. We
   * pull the campaign list and filter to `ctx.networkBrandId` client-side so
   * the result is correct regardless of whether the live API supports a
   * server-side single-campaign filter.
   *
   * Pagination: pages /advertiser/campaigns with a 1-based `page` and
   * `per_page` = PAGE_SIZE until the first short page. On absent `query.limit`
   * the pull runs to completion, capped at MAX_PAGES with a logged warning so
   * a truncated result is never silent. With an explicit limit the loop stops
   * once at least that many raw campaigns are in hand (never fewer than the
   * pre-pagination single request returned).
   *
   * BLOCKED(verify): collection key + filter/paging parameter names taken from
   * public summaries.
   */
  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const token = requireToken('listProgrammes');

    const raw: KwankoAdvCampaignRaw[] = [];
    let page = 1;
    for (;;) {
      const response = await kwankoAdvRequest<KwankoAdvCampaignsResponse>({
        operation: 'listProgrammes',
        path: '/advertiser/campaigns',
        token,
        query: { camp: c.networkBrandId, page, per_page: PAGE_SIZE },
        resilience: RESILIENCE.default,
      });
      const batch = pickCampaignArray(response);
      raw.push(...batch);
      // A short (or empty) page means the upstream list is exhausted.
      if (batch.length < PAGE_SIZE) break;
      // Backward-compatible early stop: an explicit limit is satisfied once
      // at least that many raw campaigns are collected.
      if (typeof query?.limit === 'number' && raw.length >= query.limit) break;
      if (page >= MAX_PAGES) {
        log.warn(
          { operation: 'listProgrammes', cap: MAX_PAGES, fetched: raw.length },
          'kwanko-advertiser pagination hit MAX_PAGES cap; result may be truncated',
        );
        break;
      }
      page += 1;
    }

    let programmes = raw.map(toProgramme);

    // Scope to the resolved campaign id — the brand context IS the campaign.
    programmes = programmes.filter((p) => p.id === c.networkBrandId);

    const statusFilter = toProgrammeStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — the brand's conversions, scoped to ctx.
  // -------------------------------------------------------------------------

  /**
   * List Kwanko advertiser conversions across a date window for the resolved
   * campaign. Defaults to a 30-day window when none is specified. Status, age,
   * and programme filtering are applied client-side on the normalised canonical
   * status so the result is correct regardless of the upstream vocabulary.
   *
   * BLOCKED(verify): the date parameter names (`debut`/`fin`) and the campaign
   * filter (`camp`) are taken from public summaries of the advertiser stats API.
   */
  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const token = requireToken('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const response = await kwankoAdvRequest<KwankoAdvConversionsResponse>({
      operation: 'listTransactions',
      path: '/advertiser/conversions',
      token,
      query: {
        debut: from.toISOString().slice(0, 10),
        fin: to.toISOString().slice(0, 10),
        camp: c.networkBrandId,
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const raw = pickConversionArray(response);
    let transactions = raw.map((r) => toTransaction(r, now));

    // Scope to the resolved campaign — also client-side in case the upstream
    // filter param name differs from our guess.
    transactions = transactions.filter((t) => !t.programmeId || t.programmeId === c.networkBrandId);

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    if (typeof query?.minAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher rollup from statistics.
  // -------------------------------------------------------------------------

  /**
   * Uses the advertiser statistics endpoint grouped by website (publisher). The
   * Kwanko statistics API aggregates by campaign, website, and date range; we
   * request the website grouping for the resolved campaign so each row is one
   * publisher's metrics.
   *
   * BLOCKED(verify): the grouping parameter name (`group=website`) and the
   * metric field names are taken from public summaries; confirm against a live
   * response. Rows preserve the verbatim payload in `rawNetworkData`.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const token = requireToken('getProgrammePerformance');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const response = await kwankoAdvRequest<KwankoAdvStatsResponse>({
      operation: 'getProgrammePerformance',
      path: '/advertiser/statistics',
      token,
      query: {
        debut: from.toISOString().slice(0, 10),
        fin: to.toISOString().slice(0, 10),
        camp: query?.programmeId ?? c.networkBrandId,
        group: 'website',
      },
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    const raw = pickStatArray(response);
    let rows = raw.map(toPerformanceRow);

    if (query?.publisherId) {
      rows = rows.filter((r) => r.publisherId === query.publisherId);
    }

    // Stable order: by date ascending then publisherId.
    rows.sort((a, b) =>
      a.date === b.date ? a.publisherId.localeCompare(b.publisherId) : a.date.localeCompare(b.date),
    );

    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);

    log.debug({ count: rows.length }, 'getProgrammePerformance complete');
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Kwanko advertiser adapter does not implement getProgramme at v0.1; use listProgrammes for the brand campaign.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Kwanko advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Kwanko advertiser adapter does not implement listClicks; the advertiser statistics endpoint reports clicks only as an aggregate, surfaced via getProgrammePerformance.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Kwanko advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use getProgrammePerformance for the advertiser-side per-publisher view; Kwanko has no advertiser publisher-roster endpoint at v0.1.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Kwanko advertiser at v0.1.');
  }

  // -------------------------------------------------------------------------
  // Setup + diagnostics
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};
    operations['verifyAuth'] = {
      supported: true,
      note: 'Statistics probe runs at wizard time; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Enumerates the advertiser campaigns the token addresses, one brand per campaign. Endpoint shape BLOCKED(verify) against a live account.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Advertiser campaigns scoped to the resolved campaign id; collection key BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'Advertiser conversions for the resolved campaign; date/campaign param names BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Advertiser statistics grouped by website (publisher); grouping param + metric field names BLOCKED(verify) against a live response.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = {
      supported: false,
      note: 'Kwanko reports clicks only as an aggregate in statistics, surfaced via getProgrammePerformance.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Publisher-side operation; not applicable to advertiser adapter.',
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

export const kwankoAdvertiserAdapter = new KwankoAdvertiserAdapter();
registerAdapter(kwankoAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function pickCampaignArray(response: KwankoAdvCampaignsResponse): KwankoAdvCampaignRaw[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.campaigns)) return response.campaigns;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function pickConversionArray(response: KwankoAdvConversionsResponse): KwankoAdvConversionRaw[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.conversions)) return response.conversions;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function pickStatArray(response: KwankoAdvStatsResponse): KwankoAdvStatRow[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.statistics)) return response.statistics;
  if (Array.isArray(response.stats)) return response.stats;
  if (Array.isArray(response.items)) return response.items;
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

// Silence unused-import lint when noUnusedLocals is on.
void log;

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  // Pagination knobs + logger, exported so tests can build exact-size pages
  // and assert the MAX_PAGES warning without a real network.
  PAGE_SIZE,
  MAX_PAGES,
  log,
  mapTransactionStatus,
  mapProgrammeStatus,
  mapPerformanceStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toPerformanceRow,
  toDiscoveredBrand,
  toNumber,
  pickCampaignArray,
  pickConversionArray,
  pickStatArray,
};
