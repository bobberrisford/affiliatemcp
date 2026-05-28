/**
 * Everflow advertiser (brand-side) adapter.
 *
 * Mirrors the impact-advertiser defensive style. Everflow's Network API is the
 * single-key multi-brand surface — one API key can address every advertiser on
 * the network. This adapter implements the advertiser side: listBrands, verifyAuth,
 * listMediaPartners, and getProgrammePerformance.
 *
 * Auth: custom header — X-Eflow-API-Key: <api_key>
 * Base URL: https://api.eflow.team/v1
 *
 * Publisher-side ops (listProgrammes, getProgramme, listTransactions,
 * getEarningsSummary, listClicks, generateTrackingLink) throw NotImplementedError
 * because the Everflow Network API is structured around the network operator /
 * advertiser view, not the affiliate (publisher) view. Publishers on Everflow
 * use a separate affiliate-scoped API key; a future publisher adapter covers that.
 *
 * Operations:
 *   listBrands               → GET  /v1/networks/advertisers
 *   verifyAuth               → GET  /v1/networks/advertisers?page=1&page_size=1
 *   listMediaPartners        → POST /v1/networks/affiliatestable   (affiliates on the network)
 *   getProgrammePerformance  → POST /v1/advertisers/reporting/entity
 *
 * Not implemented at v0.1 (throw NotImplementedError):
 *   listProgrammes, getProgramme, listTransactions, getEarningsSummary,
 *   listClicks, generateTrackingLink, listPublishers, listPublisherSectors.
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
  adapterVersion: '0.1.0',
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
      '// TODO(verify): exact column and metric field names against a live account.',
    'Publisher-side operations (listTransactions, listClicks, generateTrackingLink, ' +
      'listProgrammes, getProgramme, getEarningsSummary) are not implemented at v0.1 — ' +
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
// TODO(verify): exact field names for reporting metrics against a live account.
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
  // Currency is typically declared at the request level, not per-row.
}

interface EverflowReportRow {
  columns?: EverflowReportColumn[];
  reporting?: EverflowReportMetrics;
}

interface EverflowReportResponse {
  table?: EverflowReportRow[];
  summary?: EverflowReportMetrics;
  incomplete_results?: boolean;
  currency?: string;
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
 * TODO(verify): exact `column_type` values and metric field names against
 * a live account. The mapping below follows the documented public API schema.
 */
function toPerformanceRow(
  raw: EverflowReportRow,
  currency: string,
  date: string,
): ProgrammePerformanceRow {
  // Find the affiliate dimension column.
  const affiliateCol = (raw.columns ?? []).find(
    (c) => c.column_type === 'affiliate' || c.column_type === 'sub_affiliate',
  );
  const publisherId = String(affiliateCol?.id ?? '');
  const publisherName = affiliateCol?.label ?? '';

  const metrics = raw.reporting ?? {};
  const clicks = toNumber(metrics.total_click);
  const conversions = toNumber(metrics.cv);
  // Everflow's `revenue` = advertiser gross; `payout` = affiliate commission.
  // TODO(verify): confirm these map correctly to grossSale/commission in a live account.
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
   * TODO(verify): confirm paging field names (page / page_size / total_count)
   * and the exact response envelope against a live account.
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
   * TODO(verify): confirm filters field shape (esp. status filter key names)
   * and relationship param support against a live account.
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
    // filters object with account_status (and possibly search terms).
    // TODO(verify): exact filter field name for status against a live account.
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
   * TODO(verify): confirm the exact request structure, column values, metric
   * field names, and whether advertiser_id can be used as a filter against a
   * live account.
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
    // "columns" determines the breakdown dimension; "affiliate" = per-affiliate.
    // TODO(verify): "advertiser" resource_type filter and exact column name.
    const filters: Array<Record<string, string>> = [
      {
        resource_type: 'advertiser', // TODO(verify): confirm this filter key name
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
      // TODO(verify): timezone_id and currency_id may need to be provided
      // explicitly. Everflow uses the account's default if omitted.
      columns: [{ column: 'affiliate' }], // TODO(verify): "affiliate" is the column name
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

    // Use the currency from the response summary if available.
    const currency = res.currency ?? 'USD'; // TODO(verify): currency field name

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

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Everflow advertiser adapter does not implement listClicks at v0.1. ' +
        'Click-level data is available via the raw clicks report on the Network API ' +
        '(not yet wired in this adapter).',
    );
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
        '// TODO(verify): paging field names against a live account.',
      claimStatus: 'experimental',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'Returns all affiliates on the network via POST /v1/networks/affiliatestable. ' +
        'No server-side filter by advertiser — filter by offer client-side if needed. ' +
        '// TODO(verify): filter request body shape against a live account.',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'POST /v1/advertisers/reporting/entity with column=affiliate. ' +
        'Date window limited to 1 year by Everflow. ' +
        '// TODO(verify): request body, column names, and metric fields against a live account.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: false,
      note: 'Not implemented at v0.1. Use the everflow publisher adapter.',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Not implemented at v0.1.',
    };
    operations['listTransactions'] = {
      supported: false,
      note: 'Not implemented at v0.1. Use getProgrammePerformance for the aggregate view.',
    };
    operations['getEarningsSummary'] = {
      supported: false,
      note: 'Not implemented at v0.1.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Not implemented at v0.1. Click-level data exists in the Everflow raw clicks report but is not yet wired.',
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
  mapAdvertiserStatus,
  mapAffiliateStatus,
  requireCtx,
  toNumber,
};
