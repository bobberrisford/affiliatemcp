/**
 * NetRefer adapter — experimental, publisher (affiliate) side, single-brand.
 *
 * IMPORTANT FOR FUTURE CONTRIBUTORS:
 *
 * The Awin adapter (`src/networks/awin/adapter.ts`) is the canonical reference.
 * This adapter follows its structure and Rakuten's OAuth2 + token-cache shape
 * (`src/networks/rakuten/`). NetRefer is an iGaming affiliate-platform engine
 * and its ASR (Affiliate Standard Reporting) REST API is the affiliate-facing
 * surface. The public developer portal gates the full endpoint reference behind
 * onboarding, so several endpoint paths and field names here carry
 * `TODO(verify)` and the adapter ships `experimental` until validated against a
 * live operator account.
 *
 * --- What ASR exposes (and what this maps to) --------------------------------
 *
 * ASR 1.0 is a reporting product, not a programme-management or link API. It
 * exposes (per the public docs):
 *   - Daily Activity Report  — aggregated clicks, registrations, deposits, CPA
 *     and RevShare per tracker and brand, for a date range.
 *   - Period Invoice Report  — CPA and RevShare per tracker and brand, for a
 *     given year + month.
 *
 * Operation mapping:
 *   - listTransactions    → Daily Activity Report rows (the workhorse). Each
 *                           per-tracker/per-brand row becomes one Transaction.
 *   - getEarningsSummary  → derived client-side from listTransactions.
 *   - listProgrammes      → SYNTHESISED from the brands present in the report
 *     getProgramme          data (ASR groups by brand). ASR has no programme
 *                           catalogue endpoint; see the method comments.
 *   - listClicks          → NotImplementedError. ASR reports clicks only as a
 *                           per-day aggregate, never click-level rows.
 *   - generateTrackingLink→ NotImplementedError. ASR is read-only reporting;
 *                           link construction is not documented in the affiliate
 *                           surface.
 *   - verifyAuth          → OAuth2 token exchange round-trip (auth.ts).
 *
 * --- Cardinal rules (same as every adapter) ----------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `netreferRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope` with network,
 *      operation, httpStatus, and verbatim networkErrorBody (principle 4.1).
 *   3. PRESERVE the raw response on every domain object via `rawNetworkData`.
 *   4. NORMALISE status into the canonical set. ASR rows are aggregates with no
 *      per-transaction lifecycle status, so we map by report semantics (see
 *      `mapTransactionStatus`).
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *
 * --- Amount-unit assumption --------------------------------------------------
 *
 * ASR reports monetary CPA / RevShare values; the public docs do not state
 * whether amounts are major units (e.g. 12.50) or minor units (e.g. 1250). We
 * assume MAJOR units (decimal currency) and pass values through unscaled. The
 * verbatim payload is preserved on `rawNetworkData` so a reviewer can confirm
 * and adjust `toNumber`/`SCALE` if a live account proves otherwise.
 */

import { netreferRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
} from './auth.js';
import { setupSteps } from './setup.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DerivedValueResult,
  type EarningsByProgramme,
  type EarningsByStatus,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammeQuery,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('netrefer.adapter');

const SLUG = 'netrefer';
const NAME = 'NetRefer';

const EXPERIMENTAL_NOTE =
  'Experimental: the adapter has not been validated against a live NetRefer ASR operator account; endpoint paths and field names follow the public ASR 1.0 docs and may need adjustment.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Placeholder only — the real ASR host is per-operator and supplied via the
  // NETREFER_BASE_URL credential. See known_limitations.
  baseUrl: 'https://asr.operator.netrefer.com',
  authModel: 'oauth2',
  docsUrl: 'https://developer.netrefer.com/Affiliate-api/ASR',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    EXPERIMENTAL_NOTE,
    'The ASR base URL is per-operator: there is no single fixed host. The adapter reads it from the NETREFER_BASE_URL credential and validates that it parses as a URL.',
    'Amount unit is assumed to be major currency units (decimal); the public ASR docs do not state the unit. Verbatim values are preserved on rawNetworkData for reconciliation.',
    'NetRefer is an iGaming affiliate-platform engine: ASR rows report iGaming metrics (registrations, deposits, CPA, RevShare). "Sale amount" is mapped from deposits and "commission" from CPA + RevShare; this differs from a classic retail-affiliate transaction.',
    'listProgrammes and getProgramme are synthesised from the brands present in the Daily Activity Report — ASR exposes no programme/brand catalogue endpoint.',
    'Click-level data (listClicks) is not exposed: ASR reports clicks only as a per-day aggregate, so listClicks throws NotImplementedError.',
    'Tracking-link generation (generateTrackingLink) is not part of the read-only ASR affiliate surface and throws NotImplementedError.',
    'listPublishers and listPublisherSectors are scaffolded for v0.2 and throw NotImplementedError.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 15,
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 5,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

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
// ASR raw response shapes (deliberately minimal — same rationale as Awin)
// ---------------------------------------------------------------------------
//
// The public ASR docs describe Daily Activity Report rows as aggregated per
// tracker and brand, with metric values shaped as `{ Result, Adjustment }`.
// We read defensively and accept both PascalCase (as documented) and lowercase
// variants, since the exact serialisation is not confirmed publicly.
// ---------------------------------------------------------------------------

interface AsrMetric {
  Result?: number | string;
  Adjustment?: number | string;
  result?: number | string;
  adjustment?: number | string;
}

interface AsrDailyRow {
  // Grouping keys.
  Date?: string;
  date?: string;
  BrandId?: string | number;
  brandId?: string | number;
  BrandName?: string;
  brandName?: string;
  TrackerId?: string | number;
  trackerId?: string | number;
  TrackerName?: string;
  trackerName?: string;
  Currency?: string;
  currency?: string;
  // Metrics. Each may be a plain number or an `{ Result, Adjustment }` object.
  Clicks?: number | AsrMetric;
  clicks?: number | AsrMetric;
  Registrations?: number | AsrMetric;
  registrations?: number | AsrMetric;
  Deposits?: number | AsrMetric;
  deposits?: number | AsrMetric;
  CPA?: number | AsrMetric;
  cpa?: number | AsrMetric;
  RevShare?: number | AsrMetric;
  revShare?: number | AsrMetric;
}

interface AsrDailyResponse {
  Report?: AsrDailyRow[];
  report?: AsrDailyRow[];
  Data?: AsrDailyRow[];
  data?: AsrDailyRow[];
  Rows?: AsrDailyRow[];
  rows?: AsrDailyRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: number | string | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read an ASR metric that may be a plain number or an `{ Result, Adjustment }`
 * object. We sum Result + Adjustment so the value reflects the net accrued
 * figure NetRefer reports for the period (Adjustment can be negative).
 */
function readMetric(v: number | AsrMetric | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  const result = toNumber(v.Result ?? v.result);
  const adjustment = toNumber(v.Adjustment ?? v.adjustment);
  return result + adjustment;
}

function pick<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

function metricRaw(row: AsrDailyRow, pascal: keyof AsrDailyRow, lower: keyof AsrDailyRow):
  | number
  | AsrMetric
  | undefined {
  return pick(row[pascal], row[lower]) as number | AsrMetric | undefined;
}

/**
 * Map an ASR Daily Activity row to a canonical TransactionStatus.
 *
 * ASR rows are period aggregates with no per-transaction lifecycle (no
 * pending/approved/paid state per row). The closest honest mapping is
 * 'approved': the figures are NetRefer's accrued, post-validation totals for
 * the period. We never invent 'paid'/'pending'/'reversed' from an aggregate;
 * the Period Invoice Report is the settlement view and is not modelled as a
 * transaction here. Anything we cannot classify maps to 'other'.
 */
function mapTransactionStatus(_row: AsrDailyRow): TransactionStatus {
  return 'approved';
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute `ageDays` for an ASR row, anchored on its report date.
 */
function computeAgeDays(row: AsrDailyRow, now: Date = new Date()): number {
  const anchor = pick(row.Date, row.date);
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Build a stable synthetic id for an aggregate row. ASR rows have no natural
 * transaction id (they are aggregates), so we compose one from the grouping
 * keys to keep the Transaction.id stable and de-duplicable.
 */
function rowId(row: AsrDailyRow): string {
  const date = String(pick(row.Date, row.date) ?? '');
  const brand = String(pick(row.BrandId, row.brandId, row.BrandName, row.brandName) ?? '');
  const tracker = String(pick(row.TrackerId, row.trackerId, row.TrackerName, row.trackerName) ?? '');
  return [date, brand, tracker].filter((p) => p !== '').join(':') || 'asr-row';
}

function brandId(row: AsrDailyRow): string {
  return String(pick(row.BrandId, row.brandId, row.BrandName, row.brandName) ?? '');
}

function brandName(row: AsrDailyRow): string {
  return String(pick(row.BrandName, row.brandName, row.BrandId, row.brandId) ?? '');
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

/**
 * Daily Activity row → canonical Transaction.
 *
 * iGaming-domain mapping (see file header):
 *   - `amount`     = deposits (the gross player value driving commission)
 *   - `commission` = CPA + RevShare (what the affiliate earns)
 *   - `status`     = 'approved' (accrued aggregate; see mapTransactionStatus)
 */
function toTransaction(row: AsrDailyRow, now: Date = new Date()): Transaction {
  const cpa = readMetric(metricRaw(row, 'CPA', 'cpa'));
  const revShare = readMetric(metricRaw(row, 'RevShare', 'revShare'));
  const deposits = readMetric(metricRaw(row, 'Deposits', 'deposits'));
  const commission = cpa + revShare;
  const currency = String(pick(row.Currency, row.currency) ?? 'EUR');
  const dateConverted = nullableIso(pick(row.Date, row.date)) ?? new Date(0).toISOString();

  return {
    id: rowId(row),
    network: SLUG,
    programmeId: brandId(row),
    programmeName: brandName(row),
    status: mapTransactionStatus(row),
    amount: deposits,
    currency,
    commission,
    dateConverted,
    ageDays: computeAgeDays(row, now),
    rawNetworkData: row,
  };
}

/**
 * Synthesise a Programme from the brand identity on an ASR row.
 *
 * ASR exposes no programme catalogue; the only brand information available to
 * an affiliate is the brand grouping inside the report. We surface each distinct
 * brand as a Programme with status 'joined' (the affiliate is, by definition,
 * reporting on brands they work with). The raw row is preserved.
 */
function toProgramme(row: AsrDailyRow): Programme {
  const id = brandId(row);
  return {
    id,
    name: brandName(row) || `NetRefer brand ${id}`,
    network: SLUG,
    status: 'joined',
    currency: pick(row.Currency, row.currency),
    rawNetworkData: row,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. ASR's per-call window cap is
 * not documented publicly; we chunk to 31-day slices defensively (matching
 * Awin) so a wide range does not risk an upstream cap. Returns at least one
 * slice.
 */
function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return [{ start: from, end: to }];
  }
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

/** ASR date params accept YYYY-MM-DD (date-only, no time component). */
function formatAsrDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractRows(raw: AsrDailyResponse | AsrDailyRow[]): AsrDailyRow[] {
  if (Array.isArray(raw)) return raw;
  return (
    raw.Report ??
    raw.report ??
    raw.Data ??
    raw.data ??
    raw.Rows ??
    raw.rows ??
    []
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class NetreferAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the brands (programmes) the affiliate works with.
   *
   * SYNTHESISED: ASR has no programme catalogue endpoint. We fetch a recent
   * Daily Activity Report and derive the distinct brands present. This means
   * the result reflects brands with recent activity, not a full join list —
   * documented in known_limitations.
   *
   * Client-side filters (search, status, categories, limit) apply the same way
   * as Awin. Status filtering is a no-op in practice (all synthesised brands
   * are 'joined') but is honoured for contract consistency.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const raw = await netreferRequest<AsrDailyResponse | AsrDailyRow[]>({
      operation: 'listProgrammes',
      // TODO(verify): exact ASR Daily Activity Report path.
      path: '/api/asr/v1/daily-activity',
      query: { dateFrom: formatAsrDate(from), dateTo: formatAsrDate(now) },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = extractRows(raw);
    const byBrand = new Map<string, Programme>();
    for (const row of rows) {
      const programme = toProgramme(row);
      if (!byBrand.has(programme.id)) byBrand.set(programme.id, programme);
    }
    let programmes = [...byBrand.values()];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      programmes = programmes.filter((p) => wanted.has(p.status));
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
   * Fetch a single brand by id. SYNTHESISED via listProgrammes (ASR has no
   * single-programme endpoint). Throws a network_api_error envelope if the
   * brand is not present in recent activity.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === programmeId);
    if (!match) {
      throw new NotImplementedError(
        `NetRefer ASR has no single-programme endpoint; brand "${programmeId}" was not found in recent Daily Activity Report data. Use listProgrammes to see brands with recent activity.`,
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions from the ASR Daily Activity Report.
   *
   * Each per-tracker/per-brand row becomes one Transaction (see toTransaction
   * for the iGaming-domain mapping). The window defaults to the last 30 days
   * and is chunked into ≤31-day slices defensively (ASR's per-call cap is not
   * documented publicly).
   *
   * §15.9 unpaid-age and §15.10 reversed visibility: age filters apply after
   * status filtering. ASR aggregates carry no reversal reason, so reversed
   * rows do not arise from this endpoint.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);
    const allRows: AsrDailyRow[] = [];
    for (const slice of slices) {
      const raw = await netreferRequest<AsrDailyResponse | AsrDailyRow[]>({
        operation: 'listTransactions',
        // TODO(verify): exact ASR Daily Activity Report path + param names.
        path: '/api/asr/v1/daily-activity',
        query: {
          dateFrom: formatAsrDate(slice.start),
          dateTo: formatAsrDate(slice.end),
          ...(query?.programmeId ? { brandId: query.programmeId } : {}),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRows.push(...extractRows(raw));
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    // programmeId filter — client-side (defensive; the server filter above may
    // be ignored by some operators).
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
   * Aggregate transactions into an earnings summary, derived client-side from
   * listTransactions (same rationale as Awin: the user can recompute the totals
   * from the per-row output). ASR's Period Invoice Report is the settlement
   * view but its buckets do not align with the canonical status enum, so we
   * derive from the activity rows for a single source of truth.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({ ...query, from, to, limit: undefined });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: 'EUR',
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
          programmeName: t.programmeName || `NetRefer brand ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // §15.9 — oldest unpaid age. ASR aggregates map to 'approved'.
      if (t.status === 'pending' || t.status === 'approved') {
        if (oldestUnpaidAgeDays === undefined || t.ageDays > oldestUnpaidAgeDays) {
          oldestUnpaidAgeDays = t.ageDays;
        }
      }
    }

    if (firstCurrency) byStatus.currency = firstCurrency;

    const summary: EarningsSummary = {
      network: SLUG,
      totalEarnings,
      currency: firstCurrency ?? 'EUR',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      periodFrom: from,
      periodTo: to,
    };
    if (oldestUnpaidAgeDays !== undefined) summary.oldestUnpaidAgeDays = oldestUnpaidAgeDays;
    return summary;
  }

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /**
   * ASR reports clicks only as a per-day aggregate within the Daily Activity
   * Report, never as click-level rows. Returning the aggregate as Click[] would
   * misrepresent the data (each Click is meant to be one click event), so we
   * throw NotImplementedError rather than fabricate per-click rows.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'NetRefer ASR exposes clicks only as a per-day aggregate in the Daily Activity Report, not as click-level rows. Use listTransactions to read the aggregated activity.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * The affiliate-facing ASR surface is read-only reporting. Tracking-link
   * construction is not documented there (it lives in the operator-side
   * platform, outside ASR), so there is no deterministic format to construct
   * and no documented endpoint to call.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'NetRefer ASR is a read-only reporting API and does not document affiliate tracking-link generation.',
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
  // Admin scaffolds (v0.2)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  // -------------------------------------------------------------------------
  // validateCredential / setupSteps / derivedValues
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  /** No values are derivable from the token response — the user supplies all. */
  async derivedValues(): Promise<DerivedValueResult[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // capabilitiesCheck
  // -------------------------------------------------------------------------

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>, note?: string): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        const cap: OperationCapability = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
          claimStatus: 'experimental',
        };
        if (note !== undefined) cap.note = note;
        operations[name] = cap;
      } catch (err) {
        operations[name] = {
          supported: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
          claimStatus: 'experimental',
        };
      }
    };

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }), 'Synthesised from Daily Activity Report brands.');
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['getProgramme'] = {
      supported: true,
      note: 'Synthesised via listProgrammes; requires a known brand id. Not probed automatically.',
      claimStatus: 'experimental',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'ASR exposes clicks only as a per-day aggregate; throws NotImplementedError.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'ASR is read-only reporting; tracking-link generation is not documented. Throws NotImplementedError.',
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
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Module-level registration
// ---------------------------------------------------------------------------

export const netreferAdapter = new NetreferAdapter();
registerAdapter(netreferAdapter);

// Internal helpers for tests.
export const _internals = {
  toTransaction,
  toProgramme,
  mapTransactionStatus,
  computeAgeDays,
  readMetric,
  rowId,
  chunkDateRange,
  formatAsrDate,
  extractRows,
};

// Silence the unused-import warning for the logger when noUnusedLocals is on.
void log;
