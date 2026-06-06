/**
 * Profitshare adapter — publisher side, single-brand, Romania (RO).
 *
 * Pattern source: `src/networks/awin/adapter.ts` (read its header first). The
 * one structural difference is auth: Profitshare signs every request with an
 * HMAC-SHA1 signature rather than carrying a bearer token. The signing lives in
 * `client.ts`; this adapter only declares operations and transforms responses.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — advertisers / affiliate programmes (affiliate-advertisers)
 *   getProgramme        — single advertiser drill-down (client-side from the list)
 *   listTransactions    — commissions (affiliate-commissions); paged + date-filtered
 *   getEarningsSummary  — client-side aggregation over listTransactions
 *   listClicks          — NotImplementedError (not exposed by the public API)
 *   generateTrackingLink— NotImplementedError (needs the affiliate-links POST endpoint;
 *                         not deterministically constructible, unverified)
 *   verifyAuth          — cheap signed call (affiliate-advertisers)
 *
 * --- Honesty note (PRD principle 4.1) ---------------------------------------
 *
 * This adapter is EXPERIMENTAL. The affiliate endpoint shapes are inferred from
 * the public reference client (https://github.com/ConversionMarketing/profitshare-api)
 * and the documentation at https://doc.profitshare.com/. Field names and the
 * amount unit have not been confirmed against a live account. Every transformer
 * reads fields defensively and preserves the verbatim payload on
 * `rawNetworkData` so the user always sees what Profitshare actually returned.
 *
 * --- Cardinal rules (same as Awin) ------------------------------------------
 *   1. NEVER call `fetch` directly — go through `profitshareRequest`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response in `rawNetworkData`.
 *   4. NORMALISE status enums; prefer 'other'/'unknown' over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction.
 *   6. UK English; the noun is "programme".
 */

import { profitshareRequest, PROFITSHARE_SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireCredentials,
} from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type EarningsByProgramme,
  type EarningsByStatus,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammeQuery,
  type ProgrammeStatus,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('profitshare.adapter');

const SLUG = PROFITSHARE_SLUG;
const NAME = 'Profitshare';

/**
 * Default currency. Profitshare is a Romanian network and amounts are reported
 * in RON. We do NOT invent a currency: where a row carries one we use it,
 * otherwise we fall back to RON and document the assumption in META.
 */
const DEFAULT_CURRENCY = 'RON';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.profitshare.ro',
  // `custom`: Profitshare signs each request with an HMAC-SHA1 signature
  // (X-PS-Auth) rather than a bearer token. See client.ts.
  authModel: 'custom',
  docsUrl: 'https://doc.profitshare.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: not validated against a live account; shapes inferred from
  // the public reference client.
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: the adapter has not been validated against a live Profitshare account; endpoint shapes and field names are inferred from the public reference client and may differ in production.',
    'Commission amounts are assumed to be major-currency units (RON) as returned by the API; the unit is not authoritatively documented and is preserved verbatim on rawNetworkData.',
    'Requests are HMAC-SHA1 signed (X-PS-Auth) over a canonical method+path+query+user+date string; a clock skewed from GMT will produce signature failures.',
    'Click-level data is not exposed via the public affiliate API; listClicks is unsupported.',
    'Tracking-link generation requires the affiliate-links endpoint (POST) and is not deterministically constructible; generateTrackingLink is unsupported pending live verification.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * Commissions can be slow when a wide date window spans many records and the
 * report engine is warm-loading. We give listTransactions a longer timeout and
 * one extra retry, mirroring Awin's reasoning.
 */
const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Profitshare response shapes (deliberately minimal — every field optional)
// ---------------------------------------------------------------------------
//
// Profitshare wraps successful responses in `{ result: ... }` and errors in
// `{ error: { message } }` (the client throws on the latter via HttpStatusError
// or a non-JSON parse). We model only the keys we read; transformers tolerate
// missing keys and keep the verbatim object on rawNetworkData.
// ---------------------------------------------------------------------------

interface ProfitshareEnvelope<T> {
  result?: T;
  // Pagination, when present, typically lives alongside `result`. Names are not
  // authoritatively documented; we read the common variants defensively.
  total?: number;
  total_pages?: number;
  page?: number;
}

interface ProfitshareAdvertiserRaw {
  id?: number | string;
  id_advertiser?: number | string;
  name?: string;
  url?: string;
  currency?: string;
  category?: string;
  categories?: string[];
  commission?: string | number;
  status?: string;
}

interface ProfitshareCommissionRaw {
  id?: number | string;
  commission_id?: number | string;
  advertiser?: string;
  advertiser_id?: number | string;
  id_advertiser?: number | string;
  status?: string;
  amount?: number | string;
  commission?: number | string;
  currency?: string;
  // Profitshare date fields are not authoritatively documented; we read the
  // common variants. Treated as the conversion / order date.
  date?: string;
  date_order?: string;
  date_action?: string;
  date_modified?: string;
  date_paid?: string;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Commission status: Profitshare → canonical.
 *
 * Profitshare reports commission states with Romanian/English labels that vary
 * by surface. We map the recognised values and fall back to 'other' so we never
 * invent a status the user did not see:
 *
 *   pending / in asteptare / new           → 'pending'
 *   accepted / approved / confirmed         → 'approved'
 *   rejected / declined / cancelled / anulat→ 'reversed'
 *   paid / platit                           → 'paid'
 *   anything else                           → 'other'
 *
 * The raw value is always kept on rawNetworkData.
 */
function mapCommissionStatus(raw: ProfitshareCommissionRaw): TransactionStatus {
  const s = String(raw.status ?? '').toLowerCase().trim();
  if (s === 'pending' || s === 'new' || s === 'in asteptare' || s === 'asteptare') {
    return 'pending';
  }
  if (s === 'accepted' || s === 'approved' || s === 'confirmed' || s === 'acceptat') {
    return 'approved';
  }
  if (
    s === 'rejected' ||
    s === 'declined' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'anulat' ||
    s === 'respins'
  ) {
    return 'reversed';
  }
  if (s === 'paid' || s === 'platit') {
    return 'paid';
  }
  return 'other';
}

/**
 * Advertiser status: Profitshare → canonical ProgrammeStatus.
 *
 * The advertisers endpoint lists active advertisers the affiliate can promote.
 * Profitshare does not expose a per-advertiser join relationship on this
 * endpoint, so an active advertiser is reported as 'joined' (the affiliate can
 * already promote it). Unknown labels map to 'unknown'.
 */
function mapAdvertiserStatus(raw: ProfitshareAdvertiserRaw): ProgrammeStatus {
  const s = String(raw.status ?? '').toLowerCase().trim();
  if (s === '' || s === 'active' || s === 'activ' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'in asteptare') return 'pending';
  if (s === 'suspended' || s === 'paused' || s === 'suspendat') return 'suspended';
  if (s === 'available' || s === 'inactive') return 'available';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Age (in days) of a commission at response time. We anchor on the conversion /
 * order date; a paid date, when present, is older context and not the anchor we
 * want for the unpaid-age affordance (PRD §15.9).
 */
function computeAgeDays(raw: ProfitshareCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.date ?? raw.date_order ?? raw.date_action ?? raw.date_modified;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/** Format a Date as `YYYY-MM-DD` for Profitshare commission date filters. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ProfitshareAdvertiserRaw): Programme {
  const id = String(raw.id ?? raw.id_advertiser ?? '');
  const categories =
    raw.categories && raw.categories.length > 0
      ? raw.categories
      : raw.category
        ? [raw.category]
        : [];
  return {
    id,
    name: raw.name ?? `Profitshare advertiser ${id}`,
    network: SLUG,
    status: mapAdvertiserStatus(raw),
    currency: raw.currency ?? DEFAULT_CURRENCY,
    commissionRate:
      raw.commission !== undefined
        ? { type: 'unknown', description: String(raw.commission) }
        : undefined,
    categories,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ProfitshareCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapCommissionStatus(raw);
  const commission = toNumber(raw.commission ?? raw.amount);
  const amount = toNumber(raw.amount ?? raw.commission);
  const currency = raw.currency ?? DEFAULT_CURRENCY;
  const converted = nullableIso(raw.date ?? raw.date_order ?? raw.date_action);

  return {
    id: String(raw.id ?? raw.commission_id ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiser_id ?? raw.id_advertiser ?? ''),
    programmeName: raw.advertiser ?? '',
    status,
    amount,
    currency,
    commission,
    dateConverted: converted ?? new Date(0).toISOString(),
    dateApproved: nullableIso(raw.date_modified),
    datePaid: nullableIso(raw.date_paid),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class ProfitshareAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List advertisers (affiliate programmes) the publisher can promote.
   *
   * Profitshare endpoint: GET affiliate-advertisers — returns the full active
   * advertiser list under `result`. No server-side search/status filter is
   * documented, so all filtering is client-side (matching Awin's approach).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const credentials = requireCredentials('listProgrammes');

    const raw = await profitshareRequest<
      ProfitshareEnvelope<ProfitshareAdvertiserRaw[]> | ProfitshareAdvertiserRaw[]
    >({
      operation: 'listProgrammes',
      resource: 'affiliate-advertisers',
      credentials,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const list = unwrapList<ProfitshareAdvertiserRaw>(raw);
    let programmes = list.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (query?.categories && query.categories.length > 0) {
      const wanted = new Set(query.categories.map((c) => c.toLowerCase()));
      programmes = programmes.filter((p) =>
        (p.categories ?? []).some((c) => wanted.has(c.toLowerCase())),
      );
    }
    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single advertiser by id.
   *
   * Profitshare does not document a single-advertiser endpoint, so we derive
   * the one programme from the advertisers list (the same source as
   * listProgrammes). If the id is not present we throw a network_api_error
   * envelope rather than fabricating a stub (PRD principle 4.1).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A Profitshare advertiser id is required.',
          hint: 'List programmes first (affiliate_profitshare_list_programmes) to find the id.',
        }),
      );
    }

    const all = await this.listProgrammes();
    const match = all.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Profitshare advertiser found with id "${programmeId}".`,
          hint: 'Use affiliate_profitshare_list_programmes to discover valid advertiser ids.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commissions across a date window with optional status / age / programme
   * filters.
   *
   * Profitshare endpoint: GET affiliate-commissions with `filters` (date range)
   * and `page`. The API pages results, so we walk pages until a page returns
   * fewer rows than expected or the page cap is hit. We do NOT chunk by a fixed
   * day window because Profitshare does not document a per-call day cap; if a
   * cap surfaces in live testing, replicate Awin's `chunkDateRange` here.
   *
   * Date filters: we send `filters[from]` / `filters[to]` as `YYYY-MM-DD`.
   * Default window is the last 30 days when the caller supplies none.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const credentials = requireCredentials('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const allRaw: ProfitshareCommissionRaw[] = [];
    // Cap pages defensively so a misbehaving API cannot loop forever. 200 pages
    // is far beyond any realistic publisher's monthly volume.
    const MAX_PAGES = 200;
    let page = 1;
    let totalPages: number | undefined;

    while (page <= MAX_PAGES) {
      const raw = await profitshareRequest<
        ProfitshareEnvelope<ProfitshareCommissionRaw[]> | ProfitshareCommissionRaw[]
      >({
        operation: 'listTransactions',
        resource: 'affiliate-commissions',
        credentials,
        query: {
          'filters[from]': toDateOnly(from),
          'filters[to]': toDateOnly(to),
          page,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      const pageRows = unwrapList<ProfitshareCommissionRaw>(raw);
      allRaw.push(...pageRows);

      // Stop conditions: empty page, or we have reached the reported page count.
      if (!Array.isArray(raw) && typeof raw.total_pages === 'number') {
        totalPages = raw.total_pages;
      }
      if (pageRows.length === 0) break;
      if (totalPages !== undefined && page >= totalPages) break;
      page += 1;
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

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

    if (typeof query?.limit === 'number') {
      transactions = transactions.slice(0, query.limit);
    }

    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate commissions into an earnings summary, derived client-side from
   * listTransactions (same reasoning as Awin: one auditable source of truth,
   * the user can recompute it by calling listTransactions themselves).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Drop `limit` — a limited summary would silently undercount (principle 4.1).
    const txns = await this.listTransactions({ ...query, from, to, limit: undefined });

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

      const key = t.programmeId || '__unknown';
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || `Profitshare advertiser ${key}`,
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

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /**
   * Profitshare does not expose click-level data via its public affiliate API.
   * We throw `NotImplementedError` rather than returning an empty array so the
   * caller can tell "no clicks" from "no endpoint" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Profitshare does not expose click-level data via the public affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Profitshare tracking links are minted via the `affiliate-links` POST
   * endpoint, not a deterministic URL scheme we can construct offline. The
   * endpoint's request/response shape has not been verified against a live
   * account, so we throw `NotImplementedError` rather than guess at a format
   * and emit a link that may not track. Promote to a real implementation once
   * the affiliate-links contract is confirmed.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Profitshare tracking links require the affiliate-links endpoint, which is not yet verified; generateTrackingLink is unsupported.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations (v0.2 scaffolds)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  // -------------------------------------------------------------------------
  // validateCredential / setupSteps
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  // -------------------------------------------------------------------------
  // capabilitiesCheck
  // -------------------------------------------------------------------------

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        operations[name] = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
        };
      } catch (err) {
        operations[name] = {
          supported: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['getProgramme'] = {
      supported: true,
      note: 'Derived from the advertisers list; requires a known advertiser id, not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Profitshare does not expose click-level data via the public affiliate API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Requires the affiliate-links endpoint, which is not yet verified.',
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
// Module-level registration (see Awin's adapter for the aggregator rationale)
// ---------------------------------------------------------------------------

export const profitshareAdapter = new ProfitshareAdapter();
registerAdapter(profitshareAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap Profitshare's `{ result: [...] }` envelope (or a bare array) into a
 * plain array. Tolerates a missing/non-array `result` by returning [].
 */
function unwrapList<T>(raw: ProfitshareEnvelope<T[]> | T[]): T[] {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.result) ? raw.result : [];
}

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

// Internal test helpers — exported under `_internals` so they stay off the
// public adapter surface.
export const _internals = {
  mapCommissionStatus,
  mapAdvertiserStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toDateOnly,
  toNumber,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
