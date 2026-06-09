/**
 * Tapfiliate adapter (advertiser / merchant side).
 *
 * Tapfiliate is a mid-market SaaS affiliate platform: the API is the merchant's
 * view of their own programme(s) — the affiliates promoting them, the
 * conversions they drove, and the commissions owed. There is no publisher side;
 * this adapter is `advertiser` + `single-brand` (one API key scopes one
 * Tapfiliate account).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest reference
 * (advertiser + single-brand, ctx threading, derived media-partner roster,
 * client-side per-publisher performance aggregation). This file mirrors that
 * shape. `src/networks/awin/adapter.ts` is the canonical reference for the
 * cardinal rules.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented REST contract (X-Api-Key header, `/1.6` prefix,
 * 1-based `?page=` pagination with the next-page link in the `Link` header,
 * ISO-8601 dates, decimal major-unit amounts). The exact field names on
 * `conversion` / `commission` / `affiliate` / `program` objects have not been
 * confirmed against a live account; transformers read fields defensively,
 * preserve verbatim payloads on `rawNetworkData`, and carry `// TODO(verify)`
 * where unconfirmed.
 *
 * Amount unit: Tapfiliate documents amounts as decimal major units (e.g.
 * `"amount": 100.0`), so this adapter passes amounts through verbatim and does
 * NOT divide by 100 (contrast with Rewardful's cents). TODO(verify) against a
 * live account.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /programs/ → one Programme per programme.
 *   getProgramme            GET /programs/:id/ → Programme.
 *   listTransactions        GET /conversions/ → Transaction[] (one per
 *                           conversion; commission = sum of its commissions;
 *                           status normalised from commission `approved` flags).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /affiliates/ → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /conversions by
 *                           (affiliate, day); clicks always 0 (conversions
 *                           carry no click totals).
 *   listClicks              NotImplementedError — Tapfiliate's clicks endpoint
 *                           is POST-only (it creates a click); there is no
 *                           documented list-clicks endpoint on the merchant API.
 *   generateTrackingLink    NotImplementedError — tracking links belong to
 *                           individual affiliates; the merchant API does not
 *                           mint per-destination links.
 *   verifyAuth              cheap /programs/ probe (see auth.ts).
 */

import { tapfiliateRequest, SLUG } from './client.js';
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

const log = createLogger('tapfiliate.adapter');
const NAME = 'Tapfiliate';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.tapfiliate.com',
  authModel: 'custom',
  docsUrl: 'https://tapfiliate.com/docs/rest/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'experimental: conversion / commission / affiliate / programme field names have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'amount unit: Tapfiliate documents amounts as decimal major units (e.g. "amount": 100.0), so this adapter passes amounts through verbatim and does not divide by 100. TODO(verify) against a live account.',
    'advertiser + single-brand: one API key scopes one Tapfiliate account. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: Tapfiliate exposes a POST clicks endpoint that records a click, but no documented list-clicks endpoint on the merchant API.',
    'generateTrackingLink is unsupported: tracking links belong to individual affiliates; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /conversions grouped by (affiliate, day). Clicks are not available from /conversions and are reported as 0.',
    'Pagination is 1-based via ?page= (the next-page link is in the Link header) and is capped at MAX_PAGES with a warning rather than a silent truncation.',
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

const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Tapfiliate response shapes (defensive)
// ---------------------------------------------------------------------------

interface TapfiliateProgramRaw {
  id?: string;
  title?: string;
  name?: string;
  currency?: string;
  url?: string;
  // Default-action commission shape varies; we read the common forms defensively.
  commission?: number; // TODO(verify) — may be flat amount
  commission_type?: string; // 'percentage' | 'fixed' | ...
  default_payout_amount?: number; // TODO(verify)
}

interface TapfiliateAffiliateRaw {
  id?: string;
  firstname?: string;
  lastname?: string;
  company?: { name?: string } | string;
  email?: string;
  state?: string;
  approved?: boolean | null;
  created_at?: string;
}

interface TapfiliateCommissionRaw {
  id?: string;
  amount?: number; // decimal major units — TODO(verify)
  /** null = pending, true = approved, false = disapproved. TODO(verify). */
  approved?: boolean | null;
  kind?: string;
  payout?: { id?: string } | null;
  created_at?: string;
}

interface TapfiliateConversionRaw {
  id?: string;
  created_at?: string;
  amount?: number; // sale amount, decimal major units — TODO(verify)
  external_id?: string;
  program?: TapfiliateProgramRaw;
  affiliate?: TapfiliateAffiliateRaw;
  commissions?: TapfiliateCommissionRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrUndefined(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function num(v?: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Map a Tapfiliate commission `approved` flag → canonical TransactionStatus.
 * Tapfiliate models approval as a tri-state on each commission:
 *   null      → 'pending'  (awaiting approval — the default)
 *   true      → 'approved'
 *   false     → 'reversed' (disapproved / voided)
 * A commission attached to a payout is treated as 'paid'. TODO(verify).
 */
function mapCommissionStatus(c: TapfiliateCommissionRaw): TransactionStatus {
  if (c.payout && (c.payout as { id?: string }).id) return 'paid';
  if (c.approved === true) return 'approved';
  if (c.approved === false) return 'reversed';
  return 'pending';
}

/**
 * A conversion can carry several commissions (e.g. multi-level). The canonical
 * Transaction status is the "weakest" / most cautionary across them:
 *   any reversed  → 'reversed'
 *   else any pending → 'pending'
 *   else all paid → 'paid'
 *   else → 'approved'
 */
function mapConversionStatus(raw: TapfiliateConversionRaw): TransactionStatus {
  const statuses = (raw.commissions ?? []).map(mapCommissionStatus);
  if (statuses.length === 0) return 'pending';
  if (statuses.includes('reversed')) return 'reversed';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.every((s) => s === 'paid')) return 'paid';
  return 'approved';
}

function mapPerformanceStatus(raw: TapfiliateConversionRaw): ProgrammePerformanceRow['status'] {
  const s = mapConversionStatus(raw);
  if (s === 'reversed') return 'reversed';
  if (s === 'pending') return 'pending';
  return 'approved';
}

function mapAffiliateStatus(raw: TapfiliateAffiliateRaw): MediaPartner['status'] {
  if (raw.approved === true) return 'active';
  if (raw.approved === false) return 'inactive';
  switch (String(raw.state ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
      return 'active';
    case 'pending':
    case 'unconfirmed':
      return 'pending';
    case 'inactive':
    case 'disabled':
    case 'disapproved':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function companyName(c?: { name?: string } | string): string | undefined {
  if (!c) return undefined;
  return typeof c === 'string' ? c : c.name;
}

function affiliateName(raw?: TapfiliateAffiliateRaw): string {
  if (!raw) return '';
  const full = [raw.firstname, raw.lastname].filter(Boolean).join(' ').trim();
  return full || companyName(raw.company) || raw.email || '';
}

/** Sum of the commission amounts on a conversion (decimal major units). */
function totalCommission(raw: TapfiliateConversionRaw): number {
  return (raw.commissions ?? []).reduce((acc, c) => acc + num(c.amount), 0);
}

function computeAgeDays(raw: TapfiliateConversionRaw, now: Date = new Date()): number {
  const iso = isoOrUndefined(raw.created_at);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: TapfiliateProgramRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  const kind = String(raw.commission_type ?? '').toLowerCase();
  if (typeof raw.commission === 'number') {
    if (kind === 'percentage' || kind === 'percent') {
      commissionRate = { type: 'percent', value: raw.commission };
    } else if (kind === 'fixed' || kind === 'flat') {
      commissionRate = { type: 'flat', value: raw.commission, currency: raw.currency };
    } else {
      commissionRate = { type: 'unknown', value: raw.commission, currency: raw.currency };
    }
  }
  return {
    id,
    name: raw.title ?? raw.name ?? `Tapfiliate programme ${id}`,
    network: SLUG,
    // Programmes the merchant owns on Tapfiliate are active by definition.
    status: 'joined',
    currency: raw.currency,
    commissionRate,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: TapfiliateConversionRaw, now: Date = new Date()): Transaction {
  const commission = totalCommission(raw);
  const amount = num(raw.amount) || commission;
  const currency = raw.program?.currency ?? 'USD';
  const paidCommission = (raw.commissions ?? []).find(
    (c) => c.payout && (c.payout as { id?: string }).id,
  );

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.program?.id ?? ''),
    programmeName: raw.program?.title ?? raw.program?.name ?? '',
    status: mapConversionStatus(raw),
    amount,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.created_at) ?? new Date(0).toISOString(),
    datePaid: paidCommission ? isoOrUndefined(paidCommission.created_at) : undefined,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: TapfiliateAffiliateRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: affiliateName(raw) || `Tapfiliate affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: TapfiliateConversionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += num(r.amount) || totalCommission(r);
    commission += totalCommission(r);
    if (r.program?.currency) currency = r.program.currency;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Tapfiliate affiliate ${publisherId}`,
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

export class TapfiliateAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a page-based Tapfiliate list resource. Tapfiliate list
   * endpoints return a bare JSON array and advertise further pages via a
   * rel="next" link in the `Link` response header. We loop, incrementing the
   * 1-based `page` query parameter, while a next link is present — capped at
   * `MAX_PAGES`, a backstop logged so a truncated pull is never silent
   * (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    apiKey: string,
    query: Record<string, string | number | boolean | undefined> = {},
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const { body, hasNextPage } = await tapfiliateRequest<unknown>({
        operation,
        path,
        apiKey,
        query: { ...query, page },
        resilience,
      });
      if (Array.isArray(body)) out.push(...body);
      if (!hasNextPage) return out;
      page += 1;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'tapfiliate pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const apiKey = requireApiKey('listProgrammes');
    const raw = (await this.fetchAll('listProgrammes', '/programs/', apiKey)) as TapfiliateProgramRaw[];
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
      throw configErrorFor('getProgramme', 'A Tapfiliate programme id is required.', {
        hint: 'List programmes first (affiliate_tapfiliate_list_programmes) to find the id.',
      });
    }
    const apiKey = requireApiKey('getProgramme');
    const { body } = await tapfiliateRequest<TapfiliateProgramRaw>({
      operation: 'getProgramme',
      path: `/programs/${encodeURIComponent(programmeId)}/`,
      apiKey,
      resilience: RESILIENCE.default,
    });
    if (!body || !body.id) {
      throw configErrorFor('getProgramme', `No Tapfiliate programme found with id "${programmeId}".`, {
        hint: 'Use affiliate_tapfiliate_list_programmes to see valid ids.',
      });
    }
    return toProgramme(body);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const apiKey = requireApiKey('listTransactions');
    const now = new Date();

    // Tapfiliate /conversions accepts date_from / date_to (YYYY-MM-DD) server-side.
    const serverQuery: Record<string, string | number | undefined> = {};
    if (query?.from) serverQuery['date_from'] = query.from.slice(0, 10);
    if (query?.to) serverQuery['date_to'] = query.to.slice(0, 10);
    if (query?.programmeId) serverQuery['program_id'] = query.programmeId;

    const raw = (await this.fetchAll(
      'listTransactions',
      '/conversions/',
      apiKey,
      serverQuery,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as TapfiliateConversionRaw[];
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
          programmeName: t.programmeName || `Tapfiliate programme ${key}`,
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
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/affiliates/',
      apiKey,
      {},
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as TapfiliateAffiliateRaw[];
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

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const serverQuery: Record<string, string | number | undefined> = {};
    if (query?.from) serverQuery['date_from'] = query.from.slice(0, 10);
    if (query?.to) serverQuery['date_to'] = query.to.slice(0, 10);
    if (query?.programmeId) serverQuery['program_id'] = query.programmeId;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/conversions/',
      apiKey,
      serverQuery,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as TapfiliateConversionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: TapfiliateConversionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.created_at);
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
      "Tapfiliate's clicks endpoint is POST-only (it records a click); there is no documented list-clicks endpoint on the merchant API, so listClicks is unsupported.",
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Tapfiliate tracking links belong to individual affiliates; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the affiliate roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Tapfiliate at v0.1.');
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
        note: '/programs/ probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/programs/ query.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: '/programs/:id/; requires a known id, not probed.', claimStatus: 'experimental' },
      listTransactions: { supported: true, note: '/conversions/ query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/affiliates/ query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /conversions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'Tapfiliate clicks endpoint is POST-only; no list-clicks endpoint.' },
      generateTrackingLink: { supported: false, note: 'Tracking links belong to affiliates; not minted via the merchant API.' },
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

export const tapfiliateAdapter = new TapfiliateAdapter();
registerAdapter(tapfiliateAdapter);

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
  mapCommissionStatus,
  mapConversionStatus,
  mapPerformanceStatus,
  mapAffiliateStatus,
  affiliateName,
  totalCommission,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
};
