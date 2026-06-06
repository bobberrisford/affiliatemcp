/**
 * FirstPromoter adapter (advertiser / merchant side).
 *
 * FirstPromoter is a SaaS referral / affiliate platform run by the merchant
 * (brand): the v2 admin API is the merchant's view of their own programme —
 * the campaigns, the promoters running them, the referrals they bring, and the
 * commissions owed. There is no publisher side; this adapter is `advertiser` +
 * `single-brand` (one API key + account id scopes one FirstPromoter account).
 *
 * Read `src/networks/rewardful/adapter.ts` first — Rewardful is the closest
 * reference (advertiser, single-brand SaaS-referral, derived media-partner
 * roster, client-side performance aggregation, listClicks / generateTrackingLink
 * unsupported). This file mirrors that shape.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented v2 admin REST contract (Bearer + ACCOUNT-ID
 * headers, Link-header pagination, ISO-8601 dates, integer minor-unit amounts).
 * The exact field names on `commission` / `promoter` / `campaign` / `referral`
 * objects and the amount unit (assumed minor units / cents) have not been
 * confirmed against a live account; transformers read fields defensively,
 * preserve verbatim payloads on `rawNetworkData`, and carry `// TODO(verify)`
 * where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /campaigns → one Programme per campaign.
 *   getProgramme            GET /campaigns/:id → Programme.
 *   listTransactions        GET /commissions → Transaction[] (commissions owed).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /promoters → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /commissions by
 *                           (promoter, day); clicks always 0 (commissions carry
 *                           no click data).
 *   listClicks              NotImplementedError — the v2 admin API exposes
 *                           aggregate click counts in reports, not raw click
 *                           records.
 *   generateTrackingLink    NotImplementedError — referral links belong to
 *                           individual promoters; the merchant API does not
 *                           mint per-destination links.
 *   verifyAuth              cheap /promoters probe (see auth.ts).
 */

import { firstPromoterRequest, SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requireAccountId,
} from './auth.js';
import { setupSteps } from './setup.js';
import { configErrorFor, requireCtx } from './internal.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CommissionRateStructured,
  type CredentialValidationResult,
  type EarningsByProgramme,
  type EarningsByStatus,
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

const log = createLogger('firstpromoter.adapter');
const NAME = 'FirstPromoter';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.firstpromoter.com',
  authModel: 'bearer',
  docsUrl: 'https://docs.firstpromoter.com/api-reference-v2/api-admin/introduction',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'commission / promoter / campaign / referral field names and the amount unit (assumed minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one API key + account id pair scopes one FirstPromoter (merchant) account. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: the v2 admin API exposes aggregate click counts in reports, not raw click records.',
    'generateTrackingLink is unsupported: referral links belong to individual promoters; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /commissions grouped by (promoter, day). Clicks are not available from /commissions and are reported as 0.',
    'Pagination is via the Link header (rel="next"); wide pulls follow it page by page, capped at MAX_PAGES with a warning rather than a silent truncation. FirstPromoter rate-limits the API and returns HTTP 429, which the resilience layer retries.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'single-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getEarningsSummary: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getProgrammePerformance: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  listMediaPartners: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// FirstPromoter response shapes (defensive)
// ---------------------------------------------------------------------------

interface FpCampaignRaw {
  id?: number | string;
  name?: string;
  color?: string;
  // Commission defaults vary by campaign config; surfaced defensively.
  default_promoter_reward?: {
    type?: string; // 'per' (percentage) | 'per_amount' (flat) | ...
    amount?: number; // percent value, or minor-unit flat amount per `unit`
    unit?: string; // currency code for flat rewards
  };
}

interface FpPromoterStatsRaw {
  clicks_count?: number;
  referrals_count?: number;
  sales_count?: number;
  customers_count?: number;
  revenue_amount?: number;
  active_customers_count?: number;
}

interface FpPromoterRaw {
  id?: number | string;
  email?: string;
  name?: string;
  cust_id?: string;
  state?: string; // 'active' | 'pending' | ...
  stats?: FpPromoterStatsRaw;
}

interface FpReferralRaw {
  id?: number | string;
  uid?: string;
  email?: string;
  state?: string;
  created_at?: string;
  customer_since?: string;
}

interface FpCommissionRaw {
  id?: number | string;
  status?: string; // 'pending' | 'approved' | 'denied' | ...
  amount?: number; // commission, minor units (cents) — TODO(verify)
  sale_amount?: number; // gross sale, minor units (cents) — TODO(verify)
  original_sale_amount?: number;
  original_sale_currency?: string;
  unit?: string; // currency code for `amount` — TODO(verify)
  is_paid?: boolean;
  commission_type?: string;
  created_at?: string;
  status_updated_at?: string;
  referral?: FpReferralRaw;
  promoter?: FpPromoterRaw;
  promoter_campaign?: {
    id?: number | string;
    promoter?: FpPromoterRaw;
    campaign?: FpCampaignRaw;
  };
}

// ---------------------------------------------------------------------------
// List extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a FirstPromoter list response. The v2 admin
 * list endpoints return a bare JSON array; we also tolerate a `{ data: [...] }`
 * or a resource-named key in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj['data'])) return obj['data'] as unknown[];
    if (Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrUndefined(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function minorToMajor(amount?: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 0;
  return amount / 100;
}

/**
 * Map a FirstPromoter commission status → canonical TransactionStatus.
 *   pending  → 'pending'
 *   approved → 'approved'  (unless is_paid, in which case 'paid')
 *   paid     → 'paid'
 *   denied   → 'reversed'  (commission rejected / clawed back)
 *   else     → 'other'
 * The `is_paid` flag wins over an 'approved' status because FirstPromoter marks
 * an approved commission paid via a separate field rather than a status change.
 */
function mapTransactionStatus(raw: FpCommissionRaw): TransactionStatus {
  if (raw.is_paid === true) return 'paid';
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'denied':
    case 'refunded':
    case 'rejected':
      return 'reversed';
    default:
      return 'other';
  }
}

function mapPerformanceStatus(raw: FpCommissionRaw): ProgrammePerformanceRow['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'denied':
    case 'refunded':
    case 'rejected':
      return 'reversed';
    case 'approved':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

function mapPromoterStatus(raw: FpPromoterRaw): MediaPartner['status'] {
  switch (String(raw.state ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'pending':
      return 'pending';
    case 'inactive':
    case 'disabled':
    case 'blocked':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function promoterName(raw?: FpPromoterRaw): string {
  if (!raw) return '';
  return (raw.name ?? '').trim() || raw.email || '';
}

/** Resolve the promoter on a commission, whether flat or nested under promoter_campaign. */
function commissionPromoter(raw: FpCommissionRaw): FpPromoterRaw | undefined {
  return raw.promoter ?? raw.promoter_campaign?.promoter;
}

/** Resolve the campaign id on a commission, where present. */
function commissionCampaignId(raw: FpCommissionRaw): string {
  return String(raw.promoter_campaign?.campaign?.id ?? '');
}

function commissionCampaignName(raw: FpCommissionRaw): string {
  return raw.promoter_campaign?.campaign?.name ?? '';
}

function computeAgeDays(raw: FpCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.status_updated_at ?? raw.created_at;
  const iso = isoOrUndefined(anchor);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: FpCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  const reward = raw.default_promoter_reward;
  if (reward && typeof reward.amount === 'number') {
    const type = String(reward.type ?? '').toLowerCase();
    if (type === 'per' || type === 'percentage' || type === 'percent') {
      commissionRate = { type: 'percent', value: reward.amount };
    } else {
      commissionRate = {
        type: 'flat',
        value: minorToMajor(reward.amount),
        currency: reward.unit,
      };
    }
  }
  return {
    id,
    name: raw.name ?? `FirstPromoter campaign ${id}`,
    network: SLUG,
    // Campaigns the merchant owns are active programmes by definition.
    status: 'joined',
    commissionRate,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: FpCommissionRaw, now: Date = new Date()): Transaction {
  const commission = minorToMajor(raw.amount);
  const sale = minorToMajor(raw.sale_amount) || commission;
  const currency = raw.unit ?? raw.original_sale_currency ?? 'USD';

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: commissionCampaignId(raw),
    programmeName: commissionCampaignName(raw),
    status: mapTransactionStatus(raw),
    amount: sale,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.created_at) ?? new Date(0).toISOString(),
    dateApproved:
      String(raw.status ?? '').toLowerCase() === 'approved'
        ? isoOrUndefined(raw.status_updated_at)
        : undefined,
    datePaid: raw.is_paid === true ? isoOrUndefined(raw.status_updated_at) : undefined,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: FpPromoterRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: promoterName(raw) || `FirstPromoter promoter ${id}`,
    status: mapPromoterStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: FpCommissionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += minorToMajor(r.sale_amount) || minorToMajor(r.amount);
    commission += minorToMajor(r.amount);
    if (r.unit) currency = r.unit;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `FirstPromoter promoter ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/commissions aggregation (per-promoter per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class FirstPromoterAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a Link-header-paginated FirstPromoter list resource.
   * Loops while a `rel="next"` URL is present, capped at `MAX_PAGES` — the cap
   * is a backstop logged so a truncated pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    apiKey: string,
    accountId: string,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let nextPath: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await firstPromoterRequest<unknown>({
        operation,
        path: nextPath ?? path,
        apiKey,
        accountId,
        // Only set the page size on the first request; the next-link carries
        // its own query string verbatim.
        query: nextPath ? undefined : { per_page: PAGE_SIZE },
        resilience,
      });
      out.push(...extractList(res.body, resourceKey));
      if (!res.nextUrl) return out;
      nextPath = res.nextUrl;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'firstpromoter pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const apiKey = requireApiKey('listProgrammes');
    const accountId = requireAccountId('listProgrammes');
    const raw = (await this.fetchAll(
      'listProgrammes',
      '/campaigns',
      'campaigns',
      apiKey,
      accountId,
    )) as FpCampaignRaw[];
    let programmes = raw.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  async getProgramme(programmeId: string, ctx?: AdapterCallContext): Promise<Programme> {
    requireCtx('getProgramme', ctx);
    if (!programmeId || programmeId.trim() === '') {
      throw configErrorFor('getProgramme', 'A FirstPromoter campaign id is required.', {
        hint: 'List programmes first (affiliate_firstpromoter_list_programmes) to find the id.',
      });
    }
    const apiKey = requireApiKey('getProgramme');
    const accountId = requireAccountId('getProgramme');
    const res = await firstPromoterRequest<FpCampaignRaw | { data?: FpCampaignRaw }>({
      operation: 'getProgramme',
      path: `/campaigns/${encodeURIComponent(programmeId)}`,
      apiKey,
      accountId,
      resilience: RESILIENCE.default,
    });
    const flat =
      (res.body as { data?: FpCampaignRaw })?.data ?? (res.body as FpCampaignRaw);
    if (!flat || flat.id === undefined || flat.id === null || String(flat.id) === '') {
      throw configErrorFor(
        'getProgramme',
        `No FirstPromoter campaign found with id "${programmeId}".`,
        { hint: 'Use affiliate_firstpromoter_list_programmes to see valid ids.' },
      );
    }
    return toProgramme(flat);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const apiKey = requireApiKey('listTransactions');
    const accountId = requireAccountId('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/commissions',
      'commissions',
      apiKey,
      accountId,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as FpCommissionRaw[];
    let transactions = raw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
    if (query?.from) {
      const fromMs = Date.parse(query.from);
      if (!Number.isNaN(fromMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) >= fromMs);
      }
    }
    if (query?.to) {
      const toMs = Date.parse(query.to);
      if (!Number.isNaN(toMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) <= toMs);
      }
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
    return transactions;
  }

  async getEarningsSummary(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<EarningsSummary> {
    requireCtx('getEarningsSummary', ctx);
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Never pass query.limit through — a summary with a limit silently
    // undercounts (principle 4.1).
    const txns = await this.listTransactions({ ...query, from, to, limit: undefined }, ctx);

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
          programmeName: t.programmeName || `FirstPromoter campaign ${key}`,
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
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  async listMediaPartners(query?: MediaPartnerQuery, ctx?: AdapterCallContext): Promise<MediaPartner[]> {
    requireCtx('listMediaPartners', ctx);
    const apiKey = requireApiKey('listMediaPartners');
    const accountId = requireAccountId('listMediaPartners');
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/promoters',
      'promoters',
      apiKey,
      accountId,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as FpPromoterRaw[];
    let partners = raw.map(toMediaPartner);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toMediaPartnerStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') partners = partners.slice(0, query.limit);
    return partners;
  }

  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    requireCtx('getProgrammePerformance', ctx);
    const apiKey = requireApiKey('getProgrammePerformance');
    const accountId = requireAccountId('getProgrammePerformance');

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/commissions',
      'commissions',
      apiKey,
      accountId,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as FpCommissionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: FpCommissionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.created_at);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const promoter = commissionPromoter(r);
      const publisherId = String(promoter?.id ?? promoter?.email ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;

      const date = anchorIso ? anchorIso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName) existing.publisherName = promoterName(promoter);
      } else {
        buckets.set(key, { date, publisherId, publisherName: promoterName(promoter), rows: [r] });
      }
    }

    let rows = [...buckets.values()].map((b) =>
      toPerformanceRow(b.date, b.publisherId, b.publisherName, b.rows),
    );
    rows.sort((a, b) =>
      a.date === b.date ? a.publisherId.localeCompare(b.publisherId) : a.date.localeCompare(b.date),
    );
    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops not implemented.
  // -------------------------------------------------------------------------

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'FirstPromoter exposes aggregate click counts in reports, not raw click records, via the v2 admin API; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: FirstPromoter referral links belong to individual promoters; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the promoter roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for FirstPromoter at v0.1.');
  }

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    return { ok: false, reason: r.reason };
  }

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {
      verifyAuth: {
        supported: true,
        note: '/promoters probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/campaigns query.', claimStatus: 'experimental' },
      getProgramme: {
        supported: true,
        note: '/campaigns/:id; requires a known id, not probed.',
        claimStatus: 'experimental',
      },
      listTransactions: { supported: true, note: '/commissions query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/promoters query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /commissions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'FirstPromoter exposes aggregate click counts, not raw clicks.' },
      generateTrackingLink: {
        supported: false,
        note: 'Referral links belong to promoters; not minted via the merchant API.',
      },
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

export const firstPromoterAdapter = new FirstPromoterAdapter();
registerAdapter(firstPromoterAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toStatusList(v?: ProgrammeStatus | ProgrammeStatus[]): ProgrammeStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toMediaPartnerStatusList(
  v?: MediaPartner['status'] | Array<MediaPartner['status']>,
): Array<MediaPartner['status']> | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export const _internals = {
  mapTransactionStatus,
  mapPerformanceStatus,
  mapPromoterStatus,
  promoterName,
  commissionPromoter,
  commissionCampaignId,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  extractList,
  minorToMajor,
};
