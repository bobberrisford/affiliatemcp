/**
 * Partnero adapter (advertiser / merchant side).
 *
 * Partnero is a SaaS referral / affiliate platform: the API is the merchant's
 * view of their own programme — the partners promoting it, the customers they
 * refer, and the transactions (and the rewards / commissions owed against
 * them). There is no publisher side; this adapter is `advertiser` +
 * `single-brand` (one API token scopes one Partnero programme).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest reference
 * (advertiser + single-brand SaaS-referral, derived media-partner roster,
 * client-side per-publisher performance aggregation). This file mirrors it.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented REST contract (Bearer auth, page-based
 * pagination with a `data` array, ISO-8601 dates, string `key` identifiers).
 * The exact field names on `transaction` / `reward` / `partner` objects and the
 * amount unit (assumed MAJOR currency units, per the PHP SDK example
 * `setAmount(99.99)` and the `is_currency` / `amount_units` fields) have not
 * been confirmed against a live account; transformers read fields defensively,
 * preserve verbatim payloads on `rawNetworkData`, and carry `// TODO(verify)`
 * where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          The token scopes one programme; Partnero exposes no
 *                           `/programs` list endpoint, so we model a single
 *                           synthetic Programme keyed on the brand context.
 *   getProgramme            The same single synthetic Programme.
 *   listTransactions        GET /transactions → Transaction[] (commission read
 *                           from the transaction's reward(s)).
 *   getEarningsSummary      derived from listTransactions.
 *   listMediaPartners       GET /partners → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /transactions by
 *                           (partner, day); clicks always 0 (transactions carry
 *                           no click data).
 *   listClicks              NotImplementedError — Partnero exposes no raw click
 *                           records via this API.
 *   generateTrackingLink    NotImplementedError — referral links belong to an
 *                           individual partner; the merchant API does not mint
 *                           per-destination links.
 *   verifyAuth              cheap /partners probe (see auth.ts).
 */

import { partneroRequest, SLUG } from './client.js';
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

const log = createLogger('partnero.adapter');
const NAME = 'Partnero';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnero.com',
  authModel: 'bearer',
  docsUrl: 'https://developers.partnero.com/reference/general.html',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'transaction / reward / partner field names and the amount unit (assumed major currency units, per the PHP SDK example setAmount(99.99) and the is_currency / amount_units fields) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one API token scopes one Partnero programme (the token is generated per programme). Bind your single brand in brands.json manually.',
    'listProgrammes / getProgramme return a single synthetic programme: Partnero has no /programs list endpoint, so the programme is modelled from the configured token and the supplied brand context.',
    'listClicks is unsupported: Partnero exposes no raw click records via this API.',
    'generateTrackingLink is unsupported: referral links belong to an individual partner; the merchant API does not mint per-destination links.',
    'getProgrammePerformance is computed client-side from /transactions grouped by (partner, day). Clicks are not available from transactions and are reported as 0.',
    'Commission per transaction is read from the transaction reward(s); a transaction with no reward contributes 0 commission.',
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
// Partnero response shapes (defensive)
// ---------------------------------------------------------------------------

interface PartneroPagination {
  current_page?: number;
  last_page?: number | null;
  per_page?: number;
  total?: number;
  from?: number | null;
  to?: number | null;
  path?: string;
}

interface PartneroListEnvelope {
  data?: unknown;
  meta?: PartneroPagination;
  links?: { next?: string | null };
  // Some Partnero list endpoints inline the pagination keys at the top level.
  current_page?: number;
  last_page?: number | null;
  per_page?: number;
  total?: number;
  [resource: string]: unknown;
}

interface PartneroPartnerRaw {
  key?: string;
  id?: string | number;
  name?: string;
  email?: string;
  status?: string;
  created_at?: string;
  deleted?: boolean;
  deleted_at?: string | null;
}

interface PartneroCustomerRaw {
  key?: string;
  name?: string;
  email?: string;
}

interface PartneroRewardRaw {
  key?: string;
  action?: string;
  status?: string; // e.g. ok / pending / approved / paid / rejected — TODO(verify)
  amount?: number; // major currency units — TODO(verify)
  amount_units?: string; // currency code, e.g. USD
  is_currency?: boolean;
  credit?: boolean;
  created_at?: string;
  deleted_at?: string | null;
}

interface PartneroTransactionRaw {
  key?: string;
  action?: string; // e.g. sale
  amount?: number; // major currency units — TODO(verify)
  amount_units?: string; // currency code
  is_currency?: boolean;
  credit?: boolean;
  partner?: PartneroPartnerRaw;
  customer?: PartneroCustomerRaw;
  rewards?: PartneroRewardRaw[];
  status?: string;
  created_at?: string;
  deleted_at?: string | null;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Pull the array of records from a Partnero list response. The documented
 * shape is `{ data: [...], <pagination> }`; we also tolerate a resource-named
 * key (`partners`, `transactions`) in case a given endpoint differs.
 */
function extractList(body: unknown, resourceKey: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as PartneroListEnvelope;
    if (Array.isArray(obj.data)) return obj.data;
    if (resourceKey && Array.isArray(obj[resourceKey])) return obj[resourceKey] as unknown[];
  }
  return [];
}

function pagination(body: unknown): PartneroPagination | undefined {
  if (body && typeof body === 'object') {
    const obj = body as PartneroListEnvelope;
    if (obj.meta && typeof obj.meta === 'object') return obj.meta;
    // Inline pagination keys.
    if (typeof obj.current_page === 'number') {
      return {
        current_page: obj.current_page,
        last_page: obj.last_page,
        per_page: obj.per_page,
        total: obj.total,
      };
    }
  }
  return undefined;
}

/** Next page index, or null when the current page is the last. */
function nextPage(body: unknown, current: number): number | null {
  const p = pagination(body);
  if (!p) return null;
  if (typeof p.last_page === 'number') {
    return current < p.last_page ? current + 1 : null;
  }
  // Without a last_page, fall back to "a full page implies maybe more".
  const list = extractList(body, '');
  const size = typeof p.per_page === 'number' ? p.per_page : PAGE_SIZE;
  return list.length >= size ? current + 1 : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrUndefined(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function num(v?: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Map a Partnero reward / transaction status → canonical TransactionStatus.
 * Partnero rewards move through review: pending review → approved → paid, with
 * rejected (or an archived / revoked transaction) reading as reversed.
 *   pending / in_review / review → 'pending'
 *   approved / ok / confirmed    → 'approved'
 *   paid                         → 'paid'
 *   rejected / declined / void / archived / revoked → 'reversed'
 *   else                         → 'other'
 */
function mapStatusString(raw?: string): TransactionStatus {
  switch (String(raw ?? '').toLowerCase()) {
    case 'pending':
    case 'in_review':
    case 'review':
    case 'pending_review':
      return 'pending';
    case 'approved':
    case 'ok':
    case 'confirmed':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'rejected':
    case 'declined':
    case 'void':
    case 'archived':
    case 'revoked':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * The transaction's canonical status comes from its primary reward where one
 * exists (rewards are what the partner is actually owed), otherwise from the
 * transaction's own status field.
 */
function mapTransactionStatus(raw: PartneroTransactionRaw): TransactionStatus {
  const reward = primaryReward(raw);
  if (reward) return mapStatusString(reward.status);
  return mapStatusString(raw.status);
}

function mapPerformanceStatus(raw: PartneroTransactionRaw): ProgrammePerformanceRow['status'] {
  switch (mapTransactionStatus(raw)) {
    case 'reversed':
      return 'reversed';
    case 'approved':
    case 'paid':
      return 'approved';
    default:
      return 'pending';
  }
}

function mapPartnerStatus(raw: PartneroPartnerRaw): MediaPartner['status'] {
  if (raw.deleted === true) return 'inactive';
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
      return 'active';
    case 'pending':
    case 'unconfirmed':
    case 'in_review':
      return 'pending';
    case 'inactive':
    case 'disabled':
    case 'rejected':
    case 'suspended':
      return 'inactive';
    default:
      return 'unknown';
  }
}

function partnerName(raw?: PartneroPartnerRaw): string {
  if (!raw) return '';
  return (raw.name ?? '').trim() || raw.email || '';
}

function partnerId(raw?: PartneroPartnerRaw): string {
  if (!raw) return '';
  return String(raw.key ?? raw.id ?? raw.email ?? '');
}

/** The reward the partner is owed against a transaction (the first, if any). */
function primaryReward(raw: PartneroTransactionRaw): PartneroRewardRaw | undefined {
  return Array.isArray(raw.rewards) && raw.rewards.length > 0 ? raw.rewards[0] : undefined;
}

/** Total commission across all rewards on a transaction, in major units. */
function rewardTotal(raw: PartneroTransactionRaw): number {
  if (!Array.isArray(raw.rewards)) return 0;
  return raw.rewards.reduce((acc, r) => acc + num(r.amount), 0);
}

function transactionCurrency(raw: PartneroTransactionRaw): string {
  return raw.amount_units ?? primaryReward(raw)?.amount_units ?? 'USD';
}

function computeAgeDays(raw: PartneroTransactionRaw, now: Date = new Date()): number {
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
 * Partnero has no `/programs` list endpoint (one token = one programme), so the
 * programme is synthesised from the supplied brand context. `rawNetworkData`
 * records that this is a synthetic record rather than an upstream payload.
 */
function toProgramme(networkBrandId: string): Programme {
  return {
    id: networkBrandId,
    name: `Partnero programme (${networkBrandId})`,
    network: SLUG,
    // The configured token scopes a live programme by definition.
    status: 'joined',
    rawNetworkData: {
      synthetic: true,
      reason: 'Partnero exposes no /programs list endpoint; the token scopes one programme.',
      networkBrandId,
    },
  };
}

function toTransaction(
  raw: PartneroTransactionRaw,
  programmeId: string,
  now: Date = new Date(),
): Transaction {
  const commission = rewardTotal(raw);
  const sale = num(raw.amount) || commission;
  const currency = transactionCurrency(raw);
  const reward = primaryReward(raw);
  const status = mapTransactionStatus(raw);

  return {
    id: String(raw.key ?? ''),
    network: SLUG,
    programmeId,
    programmeName: `Partnero programme (${programmeId})`,
    status,
    amount: sale,
    currency,
    commission,
    dateConverted: isoOrUndefined(raw.created_at) ?? new Date(0).toISOString(),
    datePaid: status === 'paid' ? isoOrUndefined(reward?.created_at ?? raw.created_at) : undefined,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: PartneroPartnerRaw): MediaPartner {
  const id = partnerId(raw);
  return {
    id,
    name: partnerName(raw) || `Partnero partner ${id}`,
    status: mapPartnerStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: PartneroTransactionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += num(r.amount) || rewardTotal(r);
    commission += rewardTotal(r);
    currency = transactionCurrency(r);
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `Partnero partner ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/transactions aggregation (per-partner per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PartneroAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a page-based Partnero list resource. Loops while the
   * pagination block reports more pages, capped at `MAX_PAGES` — the cap is a
   * backstop logged so a truncated pull is never silent (principle 4.1).
   */
  private async fetchAll(
    operation: string,
    path: string,
    resourceKey: string,
    token: string,
    resilience = RESILIENCE.default,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await partneroRequest<PartneroListEnvelope>({
        operation,
        path,
        token,
        query: { page, limit: PAGE_SIZE },
        resilience,
      });
      out.push(...extractList(body, resourceKey));
      const next = nextPage(body, page);
      if (next === null || next <= page) return out;
      page = next;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'partnero pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const { networkBrandId } = requireCtx('listProgrammes', ctx);
    let programmes = [toProgramme(networkBrandId)];

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
    const { networkBrandId } = requireCtx('getProgramme', ctx);
    if (!programmeId || programmeId.trim() === '') {
      throw configErrorFor('getProgramme', 'A Partnero programme id is required.', {
        hint: 'List programmes first (affiliate_partnero_list_programmes) to find the id.',
      });
    }
    // The token scopes a single programme; only the bound brand id is valid.
    if (programmeId !== networkBrandId) {
      throw configErrorFor(
        'getProgramme',
        `Partnero token scopes a single programme; "${programmeId}" does not match the bound brand "${networkBrandId}".`,
        { hint: 'Use affiliate_partnero_list_programmes to see the valid id.' },
      );
    }
    return toProgramme(networkBrandId);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    const { networkBrandId } = requireCtx('listTransactions', ctx);
    const token = requireApiKey('listTransactions');
    const now = new Date();
    const raw = (await this.fetchAll(
      'listTransactions',
      '/transactions',
      'transactions',
      token,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    )) as PartneroTransactionRaw[];
    let transactions = raw.map((r) => toTransaction(r, networkBrandId, now));

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
    const { networkBrandId } = requireCtx('getEarningsSummary', ctx);
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

      const key = t.programmeId || networkBrandId;
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || `Partnero programme (${key})`,
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
    )) as PartneroPartnerRaw[];
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
      '/transactions',
      'transactions',
      token,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    )) as PartneroTransactionRaw[];

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: PartneroTransactionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      const anchorIso = isoOrUndefined(r.created_at);
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      if (!Number.isNaN(anchorMs)) {
        if (!Number.isNaN(fromMs) && anchorMs < fromMs) continue;
        if (!Number.isNaN(toMs) && anchorMs > toMs) continue;
      }
      const publisherId = partnerId(r.partner);
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;

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
      'Partnero exposes no raw click records via this API; listClicks is unsupported.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: Partnero referral links belong to an individual partner; the merchant API does not mint per-destination links.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the partner roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Partnero at v0.1.');
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
      listProgrammes: {
        supported: true,
        note: 'Single synthetic programme; Partnero has no /programs list endpoint.',
        claimStatus: 'experimental',
      },
      getProgramme: {
        supported: true,
        note: 'Single synthetic programme keyed on the bound brand id.',
        claimStatus: 'experimental',
      },
      listTransactions: { supported: true, note: '/transactions query; field names TODO(verify).', claimStatus: 'experimental' },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions.', claimStatus: 'experimental' },
      listMediaPartners: { supported: true, note: '/partners query.', claimStatus: 'experimental' },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /transactions; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      listClicks: { supported: false, note: 'Partnero exposes no raw click records.' },
      generateTrackingLink: { supported: false, note: 'Referral links belong to a partner; not minted via the merchant API.' },
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

export const partneroAdapter = new PartneroAdapter();
registerAdapter(partneroAdapter);

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
  mapStatusString,
  mapTransactionStatus,
  mapPerformanceStatus,
  mapPartnerStatus,
  partnerName,
  partnerId,
  primaryReward,
  rewardTotal,
  transactionCurrency,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  extractList,
  nextPage,
  num,
};
