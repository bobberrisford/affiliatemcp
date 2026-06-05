/**
 * PartnerStack adapter (vendor / advertiser side).
 *
 * Built against the PartnerStack **Vendor API** — the view a brand has of its
 * own partner programme: the partners promoting it, the transactions they
 * generate, and the rewards (commissions) owed. The partner/publisher side
 * lives in `src/networks/partnerstack/` and speaks the separate Partner API.
 *
 * Read `src/networks/cj-advertiser/adapter.ts` first — it is the advertiser-side
 * reference (ctx threading, derived media-partner roster, client-side
 * per-publisher performance aggregation). This file mirrors that shape.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * The Vendor API auth scheme (public/secret Basic key pair) and the exact field
 * names on `reward` / `partner` objects render client-side in the docs and were
 * not confirmed against a live vendor account at commit time. Transformers read
 * a spread of plausible keys defensively and preserve the verbatim payload on
 * `rawNetworkData`. Lines needing a live check carry `// TODO(verify)`.
 *
 * --- side / credential_scope -----------------------------------------------
 *
 * `advertiser` + `single-brand`: one Vendor API key pair scopes exactly one
 * vendor account. This is the rare advertiser-single-brand corner the
 * contribute skill calls out — there is no multi-brand enumeration, so no
 * `listBrands()`. The operator binds their one brand in brands.json manually
 * (see docs/networks/partnerstack-advertiser.md).
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          synthetic: one Programme for the vendor account
 *                           (the Vendor API has no advertiser-programmes list).
 *   listTransactions        GET /rewards → Transaction[] (commissions owed to partners).
 *   getEarningsSummary      derived from listTransactions (total commission owed,
 *                           with by-programme + by-status splits).
 *   listMediaPartners       GET /partners → MediaPartner[].
 *   getProgrammePerformance client-side aggregation of /rewards by (partner, day);
 *                           clicks always 0 (rewards carry no click data).
 *   getProgramme / listClicks / generateTrackingLink → NotImplementedError.
 *   verifyAuth              cheap /partnerships probe (see auth.ts).
 */

import { partnerstackAdvRequest, SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requirePublicKey,
  requireSecretKey,
} from './auth.js';
import { setupSteps } from './setup.js';
import { requireCtx } from './internal.js';
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
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('partnerstack-advertiser.adapter');
const NAME = 'PartnerStack (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnerstack.com',
  authModel: 'basic',
  docsUrl: 'https://docs.partnerstack.com/reference',
  adapterVersion: '0.1.0',
  claimStatus: 'experimental',
  knownLimitations: [
    'Vendor API auth (public/secret Basic key pair) and reward/partner field names have not been confirmed against a live vendor account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'advertiser + single-brand: one Vendor API key pair scopes one vendor account. There is no multi-brand enumeration and no listBrands(); bind your single brand in brands.json manually.',
    'listProgrammes is synthetic: the Vendor API has no advertiser-programmes list, so the adapter returns one Programme for the bound vendor account.',
    'getProgrammePerformance is computed client-side from /rewards grouped by (partner, day). Clicks are not available from /rewards and are reported as 0.',
    'getProgramme, listClicks and generateTrackingLink are not implemented on the vendor side.',
    'Reward amounts are assumed to be minor units (cents) and divided by 100; the unit is TODO(verify).',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 6,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'single-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  listMediaPartners: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getProgrammePerformance: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getEarningsSummary: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Vendor API response shapes (defensive)
// ---------------------------------------------------------------------------

interface PartnerstackEnvelope<T> {
  data?: T;
  message?: string;
  status?: string | number;
}

interface PartnerRaw {
  key?: string;
  id?: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  created_at?: number;
}

interface RewardRaw {
  key?: string;
  id?: string;
  status?: string;
  amount?: number; // minor units — TODO(verify)
  currency?: string;
  created_at?: number;
  approved_at?: number;
  paid_at?: number;
  partner?: PartnerRaw;
  partnership?: { key?: string; partner?: PartnerRaw };
  partner_email?: string;
  group?: { name?: string; slug?: string; key?: string };
  transaction?: { amount?: number; currency?: string };
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as PartnerstackEnvelope<unknown>).data;
  }
  return body;
}

function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'rows', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function hasMore(data: unknown): boolean {
  if (data && typeof data === 'object') {
    return (data as Record<string, unknown>)['has_more'] === true;
  }
  return false;
}

function recordKey(row: { key?: string; id?: string }): string | undefined {
  return row.key ?? row.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function epochMsToIso(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function minorToMajor(amount?: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 0;
  return amount / 100;
}

/**
 * Map PartnerStack reward status → canonical TransactionStatus.
 * Same vocabulary as the partner side: pending / approved(actioned) / paid /
 * declined|voided|refunded → reversed / else other.
 */
function mapTransactionStatus(raw: RewardRaw): TransactionStatus {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'actioned':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'declined':
    case 'voided':
    case 'refunded':
      return 'reversed';
    default:
      return 'other';
  }
}

/** Map reward status to the 3-value performance status. */
function mapPerformanceStatus(raw: RewardRaw): ProgrammePerformanceRow['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'declined':
    case 'voided':
    case 'refunded':
      return 'reversed';
    case 'paid':
    case 'approved':
    case 'actioned':
      return 'approved';
    default:
      return 'pending';
  }
}

function computeAgeDays(raw: RewardRaw, now: Date = new Date()): number {
  const anchorMs = raw.approved_at ?? raw.created_at;
  if (typeof anchorMs !== 'number' || !Number.isFinite(anchorMs)) return 0;
  return Math.max(0, Math.floor((now.getTime() - anchorMs) / (1000 * 60 * 60 * 24)));
}

function partnerOf(raw: RewardRaw): PartnerRaw | undefined {
  return raw.partner ?? raw.partnership?.partner;
}

function partnerDisplayName(p?: PartnerRaw): string {
  if (!p) return '';
  if (p.name) return p.name;
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  return full || p.email || '';
}

function partnerStatus(raw: PartnerRaw): MediaPartner['status'] {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
      return 'active';
    case 'pending':
      return 'pending';
    case 'inactive':
    case 'declined':
    case 'removed':
      return 'inactive';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toTransaction(raw: RewardRaw, now: Date = new Date()): Transaction {
  const commission = minorToMajor(raw.amount);
  const sale = minorToMajor(raw.transaction?.amount) || commission;
  const currency = raw.currency ?? raw.transaction?.currency ?? 'USD';
  const partner = partnerOf(raw);

  return {
    id: String(recordKey(raw) ?? ''),
    network: SLUG,
    // No advertiser-programme concept on the vendor side; the programme is the
    // vendor account, keyed by the partner group where present.
    programmeId: String(raw.group?.slug ?? raw.group?.key ?? ''),
    programmeName: raw.group?.name ?? partnerDisplayName(partner) ?? '',
    status: mapTransactionStatus(raw),
    amount: sale,
    currency,
    commission,
    dateConverted: epochMsToIso(raw.created_at) ?? new Date(0).toISOString(),
    dateApproved: epochMsToIso(raw.approved_at),
    datePaid: epochMsToIso(raw.paid_at),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: PartnerRaw): MediaPartner {
  const id = String(recordKey(raw) ?? raw.email ?? '');
  return {
    id,
    name: partnerDisplayName(raw) || `PartnerStack partner ${id}`,
    status: partnerStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: RewardRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  // Worst-news status across the bucket: reversed > pending > approved.
  let status: ProgrammePerformanceRow['status'] = 'approved';
  let currency = 'USD';
  for (const r of rows) {
    conversions += 1;
    grossSale += minorToMajor(r.transaction?.amount) || minorToMajor(r.amount);
    commission += minorToMajor(r.amount);
    if (r.currency) currency = r.currency;
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `PartnerStack partner ${publisherId}`,
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency,
    status,
    rawNetworkData: {
      derivedFrom: '/rewards aggregation (per-partner per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PartnerstackAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  private async fetchAll<T extends { key?: string; id?: string }>(
    operation: string,
    path: string,
    publicKey: string,
    secretKey: string,
    resilience = RESILIENCE.default,
  ): Promise<T[]> {
    const out: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await partnerstackAdvRequest<PartnerstackEnvelope<unknown>>({
        operation,
        path,
        publicKey,
        secretKey,
        query: { limit: PAGE_SIZE, starting_after: startingAfter },
        resilience,
      });
      const data = unwrapData(body);
      const rows = extractList(data) as T[];
      out.push(...rows);
      if (!hasMore(data) || rows.length === 0) return out;
      const last = rows[rows.length - 1];
      const cursor = last ? recordKey(last) : undefined;
      if (!cursor) return out;
      startingAfter = cursor;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'partnerstack-advertiser pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    // Ensure credentials are configured even though we synthesise the row.
    requirePublicKey('listProgrammes');
    requireSecretKey('listProgrammes');

    const programme: Programme = {
      id: c.networkBrandId,
      name: `PartnerStack vendor ${c.networkBrandId}`,
      network: SLUG,
      status: 'joined',
      rawNetworkData: {
        derivedFrom: 'synthetic per-vendor Programme (Vendor API has no advertiser-programmes list)',
        networkBrandId: c.networkBrandId,
      },
    };
    let programmes = [programme];
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const publicKey = requirePublicKey('listTransactions');
    const secretKey = requireSecretKey('listTransactions');
    const now = new Date();

    const raw = await this.fetchAll<RewardRaw>(
      'listTransactions',
      '/rewards',
      publicKey,
      secretKey,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    );
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
          programmeName: t.programmeName || `PartnerStack programme ${key}`,
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

  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    requireCtx('listMediaPartners', ctx);
    const publicKey = requirePublicKey('listMediaPartners');
    const secretKey = requireSecretKey('listMediaPartners');

    const raw = await this.fetchAll<PartnerRaw>(
      'listMediaPartners',
      '/partners',
      publicKey,
      secretKey,
      RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    );
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
    const publicKey = requirePublicKey('getProgrammePerformance');
    const secretKey = requireSecretKey('getProgrammePerformance');

    const now = new Date();
    const to = query?.to ? Date.parse(query.to) : now.getTime();
    const from = query?.from
      ? Date.parse(query.from)
      : now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const raw = await this.fetchAll<RewardRaw>(
      'getProgrammePerformance',
      '/rewards',
      publicKey,
      secretKey,
      RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    );

    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: RewardRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of raw) {
      // Window filter against created_at where present.
      if (typeof r.created_at === 'number') {
        if (!Number.isNaN(from) && r.created_at < from) continue;
        if (!Number.isNaN(to) && r.created_at > to) continue;
      }
      const partner = partnerOf(r);
      const publisherId = String(recordKey(partner ?? {}) ?? partner?.email ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;

      const iso = epochMsToIso(r.created_at);
      const date = iso ? iso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName) existing.publisherName = partnerDisplayName(partner);
      } else {
        buckets.set(key, { date, publisherId, publisherName: partnerDisplayName(partner), rows: [r] });
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
  // Ops not implemented on the vendor side.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'PartnerStack vendor adapter does not implement getProgramme; programmes are synthetic, use listProgrammes.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'PartnerStack vendor adapter does not expose click-level data; /rewards carries no click data.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is a partner-side operation; the PartnerStack vendor adapter does not implement it.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Use listMediaPartners for the advertiser-side partner roster.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for PartnerStack vendor at v0.1.');
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
        note: '/partnerships probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: {
        supported: true,
        note: 'Synthetic per-vendor Programme (Vendor API has no advertiser-programmes list).',
        claimStatus: 'experimental',
      },
      listTransactions: {
        supported: true,
        note: '/rewards query; field names TODO(verify) against a live vendor account.',
        claimStatus: 'experimental',
      },
      getEarningsSummary: {
        supported: true,
        note: 'Derived from listTransactions.',
        claimStatus: 'experimental',
      },
      listMediaPartners: {
        supported: true,
        note: '/partners query; field names TODO(verify).',
        claimStatus: 'experimental',
      },
      getProgrammePerformance: {
        supported: true,
        note: 'Client-side aggregation from /rewards; clicks always 0 (gap).',
        claimStatus: 'experimental',
      },
      getProgramme: { supported: false, note: 'Not implemented; programmes are synthetic.' },
      listClicks: { supported: false, note: '/rewards carries no click-level data.' },
      generateTrackingLink: { supported: false, note: 'Partner-side operation; not applicable.' },
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

export const partnerstackAdvertiserAdapter = new PartnerstackAdvertiserAdapter();
registerAdapter(partnerstackAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

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
  computeAgeDays,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  partnerDisplayName,
  partnerStatus,
  unwrapData,
  extractList,
  minorToMajor,
  epochMsToIso,
};
