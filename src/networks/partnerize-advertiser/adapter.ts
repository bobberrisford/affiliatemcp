/**
 * Partnerize (Advertiser) — brand-side adapter.
 *
 * READ-ONLY at v0.1. Mirrors the Impact advertiser adapter's defensive style;
 * read the Awin adapter (src/networks/awin/adapter.ts) for the full cardinal-
 * rule rationale.
 *
 * Partnerize calls brands "Campaigns" internally. One set of credentials
 * (application_key + user_api_key) may own multiple campaigns. This adapter is
 * multi-brand: `listBrands()` calls GET /v3/brand/campaigns to enumerate the
 * campaigns visible to the credential set, and `ctx.networkBrandId` on each
 * subsequent call carries the campaign_id for the brand the caller asked about.
 *
 * Auth: HTTP Basic — Authorization: Basic base64(application_key:user_api_key).
 * Base URL: https://api.partnerize.com (Brand API v3).
 *
 * The Partnerize Brand API docs site (api-docs.partnerize.com/brand) returned
 * 403 to automated fetch during this PR's research, so several endpoint shapes
 * are marked `// TODO(verify):` and should be confirmed against a live account.
 * Sources used: web-search summaries, Apiary mirrors, and the dltHub context
 * page (all also 403 to automated fetch; the summaries are referenced in
 * docs/findings/partnerize-advertiser.md).
 *
 * Operations implemented:
 *   listBrands             → GET /v3/brand/campaigns
 *   verifyAuth             → same probe as listBrands (limit=1)
 *   listProgrammes         → same as listBrands (brand's own campaigns)
 *   listMediaPartners      → GET /v3/brand/campaigns/{id}/publishers
 *   getProgrammePerformance→ GET /v3/brand/analytics/metrics + campaign filter
 *   listTransactions       → GET /v3/brand/campaigns/{id}/conversions
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme        — use listBrands/listProgrammes and filter client-side
 *   getEarningsSummary  — use getProgrammePerformance for the rollup
 *   listClicks          — click-level data not exposed by the Brand API
 *   generateTrackingLink— publisher-side operation; not applicable here
 *   listPublishers      — admin stub
 *   listPublisherSectors— admin stub
 *
 * Cardinal rules:
 *   1. NEVER call fetch directly. Use `partnerizeAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings. The noun is "programme".
 *   5. NEVER issue a non-GET request. The client enforces this.
 *   6. COMPUTE ageDays for every transaction (PRD §15.9).
 */

import { partnerizeAdvRequest } from './client.js';
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
  type ProgrammeStatus,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('partnerize-advertiser.adapter');
const NAME = 'Partnerize (Advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnerize.com',
  authModel: 'basic',
  docsUrl: 'https://api-docs.partnerize.com/brand/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Click-level data is not exposed by the Partnerize Brand API; listClicks is unsupported.',
    'getProgramme is not implemented at v0.1; use listProgrammes (listBrands) and filter client-side.',
    'getEarningsSummary is not implemented at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    'generateTrackingLink is a publisher-side operation and is not applicable to the advertiser adapter.',
    'Conversion (transaction) reporting scope is per-campaign and requires a campaign_id context from AdapterCallContext.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // Analytics and conversion endpoints can be slow on large windows — give
  // them more time and an extra retry, same rationale as Impact's report engine.
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  listTransactions: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
};

// ---------------------------------------------------------------------------
// Helpers — ctx requirement, raw shapes, status mapping
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. Missing context
 * means the caller forgot to supply a `brand`, which we surface as a
 * `config_error` so the user sees an actionable hint rather than a TypeError.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Partnerize advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (campaign_id) via brands.json. Call `affiliate_resolve_brand` to see ' +
          'which brands are bound, or run `affiliate-networks-mcp setup partnerize-advertiser`.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Partnerize raw response shapes
// ---------------------------------------------------------------------------

/**
 * One campaign entry from GET /v3/brand/campaigns.
 *
 * TODO(verify): exact field names from a live response. The API docs site
 * returned 403 during research; field names are sourced from web-search
 * summaries and Apiary mirror fragments.
 */
interface PartnerizeAdvCampaignRaw {
  campaign_id?: string | number;
  campaign_name?: string;
  // status field may be 'active', 'paused', 'pending', 'closed', etc.
  // TODO(verify): enumerated status values from a live account.
  status?: string;
  currency?: string;
  campaign_reference?: string;
  advertiser_url?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvCampaignsEnvelope {
  campaigns?: PartnerizeAdvCampaignRaw[];
  data?: PartnerizeAdvCampaignRaw[];
  // TODO(verify): pagination envelope fields (total, page, limit, next_cursor, etc.)
  total?: number;
  page?: number;
}

/**
 * One publisher entry from GET /v3/brand/campaigns/{id}/publishers.
 *
 * TODO(verify): exact field names. Partnerize docs call publishers "partners"
 * interchangeably.
 */
interface PartnerizeAdvPublisherRaw {
  publisher_id?: string | number;
  partner_id?: string | number;
  publisher_name?: string;
  partner_name?: string;
  // TODO(verify): status enum values.
  status?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvPublishersEnvelope {
  publishers?: PartnerizeAdvPublisherRaw[];
  partners?: PartnerizeAdvPublisherRaw[];
  data?: PartnerizeAdvPublisherRaw[];
}

/**
 * One conversion row from GET /v3/brand/campaigns/{id}/conversions.
 *
 * TODO(verify): exact field names. The conversions/bulk endpoint is documented
 * at https://api.partnerize.com/v3/brand/campaigns/{campaignID}/conversions/bulk.
 */
interface PartnerizeAdvConversionRaw {
  conversion_id?: string | number;
  publisher_id?: string | number;
  partner_id?: string | number;
  campaign_id?: string | number;
  campaign_name?: string;
  // status: 'approved', 'pending', 'rejected', 'reversed', 'paid', etc.
  // TODO(verify): exact enum values.
  status?: string;
  sale_amount?: string | number;
  commission?: string | number;
  currency?: string;
  // Date fields: ISO 8601 strings.
  // TODO(verify): exact field names (click_time vs click_date, etc.)
  click_time?: string;
  conversion_time?: string;
  approved_at?: string;
  paid_at?: string;
  rejection_reason?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvConversionsEnvelope {
  conversions?: PartnerizeAdvConversionRaw[];
  data?: PartnerizeAdvConversionRaw[];
  total?: number;
}

/**
 * One row from the analytics/metrics endpoint.
 *
 * TODO(verify): exact field names. The endpoint is documented as
 * GET /v3/brand/analytics/metrics but the exact response shape is not
 * publicly confirmed.
 */
interface PartnerizeAdvMetricRowRaw {
  // TODO(verify): date field — may be 'date', 'day', 'period', etc.
  date?: string;
  day?: string;
  publisher_id?: string | number;
  partner_id?: string | number;
  publisher_name?: string;
  partner_name?: string;
  clicks?: string | number;
  conversions?: string | number;
  actions?: string | number;
  sale_amount?: string | number;
  commission?: string | number;
  currency?: string;
  // TODO(verify): status field presence and values.
  status?: string;
  [key: string]: unknown;
}

interface PartnerizeAdvMetricsEnvelope {
  data?: PartnerizeAdvMetricRowRaw[];
  rows?: PartnerizeAdvMetricRowRaw[];
  metrics?: PartnerizeAdvMetricRowRaw[];
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapCampaignStatus(raw: PartnerizeAdvCampaignRaw): ProgrammeStatus {
  const s = String(raw.status ?? '').toLowerCase();
  // TODO(verify): Partnerize campaign status enum values against a live account.
  if (s === 'active' || s === 'live' || s === 'running') return 'joined';
  if (s === 'pending' || s === 'pending_approval') return 'pending';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'closed' || s === 'inactive' || s === 'archived') return 'suspended';
  return 'unknown';
}

function mapConversionStatus(raw: PartnerizeAdvConversionRaw): TransactionStatus {
  const s = String(raw.status ?? '').toLowerCase();
  // TODO(verify): exact Partnerize conversion status values from a live account.
  if (s === 'pending' || s === 'new') return 'pending';
  if (s === 'approved' || s === 'validated' || s === 'accepted') return 'approved';
  if (s === 'rejected' || s === 'reversed' || s === 'cancelled' || s === 'declined') return 'reversed';
  if (s === 'paid') return 'paid';
  return 'other';
}

function mapPublisherStatus(raw: PartnerizeAdvPublisherRaw): MediaPartner['status'] {
  const s = String(raw.status ?? '').toLowerCase();
  // TODO(verify): exact Partnerize publisher status values from a live account.
  if (s === 'active' || s === 'approved' || s === 'live') return 'active';
  if (s === 'pending' || s === 'pending_approval') return 'pending';
  if (s === 'inactive' || s === 'paused' || s === 'declined' || s === 'rejected') return 'inactive';
  return 'unknown';
}

function mapMetricRowStatus(raw: PartnerizeAdvMetricRowRaw): ProgrammePerformanceRow['status'] {
  const s = String(raw.status ?? '').toLowerCase();
  if (s === 'approved' || s === 'validated' || s === 'paid') return 'approved';
  if (s === 'rejected' || s === 'reversed' || s === 'cancelled') return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Number / date coercers
// ---------------------------------------------------------------------------

function toNumber(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  const candidate = input.trim();
  if (candidate === '') return undefined;
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

function computeAgeDays(raw: PartnerizeAdvConversionRaw, now: Date = new Date()): number {
  // Anchor on approved_at first (age of the "approved but unpaid" state —
  // the most useful affordance per PRD §15.9). Fall back to conversion_time.
  const anchor = raw.approved_at ?? raw.conversion_time;
  const parsed = parseDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  const ms = now.getTime() - ts;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: PartnerizeAdvCampaignRaw): Programme {
  const id = String(raw.campaign_id ?? '');
  return {
    id,
    name: raw.campaign_name ?? `Partnerize campaign ${id}`,
    network: SLUG,
    status: mapCampaignStatus(raw),
    currency: typeof raw.currency === 'string' ? raw.currency : undefined,
    advertiserUrl: typeof raw.advertiser_url === 'string' ? raw.advertiser_url : undefined,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: PartnerizeAdvConversionRaw, now: Date = new Date()): Transaction {
  const status = mapConversionStatus(raw);
  const commission = toNumber(raw.commission);
  const sale = toNumber(raw.sale_amount);
  const currency = typeof raw.currency === 'string' ? raw.currency : 'USD';

  const conversionDate = parseDate(raw.conversion_time) ?? new Date(0).toISOString();
  const clickDate = parseDate(raw.click_time);
  const approvedDate = parseDate(raw.approved_at);
  const paidDate = parseDate(raw.paid_at);

  return {
    id: String(raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign_id ?? ''),
    programmeName: typeof raw.campaign_name === 'string' ? raw.campaign_name : '',
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
      status === 'reversed'
        ? (typeof raw.rejection_reason === 'string' ? raw.rejection_reason : undefined)
        : undefined,
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: PartnerizeAdvPublisherRaw): MediaPartner {
  const id = String(raw.publisher_id ?? raw.partner_id ?? '');
  const name =
    (typeof raw.publisher_name === 'string' ? raw.publisher_name : undefined) ??
    (typeof raw.partner_name === 'string' ? raw.partner_name : undefined) ??
    `Partnerize publisher ${id}`;
  return {
    id,
    name,
    status: mapPublisherStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(raw: PartnerizeAdvMetricRowRaw): ProgrammePerformanceRow {
  const rawDate = (typeof raw.date === 'string' ? raw.date : undefined) ??
    (typeof raw.day === 'string' ? raw.day : undefined) ?? '';
  let date = '';
  if (rawDate) {
    const parsed = parseDate(rawDate);
    if (parsed) {
      date = parsed.slice(0, 10);
    } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(rawDate)) {
      date = rawDate;
    }
  }

  const publisherId = String(raw.publisher_id ?? raw.partner_id ?? '');
  const publisherName =
    (typeof raw.publisher_name === 'string' ? raw.publisher_name : undefined) ??
    (typeof raw.partner_name === 'string' ? raw.partner_name : undefined) ??
    '';

  return {
    date,
    publisherId,
    publisherName,
    clicks: toNumber(raw.clicks),
    conversions: toNumber(raw.conversions ?? raw.actions),
    grossSale: toNumber(raw.sale_amount),
    commission: toNumber(raw.commission),
    currency: typeof raw.currency === 'string' ? raw.currency : 'USD',
    status: mapMetricRowStatus(raw),
    rawNetworkData: raw,
  };
}

function toDiscoveredBrand(raw: PartnerizeAdvCampaignRaw): DiscoveredBrand {
  const id = String(raw.campaign_id ?? '');
  const name = raw.campaign_name ?? `Partnerize campaign ${id}`;
  // Partnerize does not expose an explicit apiEnabled flag on campaigns in the
  // public docs fragments; we derive it from status — only active campaigns are
  // usefully addressable.
  // TODO(verify): whether a paused campaign can still be queried for conversions.
  const status = String(raw.status ?? '').toLowerCase();
  const apiEnabled = status === '' || status === 'active' || status === 'live' || status === 'running';
  return {
    networkBrandId: id,
    displayName: typeof name === 'string' ? name : `Partnerize campaign ${id}`,
    apiEnabled,
  };
}

// ---------------------------------------------------------------------------
// List extraction helpers
// ---------------------------------------------------------------------------

function extractCampaigns(
  env: PartnerizeAdvCampaignsEnvelope | PartnerizeAdvCampaignRaw[],
): PartnerizeAdvCampaignRaw[] {
  if (Array.isArray(env)) return env;
  return env.campaigns ?? env.data ?? [];
}

function extractPublishers(
  env: PartnerizeAdvPublishersEnvelope | PartnerizeAdvPublisherRaw[],
): PartnerizeAdvPublisherRaw[] {
  if (Array.isArray(env)) return env;
  return env.publishers ?? env.partners ?? env.data ?? [];
}

function extractConversions(
  env: PartnerizeAdvConversionsEnvelope | PartnerizeAdvConversionRaw[],
): PartnerizeAdvConversionRaw[] {
  if (Array.isArray(env)) return env;
  return env.conversions ?? env.data ?? [];
}

function extractMetricRows(
  env: PartnerizeAdvMetricsEnvelope | PartnerizeAdvMetricRowRaw[],
): PartnerizeAdvMetricRowRaw[] {
  if (Array.isArray(env)) return env;
  return env.data ?? env.rows ?? env.metrics ?? [];
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PartnerizeAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — multi-brand discovery hook.
  // -------------------------------------------------------------------------

  /**
   * List the campaigns (brands) visible to the configured credential set.
   *
   * Calls GET /v3/brand/campaigns and maps each campaign to a DiscoveredBrand.
   * `apiEnabled` is true for active campaigns; paused or closed campaigns are
   * included but marked apiEnabled=false as a hint to the wizard's tick-box UI.
   *
   * TODO(verify): response envelope shape, pagination parameters, and whether
   * paused campaigns can still be queried for conversions against a live account.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvCampaignsEnvelope | PartnerizeAdvCampaignRaw[]
    >({
      operation: 'verifyAuth',
      path: '/v3/brand/campaigns',
      query: { limit: 100 },
      resilience: RESILIENCE.default,
    });
    const list = extractCampaigns(envelope);
    return list.map(toDiscoveredBrand);
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
  // listProgrammes — brand's own campaigns.
  // -------------------------------------------------------------------------

  /**
   * For the advertiser-side adapter, "programmes" are the brand's own campaigns.
   * This is the same data as `listBrands()` but returned as `Programme[]` in
   * the canonical shape.
   *
   * Unlike publisher-side adapters, this does NOT require a `ctx.networkBrandId`
   * (the call lists ALL campaigns for the credential set). A ctx is accepted for
   * interface compatibility but is not used.
   *
   * TODO(verify): pagination parameters (limit/page vs cursor) against a live account.
   */
  async listProgrammes(
    query?: ProgrammeQuery,
    _ctx?: AdapterCallContext,
  ): Promise<Programme[]> {
    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvCampaignsEnvelope | PartnerizeAdvCampaignRaw[]
    >({
      operation: 'listProgrammes',
      path: '/v3/brand/campaigns',
      query: { limit: query?.limit ?? 100 },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });
    const list = extractCampaigns(envelope);
    let programmes = list.map(toProgramme);
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — brand's conversions for a specific campaign.
  // -------------------------------------------------------------------------

  /**
   * Fetch conversions for the campaign identified by `ctx.networkBrandId`.
   *
   * Endpoint: GET /v3/brand/campaigns/{campaign_id}/conversions
   *
   * TODO(verify): query parameter names for date filtering (start_date vs from,
   * end_date vs to) and status filtering from a live account.
   */
  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const now = new Date();

    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvConversionsEnvelope | PartnerizeAdvConversionRaw[]
    >({
      operation: 'listTransactions',
      path: `/v3/brand/campaigns/${encodeURIComponent(c.networkBrandId)}/conversions`,
      query: {
        // TODO(verify): exact date parameter names against a live account.
        start_date: query?.from,
        end_date: query?.to,
        limit: query?.limit ?? 100,
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const list = extractConversions(envelope);
    let txns = list.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      txns = txns.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      txns = txns.filter((t) => set.has(t.status));
    }

    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') {
      txns = txns.filter((t) => t.ageDays >= minAge);
    }
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') {
      txns = txns.filter((t) => t.ageDays <= maxAge);
    }

    if (typeof query?.limit === 'number') txns = txns.slice(0, query.limit);
    return txns;
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — publishers on the brand's campaign.
  // -------------------------------------------------------------------------

  /**
   * Fetch publishers (partners) active on a specific campaign.
   *
   * Endpoint: GET /v3/brand/campaigns/{campaign_id}/publishers
   *
   * TODO(verify): exact path (/publishers vs /partners) and field names from
   * a live Partnerize brand account.
   */
  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const c = requireCtx('listMediaPartners', ctx);

    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvPublishersEnvelope | PartnerizeAdvPublisherRaw[]
    >({
      operation: 'listMediaPartners',
      path: `/v3/brand/campaigns/${encodeURIComponent(c.networkBrandId)}/publishers`,
      query: { limit: query?.limit ?? 100 },
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });

    const list = extractPublishers(envelope);
    let partners = list.map(toMediaPartner);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }

    if (typeof query?.limit === 'number') partners = partners.slice(0, query.limit);
    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — analytics rollup per publisher.
  // -------------------------------------------------------------------------

  /**
   * Fetch per-publisher analytics for the campaign identified by
   * `ctx.networkBrandId` (or a query-specified `programmeId`).
   *
   * Endpoint: GET /v3/brand/analytics/metrics
   *
   * TODO(verify): exact query parameter names (campaign_id, publisher_id,
   * start_date, end_date, granularity) and response envelope shape from a
   * live account. The docs site returned 403 during research.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);

    const envelope = await partnerizeAdvRequest<
      PartnerizeAdvMetricsEnvelope | PartnerizeAdvMetricRowRaw[]
    >({
      operation: 'getProgrammePerformance',
      path: '/v3/brand/analytics/metrics',
      query: {
        // TODO(verify): exact parameter names from a live account.
        campaign_id: query?.programmeId ?? c.networkBrandId,
        publisher_id: query?.publisherId,
        start_date: query?.from,
        end_date: query?.to,
        limit: query?.limit ?? 1000,
      },
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    const rows = extractMetricRows(envelope);
    let mapped = rows.map(toPerformanceRow);
    if (typeof query?.limit === 'number') mapped = mapped.slice(0, query.limit);
    return mapped;
  }

  // -------------------------------------------------------------------------
  // Ops NOT implemented at v0.1 — explicit NotImplementedError with reason.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Partnerize advertiser adapter does not implement getProgramme at v0.1; ' +
        'use listProgrammes to enumerate campaigns and filter client-side.',
    );
  }

  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Partnerize advertiser adapter does not implement getEarningsSummary at v0.1; ' +
        'use getProgrammePerformance for the per-publisher commission rollup.',
    );
  }

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Click-level data is not exposed by the Partnerize Brand API; ' +
        'use getProgrammePerformance for aggregated click counts per publisher.',
    );
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Tracking link generation is a publisher-side operation and is not ' +
        'applicable to the Partnerize advertiser adapter.',
    );
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster on a campaign.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError(
      'listPublisherSectors is not implemented for Partnerize advertiser at v0.1.',
    );
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
      note: 'Live probe runs at wizard time; not re-probed here to avoid network calls during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Multi-brand discovery hook via GET /v3/brand/campaigns.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Returns the credential set\'s campaigns via GET /v3/brand/campaigns.',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'Conversions per campaign via GET /v3/brand/campaigns/{id}/conversions. Requires ctx.networkBrandId.',
      claimStatus: 'experimental',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'Publishers per campaign via GET /v3/brand/campaigns/{id}/publishers. Requires ctx.networkBrandId.',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Analytics via GET /v3/brand/analytics/metrics. Endpoint shape TODO(verify) against a live account.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Not implemented at v0.1; use listProgrammes and filter client-side.',
    };
    operations['getEarningsSummary'] = {
      supported: false,
      note: 'Not implemented at v0.1; use getProgrammePerformance for the rollup.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Click-level data is not exposed by the Partnerize Brand API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Publisher-side operation; not applicable to the advertiser adapter.',
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

export const partnerizeAdvertiserAdapter = new PartnerizeAdvertiserAdapter();
registerAdapter(partnerizeAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers
// ---------------------------------------------------------------------------

export const _internals = {
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  toDiscoveredBrand,
  mapCampaignStatus,
  mapConversionStatus,
  mapPublisherStatus,
  mapMetricRowStatus,
  parseDate,
  computeAgeDays,
  extractCampaigns,
  extractPublishers,
  extractConversions,
  extractMetricRows,
};

// Silence unused-import lint when noUnusedLocals is on.
void log;
