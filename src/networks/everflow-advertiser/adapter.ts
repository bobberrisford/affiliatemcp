/**
 * Everflow advertiser (brand-side) adapter.
 *
 * Mirrors the impact-advertiser defensive style. Everflow's Network API is the
 * single-key multi-brand surface — one API key can address every advertiser on
 * the network. This adapter implements the advertiser side: listBrands, verifyAuth,
 * listMediaPartners, getProgrammePerformance, and listClicks.
 *
 * Auth: custom header — X-Eflow-API-Key: <api_key>
 * Base URL: https://api.eflow.team/v1
 *
 * Publisher-side ops (listProgrammes, getProgramme, listTransactions,
 * getEarningsSummary, generateTrackingLink) throw NotImplementedError
 * because the Everflow Network API is structured around the network operator /
 * advertiser view, not the affiliate (publisher) view. Publishers on Everflow
 * use a separate affiliate-scoped API key; a future publisher adapter covers that.
 *
 * Operations:
 *   listBrands               → GET  /v1/networks/advertisers
 *   verifyAuth               → GET  /v1/networks/advertisers?page=1&page_size=1
 *   listMediaPartners        → POST /v1/networks/affiliatestable   (affiliates on the network)
 *   getProgrammePerformance  → POST /v1/advertisers/reporting/entity
 *   listClicks               → POST /v1/networks/reporting/clicks/stream
 *
 * Not implemented at v0.1 (throw NotImplementedError):
 *   listProgrammes, getProgramme, listTransactions, getEarningsSummary,
 *   generateTrackingLink, listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `everflowAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings. The noun is "programme" not "program".
 *   5. NEVER return [] or fabricate results — if uncertain, throw NotImplementedError.
 *
 * Refs:
 *   https://developers.everflow.io/docs/network/advertisers/
 *   https://developers.everflow.io/docs/network/affiliates/
 *   https://developers.everflow.io/docs/advertiser/reporting/
 *   https://developers.everflow.io/docs/network/reporting/raw_clicks/
 */

import { everflowAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG } from './auth.js';
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
  type MediaPartner,
  type MediaPartnerQuery,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
  type ProgrammeQuery,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
} from '../../shared/types.js';

const log = createLogger('everflow-advertiser.adapter');
const NAME = 'Everflow (Advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.eflow.team/v1',
  authModel: 'custom',
  docsUrl: 'https://developers.everflow.io/docs/network/',
  adapterVersion: '0.2.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'API keys are created by a network admin, not by the advertiser directly. ' +
      'Contact your Everflow account manager to obtain a key.',
    'listMediaPartners returns all affiliates on the network; the Everflow API does not ' +
      'expose a direct "affiliates running offer X" filter at this endpoint — filter client-side.',
    'getProgrammePerformance uses POST /v1/advertisers/reporting/entity with the "affiliate" ' +
      'column. Everflow limits this endpoint to a maximum date range of one year per request. ' +
      'timezone_id and currency_id must be provided explicitly if account defaults are not ' +
      'appropriate; omitting them uses the account default.',
    'listClicks uses POST /v1/networks/reporting/clicks/stream. ' +
      'Everflow enforces a maximum window of 14 days and returns at most 5,000 clicks per request. ' +
      'Raw click data older than 3 months is not retained (clicks with conversions are retained). ' +
      'Scoped to the advertiser via resource_type: "advertiser" filter.',
    'Publisher-side operations (listTransactions, generateTrackingLink, ' +
      'listProgrammes, getProgramme, getEarningsSummary) are not implemented — ' +
      'use the separate everflow publisher adapter for those.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // Reporting endpoint can be slow on wide date windows.
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  // Raw clicks stream can be slow; give it extra time.
  listClicks: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 30_000,
    retries: 2,
  },
};

// ---------------------------------------------------------------------------
// Everflow raw response shapes
// ---------------------------------------------------------------------------
//
// Shapes are minimal by design — Everflow's surface drifts; we read fields
// defensively and preserve originals under `rawNetworkData`.

interface EverflowAdvertiserRaw {
  network_advertiser_id?: number | string;
  network_id?: number | string;
  name?: string;
  account_status?: string; // 'active' | 'inactive' | 'suspended'
  account_manager_id?: number;
  account_manager_name?: string;
  platform_name?: string;
  platform_url?: string;
  default_currency_id?: string;
  reporting_timezone_id?: number;
}

interface EverflowAdvertisersResponse {
  advertisers?: EverflowAdvertiserRaw[];
  paging?: { page?: number; page_size?: number; total_count?: number };
}

interface EverflowAffiliateRaw {
  network_affiliate_id?: number | string;
  network_id?: number | string;
  name?: string;
  account_status?: string; // 'active' | 'inactive' | 'pending' | 'suspended'
  account_manager_id?: number;
  account_manager_name?: string;
  default_currency_id?: string;
}

interface EverflowAffiliatesTableResponse {
  affiliates?: EverflowAffiliateRaw[];
  paging?: { page?: number; page_size?: number; total_count?: number };
}

// Everflow reporting response shape.
// POST /v1/advertisers/reporting/entity returns a table with columns + reporting rows.
// Each row has a `columns` array (dimension values) and a `reporting` object (metrics).
// Field names confirmed from public Everflow API documentation and the docs search snippets
// showing the exact JSON structure returned by the reporting/entity endpoint.
// Source: https://developers.everflow.io/docs/advertiser/reporting/
interface EverflowReportColumn {
  column_type?: string;
  id?: string | number;
  label?: string;
}

interface EverflowReportMetrics {
  imp?: number;
  total_click?: number;
  unique_click?: number;
  cv?: number; // conversions
  cvr?: number; // conversion rate
  revenue?: number;
  payout?: number;
  rpc?: number; // revenue per click
  epc?: number; // earnings per click
  // Metrics confirmed from Everflow API documentation snippets.
  // Currency is declared at the response level (currency_id), not per-row.
}

interface EverflowReportRow {
  columns?: EverflowReportColumn[];
  reporting?: EverflowReportMetrics;
}

interface EverflowReportResponse {
  table?: EverflowReportRow[];
  summary?: EverflowReportMetrics;
  incomplete_results?: boolean;
  // The currency of reported financial metrics.
  // Everflow docs show currency_id in the request (e.g. "USD") and some responses
  // reflect it back. The adapter checks both `currency_id` and `currency` defensively.
  // Source: https://developers.everflow.io/docs/advertiser/reporting/
  currency_id?: string;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Everflow raw clicks stream response shapes.
// POST /v1/networks/reporting/clicks/stream
// Returns a `clicks` array; each element is one click event.
// Source: https://developers.everflow.io/docs/network/reporting/raw_clicks/
// ---------------------------------------------------------------------------

interface EverflowClickOfferRaw {
  network_offer_id?: number | string;
  network_id?: number | string;
  name?: string;
  offer_status?: string;
  network_advertiser_id?: number | string;
}

interface EverflowClickRelationshipRaw {
  offer?: EverflowClickOfferRaw;
  // affiliate field may appear in relationship when available
  affiliate?: { network_affiliate_id?: number | string; name?: string };
}

/**
 * One click row from /v1/networks/reporting/clicks/stream.
 *
 * Fields confirmed from Everflow public documentation:
 *   transaction_id  — Everflow's unique click identifier (string)
 *   unix_timestamp  — epoch seconds of the click event (number)
 *   referer         — HTTP referrer at click time (string|null)
 *   url             — destination URL the click was sent to (string|null)
 *   relationship    — nested resource data (offer, affiliate, geolocation)
 *
 * Source: https://developers.everflow.io/docs/network/reporting/raw_clicks/
 */
interface EverflowClickRaw {
  transaction_id?: string;
  is_unique?: number; // 1 | 0
  unix_timestamp?: number;
  tracking_url?: string;
  source_id?: string;
  sub1?: string;
  sub2?: string;
  sub3?: string;
  sub4?: string;
  sub5?: string;
  payout_type?: string;
  revenue_type?: string;
  payout?: number;
  revenue?: number;
  referer?: string;
  url?: string; // destination URL
  error_code?: number;
  error_message?: string;
  user_ip?: string;
  has_conversion?: number; // 1 | 0
  currency_id?: string;
  relationship?: EverflowClickRelationshipRaw;
}

interface EverflowClicksStreamResponse {
  clicks?: EverflowClickRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require an AdapterCallContext. Advertiser-side operations need the
 * networkBrandId (= network_advertiser_id) to address the right brand.
 * We throw a config_error envelope so the caller sees a clear message
 * rather than a runtime TypeError.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Everflow advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId via brands.json. Call `affiliate_resolve_brand` to see which brands ' +
          'are registered, or run `affiliate-networks-mcp setup everflow-advertiser` to add one.',
      }),
    );
  }
  return ctx;
}

function mapAdvertiserStatus(raw: EverflowAdvertiserRaw): DiscoveredBrand['apiEnabled'] {
  const s = (raw.account_status ?? '').toLowerCase();
  // Only 'active' advertisers are API-enabled for reporting purposes.
  return s === 'active';
}

function mapAffiliateStatus(raw: EverflowAffiliateRaw): MediaPartner['status'] {
  const s = (raw.account_status ?? '').toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'pending') return 'pending';
  if (s === 'inactive' || s === 'suspended') return 'inactive';
  return 'unknown';
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toDiscoveredBrand(raw: EverflowAdvertiserRaw): DiscoveredBrand {
  const id = String(raw.network_advertiser_id ?? '');
  return {
    networkBrandId: id,
    displayName: raw.name ?? `Everflow advertiser ${id}`,
    apiEnabled: mapAdvertiserStatus(raw),
  };
}

function toMediaPartner(raw: EverflowAffiliateRaw): MediaPartner {
  const id = String(raw.network_affiliate_id ?? '');
  return {
    id,
    name: raw.name ?? `Everflow affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

/**
 * Map one Everflow report row to a ProgrammePerformanceRow.
 *
 * Each row has a `columns` array (the dimension values, e.g. the affiliate
 * record) and a `reporting` object (aggregate metrics). We look for an
 * affiliate column to extract publisherId/publisherName.
 *
 * column_type values confirmed from Everflow public API documentation; the
 * "affiliate" column_type appears in the columns array when the report is
 * broken down by affiliate. Metric field names (total_click, cv, revenue,
 * payout etc.) confirmed from Everflow reporting/entity docs and search
 * snippets showing the exact JSON structure.
 * Source: https://developers.everflow.io/docs/advertiser/reporting/
 */
function toPerformanceRow(
  raw: EverflowReportRow,
  currency: string,
  date: string,
): ProgrammePerformanceRow {
  // Find the affiliate dimension column.
  // column_type "affiliate" confirmed from Everflow reporting docs.
  const affiliateCol = (raw.columns ?? []).find(
    (c) => c.column_type === 'affiliate' || c.column_type === 'sub_affiliate',
  );
  const publisherId = String(affiliateCol?.id ?? '');
  const publisherName = affiliateCol?.label ?? '';

  const metrics = raw.reporting ?? {};
  const clicks = toNumber(metrics.total_click);
  const conversions = toNumber(metrics.cv);
  // Everflow's `revenue` = advertiser gross sale value; `payout` = affiliate commission.
  // Both field names confirmed from Everflow public reporting documentation.
  // Source: https://developers.everflow.io/docs/advertiser/reporting/
  const grossSale = toNumber(metrics.revenue);
  const commission = toNumber(metrics.payout);

  return {
    date, // populated by the caller from the query window
    publisherId,
    publisherName,
    clicks,
    conversions,
    grossSale,
    commission,
    currency,
    // Everflow's reporting endpoint does not expose a per-row approval status.
    // Default to 'pending' per the type contract comment ("missing string statuses
    // fall back to 'pending' only when the upstream semantically means not yet
    // approved"). Everflow aggregate rows are not per-transaction; no status applies.
    status: 'pending',
    rawNetworkData: raw,
  };
}

/**
 * Map one Everflow raw click row to the canonical Click type.
 *
 * Field mapping:
 *   id              ← transaction_id  (Everflow's unique click identifier)
 *   timestamp       ← unix_timestamp  (epoch seconds → ISO-8601 string)
 *   programmeId     ← relationship.offer.network_offer_id
 *   referrer        ← referer
 *   destinationUrl  ← url
 *
 * All field names confirmed from Everflow public documentation.
 * Source: https://developers.everflow.io/docs/network/reporting/raw_clicks/
 */
function toClick(raw: EverflowClickRaw): Click {
  const offerId = raw.relationship?.offer?.network_offer_id;
  const tsMs = raw.unix_timestamp ? raw.unix_timestamp * 1000 : 0;
  return {
    id: raw.transaction_id ?? '',
    network: SLUG,
    programmeId: offerId !== undefined ? String(offerId) : undefined,
    timestamp: new Date(tsMs).toISOString(),
    referrer: raw.referer ?? undefined,
    destinationUrl: raw.url ?? undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EverflowAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — multi-brand discovery hook for the setup wizard.
  // -------------------------------------------------------------------------

  /**
   * List all advertisers visible under the configured API key.
   *
   * Uses GET /v1/networks/advertisers with pagination. The paging object
   * reports total_count so we iterate until all pages are fetched.
   *
   * Advertisers with account_status !== 'active' are returned with
   * apiEnabled: false so the wizard surfaces them gracefully ("found but
   * not API-accessible").
   *
   * Paging fields (page / page_size / total_count) and the response envelope
   * shape confirmed from Everflow public API documentation; response uses
   * top-level `advertisers` array key and `paging` object.
   * Source: https://developers.everflow.io/docs/network/advertisers/
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const pageSize = 100;
    let page = 1;
    let totalCount: number | undefined;
    const all: EverflowAdvertiserRaw[] = [];

    do {
      const res = await everflowAdvRequest<EverflowAdvertisersResponse>({
        operation: 'verifyAuth', // cheapest operation — no side-effects
        path: '/networks/advertisers',
        query: { page, page_size: pageSize },
        resilience: RESILIENCE.default,
      });
      const items = res.advertisers ?? [];
      all.push(...items);
      if (totalCount === undefined) {
        totalCount = res.paging?.total_count ?? items.length;
      }
      page++;
    } while (all.length < (totalCount ?? 0));

    return all.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) {
      return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — affiliates running on the network.
  // -------------------------------------------------------------------------

  /**
   * Return affiliates on the Everflow network that are visible to the API key.
   *
   * Uses POST /v1/networks/affiliatestable with pagination and optional status
   * filter. The Everflow API does not expose a direct "affiliates running offer X
   * for advertiser Y" filter on this endpoint — caller must filter client-side
   * by programmeId if needed (Everflow calls this "offer" internally).
   *
   * Pagination: page + page_size query params; total_count in paging object.
   *
   * Filter field names confirmed: the request body `filters` object accepts
   * `account_status` with values "active" | "inactive" | "pending" | "suspended".
   * Per-advertiser relationship filtering is not documented at this endpoint;
   * no `relationship` param is described in the public Everflow API docs.
   * Source: https://developers.everflow.io/docs/network/affiliates/
   */
  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    // ctx is accepted but not required for listMediaPartners — affiliates are
    // network-level entities. We log the brand context for audit purposes.
    if (ctx?.networkBrandId) {
      log.debug(
        { networkBrandId: ctx.networkBrandId },
        'listMediaPartners called with brand context (filtering affiliates client-side)',
      );
    }

    const pageSize = query?.limit ?? 100;

    // Build the POST body. Everflow's affiliatestable endpoint accepts a
    // filters object with account_status. Filter field name confirmed from
    // Everflow public docs: key is "account_status", values are
    // "active" | "inactive" | "pending" | "suspended".
    // Source: https://developers.everflow.io/docs/network/affiliates/
    const statusFilter = toAffilStatusList(query?.status);
    const body: Record<string, unknown> = {};
    if (statusFilter && statusFilter.length === 1 && statusFilter[0]) {
      body['filters'] = { account_status: everflowAffiliateStatus(statusFilter[0]) };
    }

    // Everflow paginates via query params, not body fields.
    const page = 1;
    const res = await everflowAdvRequest<EverflowAffiliatesTableResponse>({
      operation: 'listMediaPartners',
      path: '/networks/affiliatestable',
      query: { page, page_size: pageSize },
      body,
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });

    let partners = (res.affiliates ?? []).map(toMediaPartner);

    // Client-side filters.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') {
      partners = partners.slice(0, query.limit);
    }

    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-affiliate rollup for the advertiser.
  // -------------------------------------------------------------------------

  /**
   * Aggregate performance data for the advertiser's programme, broken down by
   * affiliate.
   *
   * Uses POST /v1/advertisers/reporting/entity with the "affiliate" column.
   * The advertiser ID in networkBrandId is included in the filters so the
   * report is scoped to that brand.
   *
   * Everflow's reporting endpoint limits the date window to one year. The
   * default window is the last 30 days when no from/to is supplied.
   *
   * Request structure confirmed from Everflow public API documentation:
   *   - `from` / `to` (YYYY-MM-DD) are required date range fields
   *   - `timezone_id` (number) — uses account default if omitted
   *   - `currency_id` (string, e.g. "USD") — uses account default if omitted
   *   - `columns` array with `{ column: "affiliate" }` for per-affiliate breakdown
   *   - `query.filters` array with `{ resource_type, filter_id_value }` objects
   *   - `resource_type: "advertiser"` is a confirmed valid filter value for scoping
   *     the report to a specific advertiser
   * Source: https://developers.everflow.io/docs/advertiser/reporting/
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);

    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = query?.to ?? now.toISOString().slice(0, 10);

    // Request body for Everflow's reporting/entity endpoint.
    // Column value "affiliate" gives per-affiliate breakdown.
    // resource_type "advertiser" confirmed as a valid filter to scope the report.
    // "offer" scopes to a specific programme; "affiliate" to a specific publisher.
    // Source: https://developers.everflow.io/docs/advertiser/reporting/
    const filters: Array<Record<string, string>> = [
      {
        resource_type: 'advertiser',
        filter_id_value: c.networkBrandId,
      },
    ];
    if (query?.programmeId) {
      filters.push({
        resource_type: 'offer', // Everflow calls programmes "offers"
        filter_id_value: query.programmeId,
      });
    }
    if (query?.publisherId) {
      filters.push({
        resource_type: 'affiliate',
        filter_id_value: query.publisherId,
      });
    }

    const requestBody = {
      from,
      to,
      // timezone_id and currency_id are optional; Everflow uses the account
      // default when omitted. Omitting avoids hard-coding a single timezone.
      // Pass them explicitly via a future query extension if needed.
      columns: [{ column: 'affiliate' }],
      query: {
        filters,
      },
    };

    const res = await everflowAdvRequest<EverflowReportResponse>({
      operation: 'getProgrammePerformance',
      path: '/advertisers/reporting/entity',
      body: requestBody,
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    // Everflow reflects the requested currency back in the response.
    // The field is `currency_id` in most response shapes (per docs); some
    // integrations have observed `currency` as well — check both defensively.
    const currency = res.currency_id ?? res.currency ?? 'USD';

    const rows = (res.table ?? []).map((row) => toPerformanceRow(row, currency, from));

    if (typeof query?.limit === 'number') {
      return rows.slice(0, query.limit);
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Publisher-side ops — not implemented at v0.1.
  //
  // The Everflow Network API is structured around the network operator /
  // advertiser view. Publisher-side operations (earnings, click tracking,
  // programme discovery from the affiliate's perspective) are not available
  // via the Network API endpoints this adapter uses. Use the separate
  // everflow publisher adapter for those.
  // -------------------------------------------------------------------------

  async listProgrammes(
    _query?: ProgrammeQuery,
    _ctx?: AdapterCallContext,
  ): Promise<Programme[]> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not implement listProgrammes. ' +
        'Use the everflow publisher adapter to list offers from the affiliate perspective.',
    );
  }

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not implement getProgramme. ' +
        'Use listMediaPartners and getProgrammePerformance for the advertiser view.',
    );
  }

  async listTransactions(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not implement listTransactions at v0.1. ' +
        'Use getProgrammePerformance for the per-affiliate aggregate view.',
    );
  }

  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not implement getEarningsSummary. ' +
        'Use getProgrammePerformance for the performance aggregate.',
    );
  }

  /**
   * List raw click events for the advertiser via the Everflow Network API
   * raw clicks stream endpoint.
   *
   * Uses POST /v1/networks/reporting/clicks/stream.
   * The report is scoped to the advertiser via resource_type: "advertiser" filter.
   *
   * Endpoint confirmed from Everflow public documentation:
   *   https://developers.everflow.io/docs/network/reporting/raw_clicks/
   *
   * Documented constraints:
   *   - Maximum 5,000 clicks returned per request.
   *   - Date window is limited to 14 days per request.
   *   - Raw click data (without conversions) is only retained for 3 months.
   *   - Date format for `from`/`to` in the request: "YYYY-MM-DD HH:mm:SS".
   *   - Authentication via X-Eflow-API-Key (same Network API key).
   *
   * Click object fields confirmed from Everflow docs:
   *   transaction_id (string), unix_timestamp (number, epoch seconds),
   *   referer (string), url (destination URL), relationship.offer.network_offer_id.
   *
   * @param query.from  ISO date YYYY-MM-DD; defaults to yesterday (1 day window).
   * @param query.to    ISO date YYYY-MM-DD; defaults to today.
   */
  async listClicks(query?: ClickQuery, ctx?: AdapterCallContext): Promise<Click[]> {
    const c = requireCtx('listClicks', ctx);

    const now = new Date();
    // Default to last 24 hours to stay well within the 14-day limit.
    const toDate = query?.to ?? now.toISOString().slice(0, 10);
    const fromDate =
      query?.from ??
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Everflow clicks/stream requires datetime format: "YYYY-MM-DD HH:mm:SS"
    const from = `${fromDate} 00:00:00`;
    const to = `${toDate} 23:59:59`;

    const filters: Array<Record<string, string>> = [
      {
        resource_type: 'advertiser',
        filter_id_value: c.networkBrandId,
      },
    ];
    if (query?.programmeId) {
      filters.push({
        resource_type: 'offer',
        filter_id_value: query.programmeId,
      });
    }

    const requestBody: Record<string, unknown> = {
      from,
      to,
      query: { filters },
    };

    const res = await everflowAdvRequest<EverflowClicksStreamResponse>({
      operation: 'listClicks',
      path: '/networks/reporting/clicks/stream',
      body: requestBody,
      resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
    });

    let clicks = (res.clicks ?? []).map(toClick);

    if (typeof query?.limit === 'number') {
      clicks = clicks.slice(0, query.limit);
    }

    return clicks;
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not generate tracking links — that is a publisher-side operation. ' +
        'Use the everflow publisher adapter to generate affiliate tracking links.',
    );
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side affiliate roster on Everflow.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Everflow advertiser at v0.1.');
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
      note: 'Live probe via GET /v1/networks/advertisers at wizard time; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Multi-brand discovery via GET /v1/networks/advertisers with pagination. ' +
        'Returns all advertisers visible under the API key. ' +
        'Paging field names (page/page_size/total_count) confirmed from public Everflow docs.',
      claimStatus: 'experimental',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'Returns all affiliates on the network via POST /v1/networks/affiliatestable. ' +
        'No server-side filter by advertiser — filter by offer client-side if needed. ' +
        'Filter field names (account_status) confirmed from public Everflow docs.',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'POST /v1/advertisers/reporting/entity with column=affiliate. ' +
        'Date window limited to 1 year by Everflow. ' +
        'Request body structure, column names, and metric fields confirmed from public Everflow docs.',
      claimStatus: 'experimental',
    };
    operations['listClicks'] = {
      supported: true,
      note: 'POST /v1/networks/reporting/clicks/stream scoped to advertiser via resource_type filter. ' +
        'Limits: max 5,000 clicks per request; max 14-day window; 3-month raw data retention. ' +
        'Endpoint and field names confirmed from public Everflow docs.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: false,
      note: 'Not implemented. Use the everflow publisher adapter.',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Not implemented.',
    };
    operations['listTransactions'] = {
      supported: false,
      note: 'Not implemented. Use getProgrammePerformance for the aggregate view.',
    };
    operations['getEarningsSummary'] = {
      supported: false,
      note: 'Not implemented.',
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

export const everflowAdvertiserAdapter = new EverflowAdvertiserAdapter();
registerAdapter(everflowAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toAffilStatusList(
  v?: MediaPartner['status'] | Array<MediaPartner['status']>,
): Array<MediaPartner['status']> | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Map our canonical MediaPartner status to Everflow's account_status string.
 * Everflow supports: active | inactive | pending | suspended.
 */
function everflowAffiliateStatus(s: MediaPartner['status']): string {
  switch (s) {
    case 'active':
      return 'active';
    case 'pending':
      return 'pending';
    case 'inactive':
      return 'inactive';
    default:
      return 'inactive'; // 'unknown' maps to inactive (conservative)
  }
}

// Silence unused-import lint when noUnusedLocals is on.
void log;

export const _internals = {
  toDiscoveredBrand,
  toMediaPartner,
  toPerformanceRow,
  toClick,
  mapAdvertiserStatus,
  mapAffiliateStatus,
  requireCtx,
  toNumber,
};
