/**
 * Admitad advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the Impact advertiser adapter's structure (the
 * canonical advertiser reference) and reuses the publisher Admitad adapter's
 * OAuth token-cache and action/status transform patterns.
 *
 * Admitad's advertiser surface is scoped by an advertiser id carried in the URL
 * path: /advertiser/{advertiserId}/... . That advertiser id IS the brand id, so
 * the adapter receives a `ctx?: AdapterCallContext` carrying `networkBrandId`
 * (the advertiser id) and addresses the right brand under multi-brand
 * credentials. Brand-scoped operations REQUIRE the context — without it we throw
 * a `config_error` envelope rather than guessing.
 *
 * The Admitad developer docs host returned 403 to automated WebFetch during this
 * PR's research, so a few response-field details are marked `// BLOCKED(verify)`
 * and should be confirmed against a live advertiser account in a follow-up. The
 * endpoint paths, OAuth flow, and advertiser scopes were corroborated via search
 * snippets and the public Python wrapper (admitad/admitad-python-api), exactly as
 * the publisher adapter did.
 *
 * Operations:
 *   listBrands              → GET /advertiser/{id}/info/  (the advertiser id from env)
 *   verifyAuth              → OAuth token exchange + /me/ (auth.ts)
 *   listProgrammes          → GET /advertiser/{id}/info/  (campaigns the credential owns)
 *   listTransactions        → GET /advertiser/{id}/statistics/actions/
 *   getProgrammePerformance → GET /advertiser/{id}/statistics/actions/ grouped by publisher
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `admitadAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. Normalise status enums; prefer the closest canonical state.
 *   5. UK English in user-visible strings.
 *   6. NEVER issue a non-GET request. The client enforces this; the adapter must
 *      not work around it.
 */

import { admitadAdvRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  getAccessToken,
  SLUG,
} from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('admitad-advertiser.adapter');

const NAME = 'Admitad (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.admitad.com',
  authModel: 'oauth2',
  docsUrl: 'https://developers.admitad.com/en/doc/advertiser-api/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Read-only at v0.1. The HTTP client refuses any non-GET method; use an API application scoped only for the advertiser reporting endpoints for defence in depth.',
    'getProgrammePerformance is derived from the advertiser statistics/actions report grouped by publisher (webmaster/website). Admitad does not expose per-publisher click counts on this report, so `clicks` is reported as 0; the exact webmaster/website field names carry // BLOCKED(verify) notes until a live advertiser account is available.',
    'listBrands / listProgrammes read GET /advertiser/{id}/info/, which returns the campaigns the credential addresses. The advertiser id (ADMITAD_ADVERTISER_ID) is the networkBrandId; advertiser tools take `brand` and resolve it via brands.json.',
    'OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry. Cached tokens are lost on process restart.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 12,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

const ACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: ACTIONS_RESILIENCE,
  getProgrammePerformance: ACTIONS_RESILIENCE,
};

// Admitad's statistics/actions limit caps at 500 per page (default 20).
// Source: https://developers.admitad.com/knowledge-base/article/limit-offset-parameters_3
const ACTIONS_PAGE_LIMIT = 500;
const MAX_ACTION_PAGES = 50; // hard ceiling so a pathological account can't loop forever

// ---------------------------------------------------------------------------
// Require an AdapterCallContext on brand-scoped operations.
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
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
        message: `Admitad advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Admitad advertiser id) via brands.json.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Admitad advertiser raw response shapes
// ---------------------------------------------------------------------------
//
// Deliberately minimal and permissive: Admitad's field set varies across
// endpoints and over time. Every field is treated as possibly absent and the
// original payload is preserved on `rawNetworkData`.

interface AdmitadMeta {
  count?: number;
  limit?: number;
  offset?: number;
}

/** GET /advertiser/{id}/info/ — campaign/brand info for the advertiser. */
interface AdmitadAdvInfoRaw {
  campaign_id?: string | number;
  campaign_name?: string;
  campaign_code?: string;
  currency?: string;
  status?: string;
  site_url?: string;
}

interface AdmitadAdvInfoResponse {
  results?: AdmitadAdvInfoRaw[];
  _meta?: AdmitadMeta;
}

/**
 * GET /advertiser/{id}/statistics/actions/ — one row per action (conversion).
 *
 * BLOCKED(verify): the exact webmaster/website field names below are inferred
 * from the publisher statistics/actions schema and search snippets that confirm
 * the advertiser actions report carries "webmaster information" and "website ID
 * (formatted as site_of_webmaster)". Confirm against a live advertiser account.
 */
interface AdmitadAdvActionRaw {
  action_id?: string | number;
  advcampaign_id?: string | number;
  advcampaign_name?: string;
  status?: string; // pending | approved | approved_but_stalled | declined
  payment?: number | string; // commission paid to the publisher
  cart?: number | string; // gross order/cart amount
  currency?: string;
  click_date?: string;
  action_date?: string;
  closing_date?: string;
  status_updated?: string;
  payment_status?: number | string; // 0 = not paid, 1 = paid
  comment?: string;
  // Publisher (webmaster) identifiers — BLOCKED(verify) exact names.
  webmaster_id?: string | number;
  website_id?: string | number;
  website_name?: string;
  site_of_webmaster?: string;
}

interface AdmitadAdvActionsResponse {
  results?: AdmitadAdvActionRaw[];
  _meta?: AdmitadMeta;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function isPaid(raw: AdmitadAdvActionRaw): boolean {
  const ps = raw.payment_status;
  if (ps === undefined || ps === null) return false;
  const n = typeof ps === 'number' ? ps : parseInt(String(ps), 10);
  return n === 1;
}

/**
 * Map an Admitad action to the canonical TransactionStatus.
 *
 *   payment_status == 1                         → 'paid'
 *   declined / rejected                         → 'reversed'
 *   approved / approved_but_stalled / confirmed → 'approved'
 *   pending / on_hold                           → 'pending'
 *   anything else                               → 'other'
 */
function mapTransactionStatus(raw: AdmitadAdvActionRaw): TransactionStatus {
  if (isPaid(raw)) return 'paid';
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'declined' || s === 'rejected' || s === 'reversed') return 'reversed';
  if (s === 'approved' || s === 'approved_but_stalled' || s === 'confirmed') return 'approved';
  if (s === 'pending' || s === 'on_hold') return 'pending';
  return 'other';
}

/**
 * Map an Admitad action to the three-state ProgrammePerformanceRow status.
 * approved/paid → approved; declined → reversed; everything else → pending.
 */
function mapPerformanceStatus(raw: AdmitadAdvActionRaw): ProgrammePerformanceRow['status'] {
  const t = mapTransactionStatus(raw);
  if (t === 'approved' || t === 'paid') return 'approved';
  if (t === 'reversed') return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Parse an Admitad timestamp into epoch ms. */
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

function computeAgeDays(raw: AdmitadAdvActionRaw, now: Date = new Date()): number {
  const anchor = raw.closing_date ?? raw.action_date ?? raw.click_date;
  if (!anchor) return 0;
  const t = parseAdmitadDate(anchor);
  if (t === undefined) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Admitad statistics endpoints accept date_start / date_end as DD.MM.YYYY.
 * Source: the statistics/actions documentation and client-authorization curl
 * example.
 */
function toAdmitadDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: AdmitadAdvInfoRaw): Programme {
  const id = String(raw.campaign_id ?? '');
  const programme: Programme = {
    id,
    name: raw.campaign_name ?? `Admitad campaign ${id}`,
    network: SLUG,
    // The advertiser owns this campaign; from their side it is "joined" (live).
    status: 'joined',
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  if (raw.site_url) programme.advertiserUrl = raw.site_url;
  return programme;
}

function toDiscoveredBrand(raw: AdmitadAdvInfoRaw): DiscoveredBrand {
  const id = String(raw.campaign_id ?? '');
  return {
    networkBrandId: id,
    displayName: raw.campaign_name ?? `Admitad advertiser ${id}`,
    apiEnabled: true,
  };
}

function toTransaction(raw: AdmitadAdvActionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.payment);
  const sale = toAmount(raw.cart);
  const currency = (raw.currency ?? 'EUR').toUpperCase();

  const actionDate = nullableIso(raw.action_date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date);
  const approvedDate =
    status === 'approved' || status === 'paid' ? nullableIso(raw.closing_date) : undefined;
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

/**
 * Build one ProgrammePerformanceRow from an action row.
 *
 * The actions report is per-action; getProgrammePerformance aggregates it by
 * (date, publisher, status) below. This helper builds the per-action row.
 * `clicks` is 0 because the advertiser actions report does not carry per-publisher
 * click counts (see known_limitations). BLOCKED(verify): exact webmaster/website
 * field names.
 */
function toPerformanceRow(raw: AdmitadAdvActionRaw): ProgrammePerformanceRow {
  const date = (nullableIso(raw.action_date ?? raw.closing_date ?? raw.click_date) ?? '').slice(0, 10);
  const publisherId = String(raw.webmaster_id ?? raw.website_id ?? '');
  const publisherName = raw.website_name ?? raw.site_of_webmaster ?? '';
  return {
    date,
    publisherId,
    publisherName,
    clicks: 0,
    conversions: 1,
    grossSale: toAmount(raw.cart),
    commission: toAmount(raw.payment),
    currency: (raw.currency ?? 'EUR').toUpperCase(),
    status: mapPerformanceStatus(raw),
    rawNetworkData: raw,
  };
}

/**
 * Aggregate per-action performance rows into one row per
 * (date, publisherId, status). Sums conversions/grossSale/commission.
 */
function aggregatePerformance(rows: ProgrammePerformanceRow[]): ProgrammePerformanceRow[] {
  const map = new Map<string, ProgrammePerformanceRow>();
  for (const r of rows) {
    const key = `${r.date}|${r.publisherId}|${r.status}`;
    const existing = map.get(key);
    if (existing) {
      existing.conversions += r.conversions;
      existing.grossSale += r.grossSale;
      existing.commission += r.commission;
    } else {
      // Clone so we don't mutate the caller's row; keep the first raw payload.
      map.set(key, { ...r });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdmitadAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the campaigns/brands the advertiser credential addresses via
   * GET /advertiser/{id}/info/. The advertiser id comes from ADMITAD_ADVERTISER_ID
   * (the brand this credential set owns). Admitad's /advertiser/{id}/info/ returns
   * an array of campaign structures, so we map each to a DiscoveredBrand.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const advertiserId = requireCredential('ADMITAD_ADVERTISER_ID', {
      network: SLUG,
      operation: 'listBrands',
      hint: 'Set ADMITAD_ADVERTISER_ID (your numeric Admitad advertiser id) in ~/.affiliate-mcp/.env.',
    });
    const token = await getAccessToken();
    const response = await admitadAdvRequest<AdmitadAdvInfoResponse | AdmitadAdvInfoRaw[]>({
      operation: 'listBrands',
      brandPath: '/info/',
      networkBrandId: advertiserId,
      token,
      resilience: RESILIENCE.default,
    });
    const list = extractInfo(response);
    if (list.length === 0) {
      // info/ returned an object without results — synthesise a single entry
      // keyed by the configured advertiser id.
      return [{ networkBrandId: advertiserId, displayName: `Admitad advertiser ${advertiserId}`, apiEnabled: true }];
    }
    return list.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth — OAuth token exchange (auth.ts).
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
  // listProgrammes — the advertiser's campaigns.
  // -------------------------------------------------------------------------

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const token = await getAccessToken();
    const response = await admitadAdvRequest<AdmitadAdvInfoResponse | AdmitadAdvInfoRaw[]>({
      operation: 'listProgrammes',
      brandPath: '/info/',
      networkBrandId: c.networkBrandId,
      token,
      resilience: RESILIENCE.default,
    });
    let programmes = extractInfo(response).map(toProgramme);
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — the advertiser's actions, brand-scoped.
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const now = new Date();
    const rawActions = await this.fetchActions(c.networkBrandId, query?.from, query?.to, query?.programmeId);

    let transactions = rawActions.map((r) => toTransaction(r, now));

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
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher rollup of the actions report.
  // -------------------------------------------------------------------------

  /**
   * Derive a per-publisher performance report from the advertiser actions
   * report (GET /advertiser/{id}/statistics/actions/). We page the actions,
   * map each to a per-action row keyed by publisher, then aggregate by
   * (date, publisher, status). `clicks` is 0 — the advertiser actions report
   * does not expose per-publisher clicks.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const rawActions = await this.fetchActions(c.networkBrandId, query?.from, query?.to, query?.programmeId);

    let rows = aggregatePerformance(rawActions.map(toPerformanceRow));
    if (query?.publisherId) {
      rows = rows.filter((r) => r.publisherId === query.publisherId);
    }
    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  /**
   * Page the advertiser statistics/actions report. Shared by listTransactions
   * and getProgrammePerformance. Defaults to the last 30 days when no window is
   * given. Admitad uses limit/offset (max limit 500) and reports _meta.count.
   */
  private async fetchActions(
    networkBrandId: string,
    from?: string,
    to?: string,
    programmeId?: string,
  ): Promise<AdmitadAdvActionRaw[]> {
    const token = await getAccessToken();
    const now = new Date();
    const toDate = to ? new Date(to) : now;
    const fromDate = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const baseParams: Record<string, string | number | undefined> = {
      date_start: toAdmitadDate(fromDate),
      date_end: toAdmitadDate(toDate),
    };
    if (programmeId) baseParams['advcampaign'] = programmeId;

    const rawActions: AdmitadAdvActionRaw[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_ACTION_PAGES; page += 1) {
      const response = await admitadAdvRequest<AdmitadAdvActionsResponse>({
        operation: 'getProgrammePerformance',
        brandPath: '/statistics/actions/',
        networkBrandId,
        token,
        query: { ...baseParams, limit: ACTIONS_PAGE_LIMIT, offset },
        resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
      });
      const pageResults = Array.isArray(response.results) ? response.results : [];
      rawActions.push(...pageResults);
      const total = response._meta?.count;
      offset += ACTIONS_PAGE_LIMIT;
      if (pageResults.length === 0) break;
      if (typeof total === 'number' && offset >= total) break;
    }
    return rawActions;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Admitad advertiser adapter does not implement getProgramme at v0.1; use listProgrammes and filter client-side.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Admitad advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Admitad does not expose click-level data on the advertiser actions report; performance is reported via getProgrammePerformance.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Admitad advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
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
      note: 'OAuth2 token exchange; live probe runs at wizard time, not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Reads GET /advertiser/{id}/info/. The advertiser id (ADMITAD_ADVERTISER_ID) is the networkBrandId.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = { supported: true };
    operations['listTransactions'] = { supported: true };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Derived from the advertiser statistics/actions report grouped by publisher; clicks=0 (not on the report). Webmaster/website field names BLOCKED(verify) until a live account is available.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = {
      supported: false,
      note: 'Click-level data not exposed on the advertiser actions report.',
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

export const admitadAdvertiserAdapter = new AdmitadAdvertiserAdapter();
registerAdapter(admitadAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function extractInfo(
  response: AdmitadAdvInfoResponse | AdmitadAdvInfoRaw[],
): AdmitadAdvInfoRaw[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response.results) ? response.results : [];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// Silence unused-import lint when noUnusedLocals is on.
void log;

export const _internals = {
  toProgramme,
  toDiscoveredBrand,
  toTransaction,
  toPerformanceRow,
  aggregatePerformance,
  mapTransactionStatus,
  mapPerformanceStatus,
  isPaid,
  parseAdmitadDate,
  computeAgeDays,
  toAdmitadDate,
  toAmount,
  extractInfo,
};
