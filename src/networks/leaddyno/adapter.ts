/**
 * LeadDyno adapter (advertiser / merchant side).
 *
 * LeadDyno is a SaaS affiliate-tracking platform used by the merchant: the API
 * is the merchant's view of their own programme — the affiliates promoting it,
 * the purchases those affiliates referred, and the commissions owed. There is
 * no publisher side; this adapter is `advertiser` + `single-brand` (one private
 * key scopes one LeadDyno account).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest reference
 * (advertiser + single-brand SaaS-referral, ctx threading, derived media-partner
 * roster, client-side per-publisher performance aggregation). This file mirrors
 * that shape. Awin (`src/networks/awin/adapter.ts`) is the canonical reference
 * for the cardinal rules.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the public REST docs (private key as the `key` query parameter,
 * page-based pagination 100/page, ISO-8601 dates, bare JSON-array list
 * responses). The exact field names on `purchase` / `affiliate` / `commission`
 * objects and the amount unit (assumed MAJOR units, e.g. 49.0 = 49.00, per the
 * documented purchase examples) have not been confirmed against a live account;
 * transformers read fields defensively, preserve verbatim payloads on
 * `rawNetworkData`, and carry `// TODO(verify)` where unconfirmed.
 *
 * --- Modelling ------------------------------------------------------------
 *
 * LeadDyno does not expose a multi-campaign concept via this API: one account
 * is one programme. listProgrammes/getProgramme therefore synthesise a single
 * Programme representing the merchant account (id `account`).
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          → one synthetic Programme for the account.
 *   getProgramme            → the same synthetic Programme (id `account`).
 *   listTransactions        GET /purchases → Transaction[] (referred purchases).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /affiliates → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /purchases by
 *                           (affiliate, day); clicks always 0 (purchases carry
 *                           no click data).
 *   listClicks              NotImplementedError — LeadDyno tracks visitors and
 *                           leads, not raw click records, via this API.
 *   generateTrackingLink    NotImplementedError — affiliate links belong to
 *                           individual affiliates (affiliate_url); the merchant
 *                           API does not mint per-destination links.
 *   verifyAuth              cheap /affiliates probe (see auth.ts).
 */

import { leaddynoRequest, SLUG } from './client.js';
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

const log = createLogger('leaddyno.adapter');
const NAME = 'LeadDyno';

/** The single synthetic programme id for the merchant account. */
const ACCOUNT_PROGRAMME_ID = 'account';
/** LeadDyno purchases carry no currency; default until a live account confirms it. TODO(verify). */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.leaddyno.com',
  authModel: 'custom',
  docsUrl: 'https://app.theneo.io/leaddyno/leaddyno-rest-api',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'Authentication is a private key passed as the `key` query parameter (auth_model: custom), not a bearer or basic header.',
    'advertiser + single-brand: one private key scopes one LeadDyno (merchant) account. Bind your single brand in brands.json manually.',
    'LeadDyno exposes no multi-campaign concept via this API: one account is one programme. listProgrammes/getProgramme synthesise a single Programme (id `account`).',
    'Transactions are derived from GET /purchases. Purchases carry purchase_amount and a cancelled flag but no per-purchase commission or currency; commission falls back to commission_amount_override when present and currency to a default. Per-affiliate commission status (pending/due/paid) lives on the separate /commissions resource. TODO(verify).',
    'Amount unit is assumed to be major units (e.g. 49.0 = 49.00), not minor units / cents, per the documented purchase examples. TODO(verify).',
    'listClicks is unsupported: LeadDyno tracks visitors and leads, not raw click records, via this API.',
    'generateTrackingLink is unsupported: affiliate links belong to individual affiliates (affiliate_url); the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /purchases grouped by (affiliate, day). Clicks are not available from /purchases and are reported as 0.',
    'Pagination is page-based, 100 records per page, sorted oldest-first. Pagination is capped at MAX_PAGES with a warning rather than a silent truncation.',
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
// LeadDyno response shapes (defensive — documented field names)
// ---------------------------------------------------------------------------

interface LeadDynoAffiliateRaw {
  id?: number | string;
  email?: string;
  first_name?: string;
  last_name?: string;
  state?: string; // 'active' | 'pending' | 'archived' (verify)
  status?: string; // tolerate either key
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
  affiliate_url?: string;
  affiliate_dashboard_url?: string;
}

interface LeadDynoPlanRaw {
  id?: number | string;
  code?: string;
}

interface LeadDynoLeadRaw {
  id?: number | string;
  email?: string;
}

interface LeadDynoPurchaseRaw {
  id?: number | string;
  created_at?: string;
  updated_at?: string;
  cancelled?: boolean;
  purchase_code?: string;
  note?: string | null;
  purchase_amount?: number | string | null;
  commission_amount_override?: number | string | null;
  cancellation?: { id?: number | string } | null;
  lead?: LeadDynoLeadRaw | null;
  affiliate?: LeadDynoAffiliateRaw | null;
  plan?: LeadDynoPlanRaw | null;
}

// ---------------------------------------------------------------------------
// List extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a LeadDyno list response. The documented shape
 * is a bare JSON array; we also tolerate a `{ data: [...] }` or resource-named
 * envelope in case a given endpoint differs.
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

/** Coerce a documented numeric-or-string amount to a finite number (major units). */
function toAmount(v?: number | string | null): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Map a LeadDyno purchase to a canonical TransactionStatus. Purchases carry a
 * boolean `cancelled` rather than a commission lifecycle (pending/due/paid lives
 * on the separate /commissions resource). We map conservatively:
 *   cancelled === true  → 'reversed'
 *   otherwise           → 'approved' (the purchase stands)
 */
function mapTransactionStatus(raw: LeadDynoPurchaseRaw): TransactionStatus {
  return raw.cancelled === true ? 'reversed' : 'approved';
}

function mapPerformanceStatus(raw: LeadDynoPurchaseRaw): ProgrammePerformanceRow['status'] {
  return raw.cancelled === true ? 'reversed' : 'approved';
}

function mapAffiliateStatus(raw: LeadDynoAffiliateRaw): MediaPartner['status'] {
  if (raw.archived === true) return 'inactive';
  switch (String(raw.state ?? raw.status ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
      return 'active';
    case 'pending':
    case 'unapproved':
      return 'pending';
    case 'archived':
    case 'rejected':
    case 'inactive':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function affiliateName(raw?: LeadDynoAffiliateRaw | null): string {
  if (!raw) return '';
  const full = [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  return full || raw.email || '';
}

function computeAgeDays(raw: LeadDynoPurchaseRaw, now: Date = new Date()): number {
  const iso = isoOrUndefined(raw.created_at);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

/**
 * The single synthetic programme representing the merchant account. LeadDyno's
 * API does not expose campaigns, so there is exactly one programme.
 */
function accountProgramme(): Programme {
  return {
    id: ACCOUNT_PROGRAMME_ID,
    name: `${NAME} programme`,
    network: SLUG,
    // The merchant's own account is an active programme by definition.
    status: 'joined',
    rawNetworkData: {
      note: 'LeadDyno exposes no campaign objects via this API; one account is one programme.',
    },
  };
}

function toTransaction(raw: LeadDynoPurchaseRaw, now: Date = new Date()): Transaction {
  const amount = toAmount(raw.purchase_amount);
  // Purchases do not carry the computed commission; commission_amount_override
  // is the only commission figure on the object. 0 when unset. TODO(verify).
  const commission = toAmount(raw.commission_amount_override);
  return {
    id: String(raw.id ?? raw.purchase_code ?? ''),
    network: SLUG,
    programmeId: ACCOUNT_PROGRAMME_ID,
    programmeName: `${NAME} programme`,
    status: mapTransactionStatus(raw),
    amount,
    currency: DEFAULT_CURRENCY,
    commission,
    dateConverted: isoOrUndefined(raw.created_at) ?? new Date(0).toISOString(),
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: LeadDynoAffiliateRaw): MediaPartner {
  const id = String(raw.id ?? raw.email ?? '');
  return {
    id,
    name: affiliateName(raw) || `LeadDyno affiliate ${id}`,
    status: mapAffiliateStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: LeadDynoPurchaseRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  for (const r of rows) {
    conversions += 1;
    grossSale += toAmount(r.purchase_amount);
    commission += toAmount(r.commission_amount_override);
    if (mapPerformanceStatus(r) === 'reversed') status = 'reversed';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `LeadDyno affiliate ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency: DEFAULT_CURRENCY,
    status,
    rawNetworkData: {
      derivedFrom: '/purchases aggregation (per-affiliate per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class LeadDynoAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a page-based LeadDyno list resource. LeadDyno returns
   * 100 records per page sorted oldest-first and carries no pagination metadata,
   * so we loop until a short (< PAGE_SIZE) or empty page, capped at `MAX_PAGES`.
   * The cap is a backstop logged so a truncated pull is never silent (4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    apiKey: string,
    extraQuery: Record<string, string | number | boolean | undefined>,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await leaddynoRequest<unknown>({
        operation,
        path,
        apiKey,
        query: { ...extraQuery, page },
        resilience,
      });
      const batch = extractList(body, resourceKey);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) return out;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'leaddyno pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    // No API call: LeadDyno has a single programme (the account).
    let programmes = [accountProgramme()];
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
    if (programmeId && programmeId !== ACCOUNT_PROGRAMME_ID) {
      throw configErrorFor(
        'getProgramme',
        `LeadDyno exposes a single programme with id "${ACCOUNT_PROGRAMME_ID}"; got "${programmeId}".`,
        { hint: 'Use affiliate_leaddyno_list_programmes to see the programme id.' },
      );
    }
    return accountProgramme();
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const apiKey = requireApiKey('listTransactions');
    const now = new Date();

    // GET /purchases supports created_after / created_before date filters; pass
    // them through when provided so the network does the windowing.
    const extra: Record<string, string | number | boolean | undefined> = {};
    if (query?.from) extra['created_after'] = query.from;
    if (query?.to) extra['created_before'] = query.to;

    const raw = (await this.fetchAll(
      'listTransactions',
      '/purchases',
      'purchases',
      apiKey,
      extra,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as LeadDynoPurchaseRaw[];
    let transactions = raw.map((r) => toTransaction(r, now));

    // Client-side date narrowing as a backstop in case the server-side filters
    // are inclusive/exclusive differently than we assume.
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
      currency: DEFAULT_CURRENCY,
    };
    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;
      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || ACCOUNT_PROGRAMME_ID;
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || `${NAME} programme`,
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
      currency: firstCurrency ?? DEFAULT_CURRENCY,
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
      '/affiliates',
      'affiliates',
      apiKey,
      {},
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    )) as LeadDynoAffiliateRaw[];
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

    const extra: Record<string, string | number | boolean | undefined> = {};
    if (query?.from) extra['created_after'] = query.from;
    if (query?.to) extra['created_before'] = query.to;

    const raw = (await this.fetchAll(
      'getProgrammePerformance',
      '/purchases',
      'purchases',
      apiKey,
      extra,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as LeadDynoPurchaseRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: LeadDynoPurchaseRaw[];
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
      'LeadDyno tracks visitors and leads, not raw click records, via this API; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: LeadDyno affiliate links belong to individual affiliates (affiliate_url); the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the affiliate roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for LeadDyno at v0.1.');
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
      listProgrammes: {
        supported: true,
        note: 'Synthetic single programme (the account); no API call.',
        claimStatus: 'experimental',
      },
      getProgramme: {
        supported: true,
        note: 'Synthetic single programme (id `account`); no API call.',
        claimStatus: 'experimental',
      },
      listTransactions: {
        supported: true,
        note: '/purchases query; field names and amount unit TODO(verify).',
        claimStatus: 'experimental',
      },
      getEarningsSummary: {
        supported: true,
        note: 'Derived from listTransactions.',
        claimStatus: 'experimental',
      },
      listMediaPartners: { supported: true, note: '/affiliates query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /purchases; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'LeadDyno exposes visitors and leads, not raw clicks.' },
      generateTrackingLink: {
        supported: false,
        note: 'Affiliate links belong to affiliates; not minted via the merchant API.',
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

export const leaddynoAdapter = new LeadDynoAdapter();
registerAdapter(leaddynoAdapter);

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
  accountProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  extractList,
  toAmount,
};
