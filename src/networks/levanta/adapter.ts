/**
 * Levanta adapter — publisher (creator) side, single-brand credentials.
 *
 * Levanta is an Amazon-focused creator platform: creators run direct affiliate
 * partnerships with Amazon sellers and place tracking links by ASIN. The
 * Creator API exposes brand partnerships (`/partners`), a product catalogue
 * (`/products`), performance reporting (`/reports`), and link management
 * (`/links`).
 *
 * This adapter follows the Awin reference (`src/networks/awin/adapter.ts`);
 * read that file's header for the six cardinal rules. The mapping decisions
 * specific to Levanta are documented inline below.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — brand partnerships from /partners modelled as programmes.
 *   getProgramme        — a single partner, filtered from /partners.
 *   listTransactions    — /reports rows (per link/source/day) modelled as transactions.
 *   getEarningsSummary  — aggregation built client-side on top of listTransactions.
 *   listClicks          — NOT exposed: /reports gives click counts, not click events.
 *   generateTrackingLink— NOT deterministic: links are created via /links (API call).
 *   verifyAuth          — cheap /partners call (see auth.ts).
 *
 * --- Programmes mapping ------------------------------------------------------
 *
 * Levanta has no "programme" concept in the Awin sense. The closest analogue is
 * an active brand partnership: the creator has agreed terms with an Amazon
 * seller (a brand) and can place that brand's products. We therefore model each
 * `/partners` row as a Programme with status 'joined' (the endpoint only returns
 * brands you already partner with). The brand id becomes the programme id; the
 * brand name becomes the programme name. Commission terms vary per product and
 * are not exposed on the partner row, so `commissionRate` is left undefined and
 * the verbatim partner payload is preserved on `rawNetworkData`.
 *
 * --- Amount unit assumption --------------------------------------------------
 *
 * Levanta is Amazon-US-centric and the public docs do not state the unit or
 * currency of the `sales` / `commissions` fields on `/reports`. We assume major
 * units (whole currency, e.g. 12.34 USD, not minor units / cents) and default
 * the currency to USD. If a live account shows minor units, the transformer is
 * the single place to change, and the verbatim row is always on `rawNetworkData`.
 */

import { levantaRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('levanta.adapter');

const SLUG = 'levanta';
const NAME = 'Levanta';

/** Default reporting/currency assumption — see file-level note. */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.levanta.io',
  authModel: 'bearer',
  docsUrl: 'https://knowledge.levanta.io/creator-api',
  adapterVersion: '0.1.0',
  // `experimental`: built from public documentation only, not yet validated
  // against a live Levanta account at commit time.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation only; not yet verified against a live Levanta account.',
    'Amount unit is assumed to be major currency units (e.g. dollars, not cents) and currency defaults to USD; the public docs do not state the unit for the /reports sales and commissions fields.',
    'Programmes are modelled from /partners brand partnerships: each active partnership is surfaced as a joined programme. Levanta has no programme-join lifecycle, so statuses other than "joined" are not reported.',
    'Click-level data is not exposed: /reports returns aggregate click counts per link/source, not individual click events, so listClicks is unsupported.',
    'generateTrackingLink is unsupported: Levanta links are created server-side via /links by ASIN/source pair, not deterministically constructible from a destination URL.',
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
 * Reporting can scan a wide date range; give it more headroom than the default
 * the same way Awin does for its transactions endpoint.
 */
const REPORTS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTS_RESILIENCE,
  // getEarningsSummary derives from listTransactions, so its effective
  // resilience is that of the reports call; declared for clarity.
  getEarningsSummary: REPORTS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Levanta response shapes (deliberately minimal — see client.ts rationale)
// ---------------------------------------------------------------------------

interface LevantaPartnerRaw {
  id?: string | number;
  brandId?: string | number;
  name?: string;
  brandName?: string;
}

interface LevantaReportRow {
  // Identifiers vary by report dimension; we read several plausible keys.
  brandId?: string | number;
  brandName?: string;
  asin?: string;
  source?: string;
  adGroupId?: string | number;
  date?: string;
  // Metrics.
  clicks?: number;
  addToCarts?: number;
  conversions?: number;
  // `sales` / `commissions` are Levanta's estimated revenue and estimated
  // commission for the row. Unit assumed to be major currency units (USD).
  sales?: number;
  commissions?: number;
  currency?: string;
}

interface LevantaReportEnvelope {
  reports?: LevantaReportRow[];
  data?: LevantaReportRow[];
  rows?: LevantaReportRow[];
}

interface LevantaPartnersEnvelope {
  partners?: LevantaPartnerRaw[];
  data?: LevantaPartnerRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function partnerId(raw: LevantaPartnerRaw): string {
  return String(raw.brandId ?? raw.id ?? '');
}

function partnerName(raw: LevantaPartnerRaw): string {
  return raw.brandName ?? raw.name ?? `Levanta brand ${partnerId(raw)}`;
}

/**
 * Status normalisation: Levanta report row → canonical TransactionStatus.
 *
 * Levanta reporting is Amazon-attribution based: figures are estimated and not
 * finalised until Amazon confirms the order ships (and can be clawed back on a
 * return). The public docs do not expose a per-row finalised/approved/reversed
 * flag, so every report row is normalised to 'pending' — the honest default
 * for an estimate that has not been confirmed. We never invent an 'approved' or
 * 'paid' state the API did not assert. The verbatim row stays on
 * `rawNetworkData` so a user can drill in.
 */
function mapTransactionStatus(_raw: LevantaReportRow): TransactionStatus {
  return 'pending';
}

/**
 * Compute the age (in days) of a report row at the moment the adapter
 * responded, anchored on the row's `date`. Levanta reports are daily, so the
 * date is the only temporal anchor available.
 */
function computeAgeDays(raw: LevantaReportRow, now: Date = new Date()): number {
  if (!raw.date) return 0;
  const t = Date.parse(raw.date);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Synthesise a stable id for a report row. Levanta reporting rows are
 * per-(brand, asin, source, date) and the docs do not promise a row id, so we
 * compose one from the dimensions. This keeps Transaction.id deterministic for
 * a given row without inventing an upstream identifier.
 */
function reportRowId(raw: LevantaReportRow): string {
  return [raw.brandId ?? '', raw.asin ?? '', raw.source ?? '', raw.date ?? ''].join('|');
}

// ---------------------------------------------------------------------------
// Transformers (Levanta raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: LevantaPartnerRaw): Programme {
  const id = partnerId(raw);
  return {
    id,
    name: partnerName(raw),
    network: SLUG,
    // /partners returns only brands the creator already partners with.
    status: 'joined',
    // Commission terms are per-product on Levanta and not exposed on the
    // partner row; leave undefined rather than guessing.
    rawNetworkData: raw,
  };
}

function toTransaction(raw: LevantaReportRow, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = raw.commissions ?? 0;
  const sale = raw.sales ?? 0;
  const currency = raw.currency ?? DEFAULT_CURRENCY;
  const dateConverted = nullableIso(raw.date) ?? new Date(0).toISOString();

  return {
    id: reportRowId(raw),
    network: SLUG,
    programmeId: String(raw.brandId ?? ''),
    programmeName: raw.brandName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    // Levanta reporting is daily and attribution-based; there is no separate
    // click date, approval date, or payment date on the row.
    dateConverted,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class LevantaAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the creator's active brand partnerships, modelled as programmes.
   *
   * Levanta's `/partners` endpoint returns the brands the creator has active
   * partnerships with — there is no "available but not joined" catalogue here
   * (the product catalogue lives behind `/products`). Every returned partner is
   * therefore status 'joined'.
   *
   * Filters (search, status, categories, limit) are applied client-side: the
   * docs do not promise server-side filtering on this endpoint, and the partner
   * list is small relative to the product catalogue.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');

    const raw = await levantaRequest<LevantaPartnersEnvelope | LevantaPartnerRaw[]>({
      operation: 'listProgrammes',
      path: '/v2/creator/partners',
      token,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = normalisePartners(raw).map(toProgramme);

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
   * Fetch a single partnership (programme) by brand id.
   *
   * Levanta's `/partners` endpoint does not document a single-resource variant,
   * so we list partners and select the matching brand id client-side. An empty
   * or unknown id surfaces as a config_error / network_api_error envelope rather
   * than a fabricated stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A Levanta brand (programme) id is required.',
          hint: 'List programmes first (affiliate_levanta_list_programmes) to find the brand id.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No active Levanta partnership found for brand id "${programmeId}".`,
          hint: 'Use affiliate_levanta_list_programmes to see the brands you currently partner with.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List performance rows from `/reports`, modelled as transactions.
   *
   * Levanta's `/reports` endpoint returns daily performance per unique
   * link/source within a date range and supports filtering by ASINs, sources,
   * and brand ids. Each row carries clicks, add-to-carts, conversions, sales,
   * and commissions. We map each row to a Transaction: `amount` is the row's
   * estimated `sales`, `commission` is the estimated `commissions`.
   *
   * Date windowing: the docs do not state a maximum window per call. To stay
   * defensive against a future cap (and to mirror the Awin pattern) we chunk a
   * wide range into ≤31-day slices automatically; a narrow range makes one call.
   *
   * Status: every row is 'pending' — Levanta figures are Amazon-attribution
   * estimates and the docs expose no per-row finalised flag (see
   * `mapTransactionStatus`). The age and status filters still apply so a query
   * like `{ minAgeDays: 90 }` is meaningful.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: LevantaReportRow[] = [];
    for (const slice of slices) {
      const chunk = await levantaRequest<LevantaReportEnvelope | LevantaReportRow[]>({
        operation: 'listTransactions',
        path: '/v2/creator/reports',
        token,
        query: {
          dateStart: formatLevantaDate(slice.start),
          dateEnd: formatLevantaDate(slice.end),
          brandId: query?.programmeId,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...normaliseReportRows(chunk));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter — also applied client-side in case the server ignored
    // the brandId query parameter.
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
   * Aggregate report rows into an earnings summary, client-side.
   *
   * Built on `listTransactions` so the user can recompute the same numbers by
   * listing transactions themselves (the Awin rationale: one auditable source
   * of truth). `limit` is deliberately dropped — a limited summary would
   * silently undercount (principle 4.1).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined,
    });

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
          programmeName: t.programmeName || `Levanta brand ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // Levanta figures are estimates that have not been confirmed/paid, so
      // every row counts toward the oldest-unpaid affordance (PRD §15.9).
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
   * Levanta does not expose click-level event data.
   *
   * The `/reports` endpoint returns aggregate click counts per link/source/day,
   * not individual click events (with timestamp, referrer, destination), which
   * is what the Click type models. We throw `NotImplementedError` rather than
   * returning an empty array so the user can tell "Levanta has no click events"
   * apart from "no clicks in this window" (principle 4.1). The aggregate counts
   * are available on each transaction's `rawNetworkData`.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Levanta exposes aggregate click counts via /reports but not click-level events; listClicks is unsupported',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Levanta tracking links are not deterministically constructible.
   *
   * Unlike Awin (whose deep-link scheme is documented and stable), Levanta
   * links are created server-side via the `/links` endpoint by ASIN/source
   * pair — the link's identifier and short URL are assigned by Levanta and are
   * not derivable from a destination URL. The canonical `generateTrackingLink`
   * contract takes a `destinationUrl`, which does not map onto Levanta's
   * ASIN/source model, so we surface this honestly as unsupported rather than
   * fabricating a URL that would not track.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Levanta tracking links are created server-side via /links by ASIN/source pair and are not ' +
        'deterministically constructible from a destination URL; generateTrackingLink is unsupported',
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

    const probe = async (
      name: string,
      fn: () => Promise<unknown>,
      note?: string,
    ): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        const cap: OperationCapability = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
        };
        if (note !== undefined) cap.note = note;
        operations[name] = cap;
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
      note: 'Requires a known brand id; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Levanta exposes aggregate click counts via /reports but not click-level events.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Levanta links are created via /links by ASIN/source pair; not deterministically constructible.',
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
// Module-level registration (see Awin adapter for the rationale)
// ---------------------------------------------------------------------------

export const levantaAdapter = new LevantaAdapter();
registerAdapter(levantaAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function requireToken(operation: string): string {
  return requireCredential('LEVANTA_API_KEY', {
    network: SLUG,
    operation,
    hint: 'Generate a token in the Levanta dashboard → Settings → API (requires Admin access).',
  });
}

function normalisePartners(
  response: LevantaPartnersEnvelope | LevantaPartnerRaw[],
): LevantaPartnerRaw[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.partners)) return response.partners;
  if (Array.isArray(response.data)) return response.data;
  return [];
}

function normaliseReportRows(
  response: LevantaReportEnvelope | LevantaReportRow[],
): LevantaReportRow[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.reports)) return response.reports;
  if (Array.isArray(response.rows)) return response.rows;
  if (Array.isArray(response.data)) return response.data;
  return [];
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

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Mirrors the Awin pattern so a
 * future per-call window cap on `/reports` is handled without pushing the cap
 * onto callers. Returns at least one slice.
 */
function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [{ start: from, end: to }];
  if (from >= to) return [{ start: from, end: to }];

  const slices: DateSlice[] = [];
  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = from.getTime();
  const endMs = to.getTime();

  while (cursor < endMs) {
    const sliceEnd = Math.min(cursor + stepMs, endMs);
    slices.push({ start: new Date(cursor), end: new Date(sliceEnd) });
    cursor = sliceEnd;
  }
  return slices;
}

/**
 * Format a Date for Levanta's `dateStart` / `dateEnd` query params. Levanta
 * reporting is daily, so we send a `YYYY-MM-DD` date only.
 */
function formatLevantaDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Internal test helpers — exported under `_` so they do not appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatLevantaDate,
  reportRowId,
  normalisePartners,
  normaliseReportRows,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
