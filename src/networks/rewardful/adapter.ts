/**
 * Rewardful adapter (advertiser / merchant side).
 *
 * Rewardful is a Stripe-native affiliate tool for SaaS brands: the API is the
 * merchant's view of their own affiliate programme — campaigns, the affiliates
 * promoting them, and the commissions owed. There is no publisher side; this
 * adapter is `advertiser` + `single-brand` (one API Secret scopes one Rewardful
 * account).
 *
 * Read `src/networks/cj-advertiser/adapter.ts` first — it is the advertiser-side
 * reference (ctx threading, derived media-partner roster, client-side
 * per-publisher performance aggregation). This file mirrors that shape.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented REST contract (Basic auth with the secret as
 * username, page-based pagination, ISO-8601 dates, UUID keys). The exact field
 * names on `commission` / `affiliate` / `campaign` objects and the amount unit
 * (assumed minor units / cents) have not been confirmed against a live account;
 * transformers read fields defensively, preserve verbatim payloads on
 * `rawNetworkData`, and carry `// TODO(verify)` where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /campaigns → one Programme per campaign.
 *   getProgramme            GET /campaigns/:id → Programme.
 *   listTransactions        GET /commissions → Transaction[] (commissions owed).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /affiliates → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /commissions by
 *                           (affiliate, day); clicks always 0 (commissions carry
 *                           no click data).
 *   listClicks              NotImplementedError — Rewardful exposes referral
 *                           visitors, not raw click records, via this API.
 *   generateTrackingLink    NotImplementedError — affiliate links belong to
 *                           affiliates; the merchant API does not mint them.
 *   verifyAuth              cheap /campaigns probe (see auth.ts).
 */

import { rewardfulRequest, SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiSecret,
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

const log = createLogger('rewardful.adapter');
const NAME = 'Rewardful';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.getrewardful.com',
  authModel: 'basic',
  docsUrl: 'https://developers.rewardful.com/rest-api/overview',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'commission / affiliate / campaign field names and the amount unit (assumed minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one API Secret scopes one Rewardful (merchant) account. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: Rewardful exposes referral visitors, not raw click records, via this API.',
    'generateTrackingLink is unsupported: affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /commissions grouped by (affiliate, day). Clicks are not available from /commissions and are reported as 0.',
    'Rate limit is 45 requests / 30s; wide pulls are paginated and may approach it. Pagination is capped at MAX_PAGES with a warning rather than a silent truncation.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'single-brand',
  // Rewardful timestamps are ISO-8601 with an offset, so no networkTimezone.
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
// Rewardful response shapes (defensive)
// ---------------------------------------------------------------------------

interface RewardfulPagination {
  current_page?: number;
  next_page?: number | null;
  previous_page?: number | null;
  total_pages?: number;
  total_count?: number;
  limit?: number;
}

interface RewardfulListEnvelope {
  pagination?: RewardfulPagination;
  data?: unknown;
  [resource: string]: unknown;
}

interface RewardfulCampaignRaw {
  id?: string;
  name?: string;
  url?: string;
  currency?: string;
  commission_amount_cents?: number;
  commission_percent?: number;
}

interface RewardfulAffiliateRaw {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  state?: string;
  created_at?: string;
}

interface RewardfulSaleRaw {
  id?: string;
  currency?: string;
  charged_at?: string;
  sale_amount_cents?: number;
}

interface RewardfulCommissionRaw {
  id?: string;
  currency?: string;
  amount?: number; // minor units (cents) — TODO(verify)
  state?: string;
  created_at?: string;
  due_at?: string;
  paid_at?: string;
  campaign?: RewardfulCampaignRaw;
  affiliate?: RewardfulAffiliateRaw;
  sale?: RewardfulSaleRaw;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a Rewardful list response. The documented
 * shape is `{ pagination, data: [...] }`; we also tolerate a resource-named key
 * (`affiliates`, `campaigns`, `commissions`) in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as RewardfulListEnvelope;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

function nextPage(body: unknown): number | null {
  if (body && typeof body === 'object') {
    const p = (body as RewardfulListEnvelope).pagination;
    if (p && typeof p.next_page === 'number') return p.next_page;
  }
  return null;
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
 * Map Rewardful commission state → canonical TransactionStatus.
 *   pending → 'pending'
 *   due     → 'approved' (approved & payable, not yet paid)
 *   paid    → 'paid'
 *   void    → 'reversed'
 *   else    → 'other'
 */
function mapTransactionStatus(raw: RewardfulCommissionRaw): TransactionStatus {
  switch (String(raw.state ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'due':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'void':
      return 'reversed';
    default:
      return 'other';
  }
}

function mapPerformanceStatus(raw: RewardfulCommissionRaw): ProgrammePerformanceRow['status'] {
  switch (String(raw.state ?? '').toLowerCase()) {
    case 'void':
      return 'reversed';
    case 'due':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

function mapAffiliateStatus(raw: RewardfulAffiliateRaw): MediaPartner['status'] {
  switch (String(raw.state ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'pending':
    case 'unconfirmed':
      return 'pending';
    case 'inactive':
    case 'disabled':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function affiliateName(raw?: RewardfulAffiliateRaw): string {
  if (!raw) return '';
  const full = [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  return full || raw.email || '';
}

function computeAgeDays(raw: RewardfulCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.due_at ?? raw.created_at;
  const iso = isoOrUndefined(anchor);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: RewardfulCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  if (typeof raw.commission_percent === 'number') {
    commissionRate = { type: 'percent', value: raw.commission_percent };
  } else if (typeof raw.commission_amount_cents === 'number') {
    commissionRate = {
      type: 'flat',
      value: minorToMajor(raw.commission_amount_cents),
      currency: raw.currency,
    };
  }
  return {
    id,
    name: raw.name ?? `Rewardful campaign ${id}`,
    network: SLUG,
    // Rewardful campaigns the merchant owns are active programmes by definition.
    status: 'joined',
    currency: raw.currency,
    commissionRate,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: RewardfulCommissionRaw, now: Date = new Date()): Transaction {
  const commission = minorToMajor(raw.amount);
  const sale = minorToMajor(raw.sale?.sale_amount_cents) || commission;
  const currency = raw.currency ?? raw.sale?.currency ?? 'USD';

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign?.id ?? ''),
    programmeName: raw.campaign?.name ?? '',
    status: mapTransactionStatus(raw),
    amount: sale,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.sale?.charged_at ?? raw.created_at) ?? new Date(0).toISOString(),
    dateApproved: isoOrUndefined(raw.due_at),
    datePaid: isoOrUndefined(raw.paid_at),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: RewardfulAffiliateRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: affiliateName(raw) || `Rewardful affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: RewardfulCommissionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += minorToMajor(r.sale?.sale_amount_cents) || minorToMajor(r.amount);
    commission += minorToMajor(r.amount);
    if (r.currency) currency = r.currency;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Rewardful affiliate ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/commissions aggregation (per-affiliate per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class RewardfulAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a page-based Rewardful list resource. Loops while
   * `pagination.next_page` is set, capped at `MAX_PAGES` — the cap is a backstop
   * logged so a truncated pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    apiSecret: string,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await rewardfulRequest<RewardfulListEnvelope>({
        operation,
        path,
        apiSecret,
        query: { page, limit: PAGE_SIZE },
        resilience,
      });
      out.push(...extractList(body, resourceKey));
      const next = nextPage(body);
      if (next === null || next <= page) return out;
      page = next;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'rewardful pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const apiSecret = requireApiSecret('listProgrammes');
    const raw = (await this.fetchAll('listProgrammes', '/campaigns', 'campaigns', apiSecret)) as RewardfulCampaignRaw[];
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
      throw configErrorFor('getProgramme', 'A Rewardful campaign id is required.', {
        hint: 'List programmes first (affiliate_rewardful_list_programmes) to find the id.',
      });
    }
    const apiSecret = requireApiSecret('getProgramme');
    const body = await rewardfulRequest<RewardfulCampaignRaw | { data?: RewardfulCampaignRaw }>({
      operation: 'getProgramme',
      path: `/campaigns/${encodeURIComponent(programmeId)}`,
      apiSecret,
      resilience: RESILIENCE.default,
    });
    const flat = (body as { data?: RewardfulCampaignRaw })?.data ?? (body as RewardfulCampaignRaw);
    if (!flat || !flat.id) {
      throw configErrorFor('getProgramme', `No Rewardful campaign found with id "${programmeId}".`, {
        hint: 'Use affiliate_rewardful_list_programmes to see valid ids.',
      });
    }
    return toProgramme(flat);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const apiSecret = requireApiSecret('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/commissions',
      'commissions',
      apiSecret,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as RewardfulCommissionRaw[];
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
          programmeName: t.programmeName || `Rewardful campaign ${key}`,
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
    const apiSecret = requireApiSecret('listMediaPartners');
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/affiliates',
      'affiliates',
      apiSecret,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as RewardfulAffiliateRaw[];
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
    const apiSecret = requireApiSecret('getProgrammePerformance');

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/commissions',
      'commissions',
      apiSecret,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as RewardfulCommissionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: RewardfulCommissionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.sale?.charged_at ?? r.created_at);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const publisherId = String(r.affiliate?.id ?? r.affiliate?.email ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;

      const date = anchorIso ? anchorIso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName) existing.publisherName = affiliateName(r.affiliate);
      } else {
        buckets.set(key, { date, publisherId, publisherName: affiliateName(r.affiliate), rows: [r] });
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
      'Rewardful exposes referral visitors, not raw click records, via this API; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Rewardful affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the affiliate roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Rewardful at v0.1.');
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
        note: '/campaigns probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/campaigns query.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: '/campaigns/:id; requires a known id, not probed.', claimStatus: 'experimental' },
      listTransactions: { supported: true, note: '/commissions query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/affiliates query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /commissions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'Rewardful exposes referral visitors, not raw clicks.' },
      generateTrackingLink: { supported: false, note: 'Affiliate links belong to affiliates; not minted via the merchant API.' },
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

export const rewardfulAdapter = new RewardfulAdapter();
registerAdapter(rewardfulAdapter);

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
  mapAffiliateStatus,
  affiliateName,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  extractList,
  nextPage,
  minorToMajor,
};
