/**
 * Post Affiliate Pro adapter (advertiser / merchant side).
 *
 * Post Affiliate Pro is a SaaS affiliate platform run by the merchant
 * (advertiser side): the API v3 is the merchant's view of their own affiliate
 * programme — campaigns, the affiliates promoting them, and the commissions /
 * transactions owed. There is no publisher side; this adapter is `advertiser` +
 * `single-brand` (one API key + one account base URL scopes one PAP account).
 *
 * Each PAP account is its own subdomain tenant, so the API base URL is a
 * CREDENTIAL (POST_AFFILIATE_PRO_BASE_URL), read in client.ts — that is the one
 * structural difference from Rewardful, whose host is fixed.
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the advertiser-side
 * single-brand SaaS reference this file mirrors.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented API v3 contract (Bearer API key, offset/limit
 * pagination, ISO-8601 dates, transaction `type`/`rstatus` codes). The exact
 * field names on `transaction` / `affiliate` / `campaign` objects and the
 * amount unit (assumed MAJOR currency units, i.e. whole currency, since PAP
 * stores decimal currency amounts — the opposite of Rewardful's cents) have not
 * been confirmed against a live account; transformers read fields defensively,
 * preserve verbatim payloads on `rawNetworkData`, and carry `// TODO(verify)`
 * where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /campaigns → one Programme per campaign. If the
 *                           account exposes no campaign list, a single
 *                           synthesised programme is returned (like Rewardful).
 *   getProgramme            GET /campaigns/:id → Programme.
 *   listTransactions        GET /transactions → Transaction[]; normalise status.
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /affiliates → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /transactions by
 *                           (affiliate, day); clicks always 0 (transactions
 *                           carry no click data).
 *   listClicks              NotImplementedError — API v3 exposes no raw click
 *                           record list to the merchant via this surface.
 *   generateTrackingLink    NotImplementedError — affiliate links belong to
 *                           individual affiliates; the merchant API does not
 *                           mint per-destination links.
 *   verifyAuth              cheap /affiliates probe (see auth.ts).
 */

import { papRequest, requireBaseUrl, SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
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

const log = createLogger('post-affiliate-pro.adapter');
const NAME = 'Post Affiliate Pro';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Placeholder demo host; the real base is the per-account subdomain supplied
  // via POST_AFFILIATE_PRO_BASE_URL (see client.requireBaseUrl).
  baseUrl: 'https://demo.postaffiliatepro.com/api/v3',
  authModel: 'bearer',
  docsUrl: 'https://support.qualityunit.com/868880-API-v3-documentation-overview',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: built against the documented Post Affiliate Pro API v3 contract but not verified against a live account.',
    'Per-tenant base URL: Post Affiliate Pro is hosted per account, so the API base is the per-account subdomain supplied via POST_AFFILIATE_PRO_BASE_URL (e.g. https://acme.postaffiliatepro.com/api/v3). The base_url in network.json is a placeholder demo host.',
    'transaction / affiliate / campaign field names and the amount unit (assumed MAJOR currency units, not minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one API key + base URL scopes one Post Affiliate Pro account. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: API v3 exposes no raw click record list to the merchant via this surface.',
    'generateTrackingLink is unsupported: affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /transactions grouped by (affiliate, day). Clicks are not available from /transactions and are reported as 0.',
    'Pagination is offset/limit and capped at MAX_PAGES with a warning rather than a silent truncation.',
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
// Post Affiliate Pro API v3 response shapes (defensive)
// ---------------------------------------------------------------------------

interface PapListEnvelope {
  data?: unknown;
  total?: number;
  count?: number;
  [resource: string]: unknown;
}

interface PapCampaignRaw {
  id?: string;
  name?: string;
  currencyId?: string;
  url?: string;
  commission?: number; // commission amount (major units) — TODO(verify)
  commissionType?: string;
}

interface PapAffiliateRaw {
  id?: string;
  username?: string;
  name?: string;
  firstname?: string;
  surname?: string;
  email?: string;
  rstatus?: string; // A active / P pending / D declined — TODO(verify)
  status?: string;
}

interface PapTransactionRaw {
  id?: string;
  type?: string; // S sale / A action / B bonus / U recurring / F referral / R refund / H chargeback / E extra
  rstatus?: string; // A approved / P pending / D declined
  status?: string;
  totalCost?: number; // sale amount (major units) — TODO(verify)
  commission?: number; // commission amount (major units) — TODO(verify)
  currencyId?: string;
  dateInserted?: string;
  dateApproved?: string;
  datePaid?: string;
  campaignId?: string;
  campaignName?: string;
  affiliateId?: string;
  affiliateUsername?: string;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a Post Affiliate Pro list response. The
 * documented shape wraps records in a `data` array; we also tolerate a bare
 * array and a resource-named key in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as PapListEnvelope;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrUndefined(d?: string): string | undefined {
  if (!d) return undefined;
  // PAP timestamps are commonly `YYYY-MM-DD HH:MM:SS`; normalise the space.
  const candidate = d.includes('T') ? d : d.replace(' ', 'T');
  const ts = Date.parse(candidate);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function num(v?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v;
}

/**
 * Map Post Affiliate Pro transaction status (`rstatus`) → canonical
 * TransactionStatus.
 *   A → 'approved'
 *   P → 'pending'
 *   D → 'reversed' (declined / refused commission)
 *   else → 'other'
 * The `type` codes R (refund) and H (chargeback) are treated as reversed
 * regardless of rstatus.
 */
function mapTransactionStatus(raw: PapTransactionRaw): TransactionStatus {
  const type = String(raw.type ?? '').toUpperCase();
  if (type === 'R' || type === 'H') return 'reversed';
  switch (String(raw.rstatus ?? raw.status ?? '').toUpperCase()) {
    case 'A':
      return 'approved';
    case 'P':
      return 'pending';
    case 'D':
      return 'reversed';
    default:
      return 'other';
  }
}

function mapPerformanceStatus(raw: PapTransactionRaw): ProgrammePerformanceRow['status'] {
  const s = mapTransactionStatus(raw);
  switch (s) {
    case 'reversed':
      return 'reversed';
    case 'approved':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

function mapAffiliateStatus(raw: PapAffiliateRaw): MediaPartner['status'] {
  switch (String(raw.rstatus ?? raw.status ?? '').toUpperCase()) {
    case 'A':
      return 'active';
    case 'P':
      return 'pending';
    case 'D':
    case 'R':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function affiliateName(raw?: PapAffiliateRaw): string {
  if (!raw) return '';
  const full = [raw.firstname ?? raw.name, raw.surname].filter(Boolean).join(' ').trim();
  return full || raw.username || raw.email || '';
}

function computeAgeDays(raw: PapTransactionRaw, now: Date = new Date()): number {
  const iso = isoOrUndefined(raw.dateInserted);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: PapCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  return {
    id,
    name: raw.name ?? `Post Affiliate Pro campaign ${id}`,
    network: SLUG,
    // Campaigns the merchant owns are active programmes by definition.
    status: 'joined',
    currency: raw.currencyId,
    commissionRate:
      typeof raw.commission === 'number'
        ? { type: 'flat', value: num(raw.commission), currency: raw.currencyId }
        : undefined,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: PapTransactionRaw, now: Date = new Date()): Transaction {
  const commission = num(raw.commission);
  const amount = num(raw.totalCost) || commission;
  const currency = raw.currencyId ?? 'USD';

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaignId ?? ''),
    programmeName: raw.campaignName ?? '',
    status: mapTransactionStatus(raw),
    amount,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.dateInserted) ?? new Date(0).toISOString(),
    dateApproved: isoOrUndefined(raw.dateApproved),
    datePaid: isoOrUndefined(raw.datePaid),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: PapAffiliateRaw): MediaPartner {
  const id = String(raw.id ?? raw.username ?? raw.email ?? '');
  return {
    id,
    name: affiliateName(raw) || `Post Affiliate Pro affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: PapTransactionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += num(r.totalCost) || num(r.commission);
    commission += num(r.commission);
    if (r.currencyId) currency = r.currencyId;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Post Affiliate Pro affiliate ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/transactions aggregation (per-affiliate per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PostAffiliateProAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of an offset/limit Post Affiliate Pro list resource. Loops
   * while a full page comes back, capped at `MAX_PAGES` — the cap is a backstop
   * logged so a truncated pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    baseUrl: string,
    apiKey: string,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await papRequest<PapListEnvelope>({
        operation,
        path,
        baseUrl,
        apiKey,
        query: { offset: page * PAGE_SIZE, limit: PAGE_SIZE },
        resilience,
      });
      const batch = extractList(body, resourceKey);
      out.push(...batch);
      // A short page (or empty) means we have reached the end.
      if (batch.length < PAGE_SIZE) return out;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'post-affiliate-pro pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const baseUrl = requireBaseUrl('listProgrammes');
    const apiKey = requireApiKey('listProgrammes');
    const raw = (await this.fetchAll(
      'listProgrammes',
      '/campaigns',
      'campaigns',
      baseUrl,
      apiKey,
    )) as PapCampaignRaw[];

    // Synthesise a single programme if the account exposes no campaign list,
    // mirroring Rewardful's behaviour for accounts without campaigns.
    let programmes =
      raw.length > 0
        ? raw.map(toProgramme)
        : [toProgramme({ id: ctx?.networkBrandId ?? 'default', name: NAME })];

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
      throw configErrorFor('getProgramme', 'A Post Affiliate Pro campaign id is required.', {
        hint: 'List programmes first (affiliate_post_affiliate_pro_list_programmes) to find the id.',
      });
    }
    const baseUrl = requireBaseUrl('getProgramme');
    const apiKey = requireApiKey('getProgramme');
    const body = await papRequest<PapCampaignRaw | { data?: PapCampaignRaw }>({
      operation: 'getProgramme',
      path: `/campaigns/${encodeURIComponent(programmeId)}`,
      baseUrl,
      apiKey,
      resilience: RESILIENCE.default,
    });
    const flat = (body as { data?: PapCampaignRaw })?.data ?? (body as PapCampaignRaw);
    if (!flat || !flat.id) {
      throw configErrorFor('getProgramme', `No Post Affiliate Pro campaign found with id "${programmeId}".`, {
        hint: 'Use affiliate_post_affiliate_pro_list_programmes to see valid ids.',
      });
    }
    return toProgramme(flat);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const baseUrl = requireBaseUrl('listTransactions');
    const apiKey = requireApiKey('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/transactions',
      'transactions',
      baseUrl,
      apiKey,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as PapTransactionRaw[];
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
          programmeName: t.programmeName || `Post Affiliate Pro campaign ${key}`,
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
    const baseUrl = requireBaseUrl('listMediaPartners');
    const apiKey = requireApiKey('listMediaPartners');
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/affiliates',
      'affiliates',
      baseUrl,
      apiKey,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as PapAffiliateRaw[];
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
    const baseUrl = requireBaseUrl('getProgrammePerformance');
    const apiKey = requireApiKey('getProgrammePerformance');

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/transactions',
      'transactions',
      baseUrl,
      apiKey,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as PapTransactionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: PapTransactionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.dateInserted);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const publisherId = String(r.affiliateId ?? r.affiliateUsername ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;
      if (query?.programmeId && String(r.campaignId ?? '') !== query.programmeId) continue;

      const date = anchorIso ? anchorIso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName) existing.publisherName = String(r.affiliateUsername ?? '');
      } else {
        buckets.set(key, {
          date,
          publisherId,
          publisherName: String(r.affiliateUsername ?? ''),
          rows: [r],
        });
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
      'Post Affiliate Pro API v3 exposes no raw click record list to the merchant via this surface; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Post Affiliate Pro affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the affiliate roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Post Affiliate Pro at v0.1.');
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
        note: '/affiliates probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/campaigns query; synthesises one programme if empty.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: '/campaigns/:id; requires a known id, not probed.', claimStatus: 'experimental' },
      listTransactions: { supported: true, note: '/transactions query; field names + amount unit TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/affiliates query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /transactions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'API v3 exposes no raw click list to the merchant.' },
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

export const postAffiliateProAdapter = new PostAffiliateProAdapter();
registerAdapter(postAffiliateProAdapter);

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
  isoOrUndefined,
  num,
};
