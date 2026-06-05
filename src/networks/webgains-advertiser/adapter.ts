/**
 * Webgains advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the Impact advertiser adapter's structure (the
 * canonical advertiser reference) and reuses the publisher Webgains adapter's
 * defensive field/status handling.
 *
 * --- Webgains advertiser API map ----------------------------------------------
 *
 * Auth: OAuth2 "Personal Access Token", passed as `Authorization: Bearer {token}`.
 *   The advertiser generates the token self-serve in the advertiser dashboard.
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *           https://knowledgehub.webgains.com/home/what-api-connections-do-webgains-offer-for-adverti
 *
 * Base URL: BLOCKED(verify) — see client.ts. Taken as https://platform.webgains.io.
 *
 * The Webgains advertiser PAT is scoped to one advertiser account, which may run
 * one or several programmes/campaigns. We treat each programme/campaign as a
 * "brand" the credentials address: `listBrands()` enumerates them and the
 * advertiser tools take `brand` → resolved to a `networkBrandId` (the
 * programme/campaign id) via brands.json. There is no confirmed agency-tier for
 * advertisers, so unlike Impact this adapter has a single credential tier.
 *
 * Operations:
 *   listBrands             → GET /advertisers/{accountId}/programs (the account's programmes)
 *   verifyAuth             → reuses the Get Programs probe in auth.ts
 *   listProgrammes         → GET /advertisers/{accountId}/programs (filtered by ctx programme)
 *   listTransactions       → GET /advertisers/{accountId}/transactions (brand-scoped)
 *   getProgrammePerformance→ Get Transaction Report rolled up per publisher
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * Webgains transaction statuses (verified from the advertiser knowledge hub):
 *   open / in recall / pending → 'pending'
 *   confirmed / approved       → 'approved'
 *   paid                       → 'paid' (transactions) / collapsed to 'approved' in the
 *                                 ProgrammePerformanceRow (which only has pending/approved/reversed)
 *   cancelled / declined       → 'reversed'
 *   delayed                    → 'other' (a hold state, not an approval or reversal)
 *   Source: https://knowledgehub.webgains.com/home/advertiser-performance-reports
 *           https://knowledgehub.webgains.com/home/payment-status-report-for-publishers
 *           https://knowledgehub.webgains.com/home/commission-statuses-for-transactions
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `webgainsAdvRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. Prefer `unknown`/`other`/`pending` over a wrong guess.
 *   5. Compute `ageDays` per transaction.
 *   6. NEVER issue a non-GET request. The client enforces this; the adapter must
 *      not work around it.
 *   7. UK English. "programme", not "program".
 */

import { webgainsAdvRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requireAccountId,
  SLUG,
} from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DiscoveredBrand,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
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

const log = createLogger('webgains-advertiser.adapter');
const NAME = 'Webgains (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // BLOCKED(verify): doc host returned HTTP 403; base URL is the Smart Platform
  // host pending live confirmation. See client.ts.
  baseUrl: 'https://platform.webgains.io',
  authModel: 'bearer',
  docsUrl: 'https://docs.webgains.dev/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Read-only at v0.1. The HTTP client refuses any non-GET method.',
    'getProgrammePerformance derives a per-publisher rollup from the Get Transaction Report (1-year max window per call; longer windows are chunked). Whether the report can be requested pre-grouped by publisher server-side is `// BLOCKED(verify)`, so grouping is done client-side.',
    'listBrands enumerates the advertiser account’s programmes/campaigns; there is no confirmed agency-passthrough tier for advertisers.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
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
  getProgrammePerformance: TRANSACTIONS_RESILIENCE,
};

// Maximum date window per Get Transaction Report call (docs index: 1 year).
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers — ctx
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing — this can happen if a
 * future caller bypasses the tool dispatcher.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Webgains advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Webgains programme/campaign id) via brands.json.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Webgains advertiser raw response shapes
// ---------------------------------------------------------------------------
//
// Deliberately permissive: field names vary across Webgains API generations and
// could not be confirmed verbatim against the doc host (HTTP 403). Every field
// is optional and several plausible names are read; the original is preserved on
// `rawNetworkData`.

interface WebgainsAdvProgrammeRaw {
  id?: string | number;
  programId?: string | number;
  programmeId?: string | number;
  campaignId?: string | number;
  name?: string;
  programName?: string;
  programmeName?: string;
  campaignName?: string;
  status?: string;
  state?: string;
  currency?: string;
  url?: string;
  website?: string;
  advertiserUrl?: string;
  apiEnabled?: boolean | string;
}

interface WebgainsAdvProgrammesResponse {
  programs?: WebgainsAdvProgrammeRaw[];
  programmes?: WebgainsAdvProgrammeRaw[];
  campaigns?: WebgainsAdvProgrammeRaw[];
  data?: WebgainsAdvProgrammeRaw[];
  results?: WebgainsAdvProgrammeRaw[];
}

interface WebgainsAdvTransactionRaw {
  id?: string | number;
  transactionId?: string | number;
  programId?: string | number;
  programmeId?: string | number;
  campaignId?: string | number;
  programName?: string;
  programmeName?: string;
  status?: string;
  // Publisher / affiliate identity.
  publisherId?: string | number;
  affiliateId?: string | number;
  publisherName?: string;
  affiliateName?: string;
  // Sale / order value.
  value?: number | string;
  saleValue?: number | string;
  orderValue?: number | string;
  // Commission paid to the publisher.
  commission?: number | string;
  commissionValue?: number | string;
  currency?: string;
  // Dates (ISO 8601). Names vary by generation; read defensively.
  clickDate?: string;
  clickTime?: string;
  date?: string;
  transactionDate?: string;
  eventDate?: string;
  changeDate?: string;
  validationDate?: string;
  approvedDate?: string;
  paymentDate?: string;
  paidDate?: string;
  reason?: string;
  changeReason?: string;
}

interface WebgainsAdvTransactionReportResponse {
  transactions?: WebgainsAdvTransactionRaw[];
  data?: WebgainsAdvTransactionRaw[];
  results?: WebgainsAdvTransactionRaw[];
  total?: number;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Webgains commission status to the canonical TransactionStatus.
 *   open / in recall / pending → 'pending'
 *   confirmed / approved       → 'approved'
 *   paid                       → 'paid'
 *   cancelled / declined / reversed → 'reversed'
 *   delayed                    → 'other' (a hold state)
 * Source: https://knowledgehub.webgains.com/home/commission-statuses-for-transactions
 */
function mapTransactionStatus(raw: { status?: string }): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'open' || s === 'in recall' || s === 'inrecall' || s === 'recall' || s === 'pending') {
    return 'pending';
  }
  if (s === 'confirmed' || s === 'approved' || s === 'validated') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'cancelled' || s === 'canceled' || s === 'declined' || s === 'rejected' || s === 'reversed') {
    return 'reversed';
  }
  if (s === 'delayed' || s === 'onhold' || s === 'on hold') return 'other';
  return 'other';
}

/**
 * Map a Webgains programme status to the canonical ProgrammeStatus.
 *   active / live / running → 'joined' (the advertiser's programme is live)
 *   pending / draft         → 'pending'
 *   paused / suspended / closed → 'suspended'
 *   anything else           → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'live' || s === 'running' || s === 'approved') return 'joined';
  if (s === 'pending' || s === 'draft' || s === 'awaiting') return 'pending';
  if (s === 'paused' || s === 'suspended' || s === 'closed' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/**
 * Map a Webgains commission status to the ProgrammePerformanceRow status
 * (pending | approved | reversed — no 'paid' or 'other' here). 'paid' rolls up
 * to 'approved' (it is validated, paid-out money) and 'delayed' rolls up to
 * 'pending' (it is not yet a confirmed payout, and is not a reversal).
 */
function mapReportRowStatus(raw: { status?: string }): ProgrammePerformanceRow['status'] {
  const t = mapTransactionStatus(raw);
  if (t === 'approved' || t === 'paid') return 'approved';
  if (t === 'reversed') return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Numeric / date helpers
// ---------------------------------------------------------------------------

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age (in days) of a Webgains transaction at the moment the adapter
 * responded. Anchor priority mirrors the publisher adapter: the validated/change
 * date first, then the conversion date, then the click date.
 */
function computeAgeDays(raw: WebgainsAdvTransactionRaw, now: Date = new Date()): number {
  const anchor =
    raw.validationDate ??
    raw.changeDate ??
    raw.approvedDate ??
    raw.transactionDate ??
    raw.eventDate ??
    raw.date ??
    raw.clickDate ??
    raw.clickTime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / DAY_MS));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function transactionDateForRow(raw: WebgainsAdvTransactionRaw): string {
  const iso =
    nullableIso(raw.transactionDate ?? raw.eventDate ?? raw.date ?? raw.changeDate ?? raw.validationDate);
  return iso ? iso.slice(0, 10) : '';
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function programmeId(raw: WebgainsAdvProgrammeRaw): string {
  return String(raw.programId ?? raw.programmeId ?? raw.campaignId ?? raw.id ?? '');
}

function programmeName(raw: WebgainsAdvProgrammeRaw): string {
  return (
    raw.programName ??
    raw.programmeName ??
    raw.campaignName ??
    raw.name ??
    `Webgains programme ${programmeId(raw)}`
  );
}

function toProgramme(raw: WebgainsAdvProgrammeRaw): Programme {
  const id = programmeId(raw);
  const programme: Programme = {
    id,
    name: programmeName(raw),
    network: SLUG,
    status: mapProgrammeStatus({ status: raw.status ?? raw.state }),
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  const advertiserUrl = raw.advertiserUrl ?? raw.url ?? raw.website;
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  return programme;
}

function toDiscoveredBrand(raw: WebgainsAdvProgrammeRaw): DiscoveredBrand {
  const apiEnabledRaw = raw.apiEnabled;
  const apiEnabled =
    apiEnabledRaw === undefined
      ? true
      : typeof apiEnabledRaw === 'boolean'
        ? apiEnabledRaw
        : String(apiEnabledRaw).toLowerCase() !== 'false';
  return {
    networkBrandId: programmeId(raw),
    displayName: programmeName(raw),
    apiEnabled,
  };
}

function transactionPublisherId(raw: WebgainsAdvTransactionRaw): string {
  return String(raw.publisherId ?? raw.affiliateId ?? '');
}

function transactionPublisherName(raw: WebgainsAdvTransactionRaw): string {
  return raw.publisherName ?? raw.affiliateName ?? `Webgains publisher ${transactionPublisherId(raw)}`;
}

function toTransaction(raw: WebgainsAdvTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission ?? raw.commissionValue);
  const sale = toAmount(raw.value ?? raw.saleValue ?? raw.orderValue);
  const currency = (raw.currency ?? 'GBP').toUpperCase();

  const conversionDate =
    nullableIso(raw.transactionDate ?? raw.eventDate ?? raw.date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.clickDate ?? raw.clickTime);
  const approvedDate = nullableIso(raw.validationDate ?? raw.changeDate ?? raw.approvedDate);
  const paidDate = nullableIso(raw.paymentDate ?? raw.paidDate);

  return {
    id: String(raw.transactionId ?? raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.programId ?? raw.programmeId ?? raw.campaignId ?? ''),
    programmeName: raw.programName ?? raw.programmeName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: conversionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.changeReason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

/**
 * Map a single raw transaction to one ProgrammePerformanceRow. The Webgains
 * advertiser performance report breaks down by publisher; we derive one row per
 * transaction keyed on (date, publisher, status) and the adapter aggregates them
 * downstream.
 */
function toPerformanceRow(raw: WebgainsAdvTransactionRaw): ProgrammePerformanceRow {
  return {
    date: transactionDateForRow(raw),
    publisherId: transactionPublisherId(raw),
    publisherName: transactionPublisherName(raw),
    clicks: 0,
    conversions: 1,
    grossSale: toAmount(raw.value ?? raw.saleValue ?? raw.orderValue),
    commission: toAmount(raw.commission ?? raw.commissionValue),
    currency: (raw.currency ?? 'GBP').toUpperCase(),
    status: mapReportRowStatus(raw),
    rawNetworkData: raw,
  };
}

/**
 * Aggregate per-transaction performance rows into one row per
 * (date, publisherId, status) bucket. Webgains exposes the report broken down by
 * publisher; we group client-side because the doc host could not confirm a
 * server-side group-by parameter (BLOCKED(verify)). `rawNetworkData` on each
 * aggregated row carries the verbatim list of contributing transactions so the
 * operator can drill in.
 */
function aggregatePerformance(rows: ProgrammePerformanceRow[]): ProgrammePerformanceRow[] {
  const buckets = new Map<string, ProgrammePerformanceRow & { rawNetworkData: unknown[] }>();
  for (const r of rows) {
    const key = `${r.date} ${r.publisherId} ${r.status} ${r.currency}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.conversions += r.conversions;
      existing.clicks += r.clicks;
      existing.grossSale += r.grossSale;
      existing.commission += r.commission;
      (existing.rawNetworkData as unknown[]).push(r.rawNetworkData);
    } else {
      buckets.set(key, {
        date: r.date,
        publisherId: r.publisherId,
        publisherName: r.publisherName,
        clicks: r.clicks,
        conversions: r.conversions,
        grossSale: r.grossSale,
        commission: r.commission,
        currency: r.currency,
        status: r.status,
        rawNetworkData: [r.rawNetworkData],
      });
    }
  }
  return [...buckets.values()];
}

// ---------------------------------------------------------------------------
// Extraction + date helpers
// ---------------------------------------------------------------------------

function extractProgrammes(resp: WebgainsAdvProgrammesResponse): WebgainsAdvProgrammeRaw[] {
  const arr = resp.programs ?? resp.programmes ?? resp.campaigns ?? resp.data ?? resp.results;
  return Array.isArray(arr) ? arr : [];
}

function extractTransactions(resp: WebgainsAdvTransactionReportResponse): WebgainsAdvTransactionRaw[] {
  const arr = resp.transactions ?? resp.data ?? resp.results;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Split a [from, to] window into <= MAX_WINDOW_DAYS segments. The Get
 * Transaction Report endpoint documents a 1-year maximum per call; we chunk
 * rather than push the cap onto callers (mirrors the publisher adapter).
 */
function chunkDateRange(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = from;
  while (cursor < to) {
    const end = new Date(Math.min(cursor.getTime() + MAX_WINDOW_DAYS * DAY_MS, to.getTime()));
    chunks.push({ from: cursor, to: end });
    cursor = new Date(end.getTime() + DAY_MS);
  }
  if (chunks.length === 0) chunks.push({ from, to });
  return chunks;
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class WebgainsAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the advertiser account's programmes/campaigns — the unit a
   * Webgains advertiser PAT addresses. Each becomes a discoverable "brand"
   * bound via brands.json.
   *
   * BLOCKED(verify): path taken as `/advertisers/{accountId}/programs`; the
   * response container key is read defensively (programs/programmes/campaigns/
   * data/results).
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const token = requireApiKey('listBrands');
    const accountId = requireAccountId('listBrands');

    const resp = await webgainsAdvRequest<WebgainsAdvProgrammesResponse>({
      operation: 'verifyAuth',
      path: `/advertisers/${accountId}/programs`,
      token,
      resilience: RESILIENCE.default,
    });
    return extractProgrammes(resp).map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — the advertiser's programmes, scoped to the brand context.
  // -------------------------------------------------------------------------

  /**
   * List the advertiser account's programmes. `ctx.networkBrandId` is the
   * programme/campaign id the caller asked about, so we filter to it (and any
   * client-side search). Mirrors the brand-context discipline of the Impact
   * advertiser adapter.
   */
  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const token = requireApiKey('listProgrammes');
    const accountId = requireAccountId('listProgrammes');

    const resp = await webgainsAdvRequest<WebgainsAdvProgrammesResponse>({
      operation: 'listProgrammes',
      path: `/advertisers/${accountId}/programs`,
      token,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = extractProgrammes(resp).map(toProgramme);
    // Scope to the brand context (the programme/campaign id).
    programmes = programmes.filter((p) => p.id === c.networkBrandId);
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — the advertiser's transactions for the brand programme.
  // -------------------------------------------------------------------------

  /**
   * List the advertiser's transactions for the brand programme across a date
   * window. The Get Transaction Report endpoint documents a 1-year maximum per
   * call, so we chunk longer windows. Status filtering is applied client-side on
   * the normalised canonical status.
   *
   * BLOCKED(verify): path taken as `/advertisers/{accountId}/transactions`;
   * date param names taken as `dateFrom`/`dateTo` (ISO `YYYY-MM-DD`) and the
   * programme filter as `programId`. Exact names/pagination were not confirmable
   * against the doc host.
   */
  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const token = requireApiKey('listTransactions');
    const accountId = requireAccountId('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from ? new Date(query.from) : new Date(now.getTime() - 30 * DAY_MS);

    const chunks = chunkDateRange(from, to);
    const raw: WebgainsAdvTransactionRaw[] = [];

    for (const chunk of chunks) {
      const resp = await webgainsAdvRequest<WebgainsAdvTransactionReportResponse>({
        operation: 'listTransactions',
        path: `/advertisers/${accountId}/transactions`,
        token,
        query: {
          dateFrom: isoDate(chunk.from),
          dateTo: isoDate(chunk.to),
          programId: c.networkBrandId,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      raw.push(...extractTransactions(resp));
    }

    let transactions = raw.map((r) => toTransaction(r, now));

    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') transactions = transactions.filter((t) => t.ageDays >= minAge);
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') transactions = transactions.filter((t) => t.ageDays <= maxAge);
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);

    log.debug({ count: transactions.length, accountId }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher rollup.
  // -------------------------------------------------------------------------

  /**
   * Derive a per-publisher performance rollup from the Get Transaction Report.
   *
   * The Webgains advertiser performance report "breaks down performance by
   * publisher" (knowledge hub). We fetch the brand programme's transactions over
   * the window (chunked at 1 year per call) and aggregate them into one row per
   * (date, publisher, status). Grouping is done client-side because the doc host
   * could not confirm a server-side group-by parameter (BLOCKED(verify)).
   *   Source: https://knowledgehub.webgains.com/home/advertiser-performance-reports
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const token = requireApiKey('getProgrammePerformance');
    const accountId = requireAccountId('getProgrammePerformance');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from ? new Date(query.from) : new Date(now.getTime() - 30 * DAY_MS);
    // Scope to a single programme: the caller-supplied programmeId wins, else the
    // brand context programme.
    const programId = query?.programmeId ?? c.networkBrandId;

    const chunks = chunkDateRange(from, to);
    const raw: WebgainsAdvTransactionRaw[] = [];

    for (const chunk of chunks) {
      const resp = await webgainsAdvRequest<WebgainsAdvTransactionReportResponse>({
        operation: 'getProgrammePerformance',
        path: `/advertisers/${accountId}/transactions`,
        token,
        query: {
          dateFrom: isoDate(chunk.from),
          dateTo: isoDate(chunk.to),
          programId,
          publisherId: query?.publisherId,
        },
        resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
      });
      raw.push(...extractTransactions(resp));
    }

    let perRow = raw.map(toPerformanceRow);
    if (query?.publisherId) {
      perRow = perRow.filter((r) => r.publisherId === String(query.publisherId));
    }
    let rows = aggregatePerformance(perRow);
    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Webgains advertiser adapter does not implement getProgramme at v0.1; use listProgrammes.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Webgains advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Webgains advertiser adapter does not implement listClicks at v0.1; brand-side reporting is transaction-level.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Webgains advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Brand-side publisher-roster admin operations are scaffolded for a later version.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Webgains advertiser at v0.1.');
  }

  // -------------------------------------------------------------------------
  // Setup + diagnostics
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};
    operations['verifyAuth'] = {
      supported: true,
      note: 'Live probe runs at wizard time; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note:
        'Multi-brand discovery hook — enumerates the advertiser account’s programmes/campaigns. ' +
        'Endpoint path `// BLOCKED(verify)` against a live account.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = { supported: true };
    operations['listTransactions'] = { supported: true };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Per-publisher rollup derived client-side from the Get Transaction Report; server-side group-by `// BLOCKED(verify)`.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Publisher-side operation; not applicable to advertiser adapter.',
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

export const webgainsAdvertiserAdapter = new WebgainsAdvertiserAdapter();
registerAdapter(webgainsAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  mapReportRowStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toDiscoveredBrand,
  toPerformanceRow,
  aggregatePerformance,
  toAmount,
  chunkDateRange,
  extractProgrammes,
  extractTransactions,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
