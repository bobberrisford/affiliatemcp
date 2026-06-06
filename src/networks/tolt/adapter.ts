/**
 * Tolt adapter (advertiser / merchant side).
 *
 * Tolt is an affiliate + referral platform for SaaS startups: the API is the
 * merchant's view of their own programme — programmes, the partners (affiliates)
 * promoting them, and the commissions owed. There is no publisher side; this
 * adapter is `advertiser` + `single-brand` (one API key scopes one Tolt
 * organisation).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest reference
 * (advertiser + single-brand SaaS-referral). This file mirrors that shape.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the public REST contract documented at https://docs.tolt.com
 * (Bearer auth, `{ success, data }` envelopes, cursor pagination via
 * `starting_after` + `has_more`, monetary amounts as integer minor units /
 * cents). The exact field names on `commission` / `partner` / `program`
 * objects and the amount unit have not been confirmed against a live account;
 * transformers read fields defensively, preserve verbatim payloads on
 * `rawNetworkData`, and carry `// TODO(verify)` where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /programs → one Programme per programme.
 *   getProgramme            GET /programs/:id → Programme.
 *   listTransactions        GET /commissions → Transaction[] (commissions owed).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /partners → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /commissions by
 *                           (partner, day); clicks always 0 (commissions carry
 *                           no click data).
 *   listClicks              NotImplementedError — Tolt commissions carry no raw
 *                           click records via this API.
 *   generateTrackingLink    NotImplementedError — referral links belong to
 *                           individual partners; the merchant API does not mint
 *                           per-destination links.
 *   verifyAuth              cheap /partners probe (see auth.ts).
 */

import { toltRequest, SLUG } from './client.js';
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

const log = createLogger('tolt.adapter');
const NAME = 'Tolt';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.tolt.com',
  authModel: 'bearer',
  docsUrl: 'https://docs.tolt.com/introduction',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'commission / partner / program field names and the amount unit (assumed minor units / cents, divided by 100) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one API key scopes one Tolt organisation (one merchant programme). Bind your single brand in brands.json manually.',
    'listClicks is unsupported: Tolt commissions carry no raw click records via this API.',
    'generateTrackingLink is unsupported: referral links belong to individual partners; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /commissions grouped by (partner, day). Clicks are not available from /commissions and are reported as 0.',
    'Pagination is cursor-based (starting_after + has_more) and capped at MAX_PAGES with a warning rather than a silent truncation.',
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
// Tolt response shapes (defensive)
// ---------------------------------------------------------------------------

interface ToltListEnvelope {
  success?: boolean;
  has_more?: boolean;
  data?: unknown;
  [resource: string]: unknown;
}

interface ToltProgramRaw {
  id?: string;
  name?: string;
  url?: string;
  currency?: string;
  // Commission rate may surface as a percent or a flat per-referral amount.
  commission_type?: string; // 'percentage' | 'fixed' — TODO(verify)
  commission_amount?: number; // minor units (cents) when fixed — TODO(verify)
  commission_percent?: number;
}

interface ToltPartnerRaw {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  name?: string;
  status?: string;
  created_at?: string;
}

interface ToltCustomerRaw {
  id?: string;
  name?: string;
  email?: string;
}

interface ToltCommissionRaw {
  id?: string;
  currency?: string;
  amount?: number; // minor units (cents) — TODO(verify)
  status?: string;
  created_at?: string;
  updated_at?: string;
  paid_at?: string;
  approved_at?: string;
  program_id?: string;
  partner_id?: string;
  customer_id?: string;
  program?: ToltProgramRaw;
  partner?: ToltPartnerRaw;
  customer?: ToltCustomerRaw;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a Tolt list response. The documented shape is
 * `{ success, data: [...] }`; we also tolerate a resource-named key
 * (`partners`, `programs`, `commissions`) in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as ToltListEnvelope;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

function hasMore(body: unknown): boolean {
  if (body && typeof body === 'object') {
    return (body as ToltListEnvelope).has_more === true;
  }
  return false;
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
 * Map Tolt commission status → canonical TransactionStatus.
 *   pending  → 'pending'
 *   approved → 'approved'
 *   paid     → 'paid'   (commission paid out via a payout)
 *   rejected → 'reversed'
 *   refunded → 'reversed'
 *   else     → 'other'
 */
function mapTransactionStatus(raw: ToltCommissionRaw): TransactionStatus {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'rejected':
    case 'refunded':
      return 'reversed';
    default:
      return 'other';
  }
}

function mapPerformanceStatus(raw: ToltCommissionRaw): ProgrammePerformanceRow['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'rejected':
    case 'refunded':
      return 'reversed';
    case 'approved':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

/**
 * Map Tolt partner status → canonical MediaPartner status.
 *   active    → 'active'
 *   pending   → 'pending'
 *   suspended → 'inactive'
 *   else      → 'unknown'
 */
function mapPartnerStatus(raw: ToltPartnerRaw): MediaPartner['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'pending':
      return 'pending';
    case 'suspended':
    case 'inactive':
    case 'blocked':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function partnerName(raw?: ToltPartnerRaw): string {
  if (!raw) return '';
  if (raw.name && raw.name.trim()) return raw.name.trim();
  const full = [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  return full || raw.email || '';
}

function computeAgeDays(raw: ToltCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.approved_at ?? raw.created_at;
  const iso = isoOrUndefined(anchor);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ToltProgramRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  if (typeof raw.commission_percent === 'number') {
    commissionRate = { type: 'percent', value: raw.commission_percent };
  } else if (typeof raw.commission_amount === 'number') {
    commissionRate = {
      type: 'flat',
      value: minorToMajor(raw.commission_amount),
      currency: raw.currency,
    };
  }
  return {
    id,
    name: raw.name ?? `Tolt programme ${id}`,
    network: SLUG,
    // Tolt programmes the merchant owns are active programmes by definition.
    status: 'joined',
    currency: raw.currency,
    commissionRate,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ToltCommissionRaw, now: Date = new Date()): Transaction {
  const commission = minorToMajor(raw.amount);
  const currency = raw.currency ?? 'USD';
  const programmeId = String(raw.program_id ?? raw.program?.id ?? '');

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId,
    programmeName: raw.program?.name ?? '',
    status: mapTransactionStatus(raw),
    // Tolt commissions carry the commission amount; the gross sale value is not
    // reliably exposed, so we surface the commission as the amount too.
    amount: commission,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.created_at) ?? new Date(0).toISOString(),
    dateApproved: isoOrUndefined(raw.approved_at),
    datePaid: isoOrUndefined(raw.paid_at),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: ToltPartnerRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: partnerName(raw) || `Tolt partner ${id}`,
    status: mapPartnerStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: ToltCommissionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += minorToMajor(r.amount);
    commission += minorToMajor(r.amount);
    if (r.currency) currency = r.currency;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Tolt partner ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/commissions aggregation (per-partner per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ToltAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a cursor-based Tolt list resource. Loops while
   * `has_more` is true, using the last record id as the `starting_after`
   * cursor, capped at `MAX_PAGES` — the cap is a backstop logged so a truncated
   * pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    token: string,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let startingAfter: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await toltRequest<ToltListEnvelope>({
        operation,
        path,
        token,
        query: { limit: PAGE_SIZE, starting_after: startingAfter },
        resilience,
      });
      const batch = extractList(body, resourceKey);
      out.push(...batch);
      if (!hasMore(body) || batch.length === 0) return out;
      const last = batch[batch.length - 1] as { id?: string } | undefined;
      const nextCursor = last?.id;
      if (!nextCursor) return out;
      startingAfter = String(nextCursor);
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'tolt pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const token = requireApiKey('listProgrammes');
    const raw = (await this.fetchAll('listProgrammes', '/programs', 'programs', token)) as ToltProgramRaw[];
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
      throw configErrorFor('getProgramme', 'A Tolt programme id is required.', {
        hint: 'List programmes first (affiliate_tolt_list_programmes) to find the id.',
      });
    }
    const token = requireApiKey('getProgramme');
    const body = await toltRequest<ToltProgramRaw | { data?: ToltProgramRaw }>({
      operation: 'getProgramme',
      path: `/programs/${encodeURIComponent(programmeId)}`,
      token,
      resilience: RESILIENCE.default,
    });
    const flat = (body as { data?: ToltProgramRaw })?.data ?? (body as ToltProgramRaw);
    if (!flat || !flat.id) {
      throw configErrorFor('getProgramme', `No Tolt programme found with id "${programmeId}".`, {
        hint: 'Use affiliate_tolt_list_programmes to see valid ids.',
      });
    }
    return toProgramme(flat);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const token = requireApiKey('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/commissions',
      'commissions',
      token,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as ToltCommissionRaw[];
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
          programmeName: t.programmeName || `Tolt programme ${key}`,
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
    const token = requireApiKey('listMediaPartners');
    const raw = (await this.fetchAll(
      'listMediaPartners',
      '/partners',
      'partners',
      token,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as ToltPartnerRaw[];
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
    const token = requireApiKey('getProgrammePerformance');

    const now = new Date();
    const toMs = query?.to ? Date.parse(query.to) : now.getTime();
    const fromMs = query?.from ? Date.parse(query.from) : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/commissions',
      'commissions',
      token,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as ToltCommissionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: ToltCommissionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.created_at);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const publisherId = String(r.partner_id ?? r.partner?.id ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;
      if (query?.programmeId && String(r.program_id ?? r.program?.id ?? '') !== query.programmeId) {
        continue;
      }

      const date = anchorIso ? anchorIso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName) existing.publisherName = partnerName(r.partner);
      } else {
        buckets.set(key, { date, publisherId, publisherName: partnerName(r.partner), rows: [r] });
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
      'Tolt commissions carry no raw click records via this API; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Tolt referral links belong to individual partners; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the partner roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Tolt at v0.1.');
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
        note: '/partners probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: '/programs query.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: '/programs/:id; requires a known id, not probed.', claimStatus: 'experimental' },
      listTransactions: { supported: true, note: '/commissions query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/partners query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /commissions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'Tolt commissions carry no raw click records.' },
      generateTrackingLink: { supported: false, note: 'Referral links belong to partners; not minted via the merchant API.' },
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

export const toltAdapter = new ToltAdapter();
registerAdapter(toltAdapter);

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
  mapPartnerStatus,
  partnerName,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  extractList,
  hasMore,
  minorToMajor,
};
