/**
 * Refersion adapter (advertiser / merchant side).
 *
 * Refersion is a Shopify-heavy SaaS affiliate platform: the API is the
 * merchant's view of their own affiliate programme — the offers they run, the
 * affiliates promoting them, and the conversions (and the commission owed on
 * them). There is no publisher side; this adapter is `advertiser` +
 * `single-brand` (one API key pair scopes one Refersion account).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest
 * advertiser-side reference (ctx threading, derived media-partner roster,
 * client-side per-publisher performance aggregation). This file mirrors that
 * shape.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented REST v2 contract (custom key-pair headers,
 * POST list endpoints with page-based pagination, string timestamps). The exact
 * field names on `conversion` / `affiliate` / `offer` objects and the amount
 * unit (assumed major units — whole currency, not cents) have NOT been
 * confirmed against a live account; transformers read fields defensively,
 * preserve verbatim payloads on `rawNetworkData`, and carry `// TODO(verify)`
 * where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          POST /offer/list → one Programme per offer.
 *   getProgramme            client-side lookup of /offer/list by id.
 *   listTransactions        POST /conversions/list → Transaction[].
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       POST /affiliate/list → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /conversions by
 *                           (affiliate, day); clicks always 0 (conversions
 *                           carry no click data via this endpoint).
 *   listClicks              NotImplementedError — Refersion exposes click data
 *                           only via its GraphQL API, not this REST surface.
 *   generateTrackingLink    NotImplementedError — referral links belong to
 *                           individual affiliates; the merchant API does not
 *                           mint per-destination links.
 *   verifyAuth              cheap /affiliate/list probe (see auth.ts).
 */

import { refersionRequest, SLUG, type RefersionCredentials } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireCredentials,
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

const log = createLogger('refersion.adapter');
const NAME = 'Refersion';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.refersion.com',
  authModel: 'custom',
  docsUrl: 'https://www.refersion.dev/reference/welcome-to-refersion',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: built against the documented Refersion REST v2 contract but not verified against a live account. conversion / affiliate / offer field names have not been confirmed; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'Amount unit is assumed to be major currency units (whole units, not minor units / cents); if Refersion reports minor units the figures will be off by 100x. TODO(verify).',
    'advertiser + single-brand: one API key pair scopes one Refersion merchant account. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: Refersion exposes click-level data only via its separate GraphQL API, not this REST surface.',
    'generateTrackingLink is unsupported: referral links belong to individual affiliates; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /conversions grouped by (affiliate, day). Clicks are not available from /conversions and are reported as 0.',
    'List endpoints are paginated; wide pulls are capped at MAX_PAGES with a warning rather than a silent truncation.',
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
// Refersion response shapes (defensive)
// ---------------------------------------------------------------------------

interface RefersionListEnvelope {
  page?: number;
  per_page?: number;
  count?: number;
  total_pages?: number;
  results?: unknown;
  data?: unknown;
  [resource: string]: unknown;
}

interface RefersionOfferRaw {
  id?: string | number;
  name?: string;
  url?: string;
  currency?: string;
  // Refersion offers carry a commission `type` (e.g. PERCENT_OF_SALE) and `amount`.
  commission_type?: string;
  type?: string;
  amount?: number;
  default_commission?: number;
}

interface RefersionAffiliateRaw {
  id?: string | number;
  first_name?: string;
  last_name?: string;
  email?: string;
  status?: string;
  state?: string;
  created?: string;
}

interface RefersionConversionRaw {
  id?: string | number;
  currency?: string;
  // Assumed major units (whole currency) — TODO(verify).
  commission_total?: number;
  commission?: number;
  total?: number;
  amount?: number;
  status?: string;
  created?: string;
  approved?: string;
  paid?: string;
  offer_id?: string | number;
  offer_name?: string;
  affiliate?: RefersionAffiliateRaw;
  affiliate_id?: string | number;
  affiliate_email?: string;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a Refersion list response. The documented
 * shape carries a `results` array; we also tolerate `data` or a resource-named
 * key in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as RefersionListEnvelope;
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

/**
 * Decide whether another page exists. Refersion reports `total_pages` (and a
 * current `page`); we also stop when the current page returns fewer rows than
 * the page size as a backstop.
 */
function hasNextPage(body: unknown, currentPage: number, rowsThisPage: number): boolean {
  if (rowsThisPage < PAGE_SIZE) return false;
  if (body && typeof body === 'object') {
    const obj = body as RefersionListEnvelope;
    if (typeof obj.total_pages === 'number') return currentPage < obj.total_pages;
  }
  return rowsThisPage >= PAGE_SIZE;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrUndefined(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toNumber(v?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v;
}

/**
 * Map Refersion conversion status → canonical TransactionStatus.
 *   pending     → 'pending'
 *   approved    → 'approved'
 *   paid        → 'paid'
 *   reversed    → 'reversed'
 *   denied      → 'reversed' (a denied conversion will not be paid)
 *   unqualified → 'other'
 *   else        → 'other'
 */
function mapTransactionStatus(raw: RefersionConversionRaw): TransactionStatus {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'reversed':
    case 'denied':
      return 'reversed';
    default:
      return 'other';
  }
}

function mapPerformanceStatus(raw: RefersionConversionRaw): ProgrammePerformanceRow['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'reversed':
    case 'denied':
      return 'reversed';
    case 'approved':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

function mapAffiliateStatus(raw: RefersionAffiliateRaw): MediaPartner['status'] {
  switch (String(raw.status ?? raw.state ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
      return 'active';
    case 'pending':
    case 'unconfirmed':
      return 'pending';
    case 'inactive':
    case 'disabled':
    case 'denied':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function affiliateName(raw?: RefersionAffiliateRaw): string {
  if (!raw) return '';
  const full = [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  return full || raw.email || '';
}

function commissionOf(raw: RefersionConversionRaw): number {
  return toNumber(raw.commission_total ?? raw.commission);
}

function saleOf(raw: RefersionConversionRaw): number {
  return toNumber(raw.total ?? raw.amount);
}

function conversionAffiliateId(raw: RefersionConversionRaw): string {
  return String(raw.affiliate?.id ?? raw.affiliate_id ?? raw.affiliate?.email ?? raw.affiliate_email ?? '');
}

function computeAgeDays(raw: RefersionConversionRaw, now: Date = new Date()): number {
  const anchor = raw.created;
  const iso = isoOrUndefined(anchor);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: RefersionOfferRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  const amount = raw.amount ?? raw.default_commission;
  const type = String(raw.commission_type ?? raw.type ?? '').toUpperCase();
  if (typeof amount === 'number') {
    if (type.includes('PERCENT')) {
      commissionRate = { type: 'percent', value: amount };
    } else if (type) {
      commissionRate = { type: 'flat', value: amount, currency: raw.currency };
    } else {
      commissionRate = { type: 'unknown', value: amount, currency: raw.currency };
    }
  }
  return {
    id,
    name: raw.name ?? `Refersion offer ${id}`,
    network: SLUG,
    // Offers the merchant runs are active programmes by definition.
    status: 'joined',
    currency: raw.currency,
    commissionRate,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: RefersionConversionRaw, now: Date = new Date()): Transaction {
  const commission = commissionOf(raw);
  const sale = saleOf(raw) || commission;
  const currency = raw.currency ?? 'USD';

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.offer_id ?? ''),
    programmeName: raw.offer_name ?? '',
    status: mapTransactionStatus(raw),
    amount: sale,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.created) ?? new Date(0).toISOString(),
    dateApproved: isoOrUndefined(raw.approved),
    datePaid: isoOrUndefined(raw.paid),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: RefersionAffiliateRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: affiliateName(raw) || `Refersion affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: RefersionConversionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += saleOf(r) || commissionOf(r);
    commission += commissionOf(r);
    if (r.currency) currency = r.currency;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Refersion affiliate ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/conversions aggregation (per-affiliate per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class RefersionAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a page-based Refersion list resource. List endpoints
   * are POST with `{ page, per_page }` in the body. Loops while another page is
   * indicated, capped at `MAX_PAGES` — the cap is a backstop logged so a
   * truncated pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    credentials: RefersionCredentials,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await refersionRequest<RefersionListEnvelope>({
        operation,
        path,
        credentials,
        method: 'POST',
        body: { page, per_page: PAGE_SIZE },
        resilience,
      });
      const rows = extractList(body, resourceKey);
      out.push(...rows);
      if (!hasNextPage(body, page, rows.length)) return out;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'refersion pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const credentials = requireCredentials('listProgrammes');
    const raw = (await this.fetchAll('listProgrammes', '/offer/list', 'offers', credentials)) as RefersionOfferRaw[];
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
      throw configErrorFor('getProgramme', 'A Refersion offer id is required.', {
        hint: 'List programmes first (affiliate_refersion_list_programmes) to find the id.',
      });
    }
    const credentials = requireCredentials('getProgramme');
    // Refersion has no documented single-offer GET on this REST surface, so we
    // list offers and select the requested id client-side.
    const raw = (await this.fetchAll('getProgramme', '/offer/list', 'offers', credentials)) as RefersionOfferRaw[];
    const match = raw.find((o) => String(o.id ?? '') === programmeId);
    if (!match) {
      throw configErrorFor('getProgramme', `No Refersion offer found with id "${programmeId}".`, {
        hint: 'Use affiliate_refersion_list_programmes to see valid ids.',
      });
    }
    return toProgramme(match);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const credentials = requireCredentials('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/conversions/list',
      'conversions',
      credentials,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as RefersionConversionRaw[];
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
          programmeName: t.programmeName || `Refersion offer ${key}`,
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
    const credentials = requireCredentials('listMediaPartners');
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/affiliate/list',
      'affiliates',
      credentials,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as RefersionAffiliateRaw[];
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
    const credentials = requireCredentials('getProgrammePerformance');

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/conversions/list',
      'conversions',
      credentials,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as RefersionConversionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: RefersionConversionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.created);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const publisherId = conversionAffiliateId(r);
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
      'Refersion exposes click-level data only via its separate GraphQL API, not this REST surface; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Refersion referral links belong to individual affiliates; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the affiliate roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Refersion at v0.1.');
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
        note: '/affiliate/list probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/offer/list query.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: '/offer/list filtered to a known id, not probed.', claimStatus: 'experimental' },
      listTransactions: { supported: true, note: '/conversions/list query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/affiliate/list query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /conversions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'Refersion exposes clicks only via its GraphQL API, not this REST surface.' },
      generateTrackingLink: { supported: false, note: 'Referral links belong to affiliates; not minted via the merchant API.' },
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

export const refersionAdapter = new RefersionAdapter();
registerAdapter(refersionAdapter);

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
  hasNextPage,
  toNumber,
  commissionOf,
  saleOf,
};
