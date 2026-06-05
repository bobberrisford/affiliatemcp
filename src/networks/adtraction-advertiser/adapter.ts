/**
 * Adtraction advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Follows the advertiser conventions of
 * `src/networks/impact-advertiser/adapter.ts` (the canonical advertiser
 * reference) while reusing the publisher Adtraction adapter's defensive field
 * handling. Awin remains the canonical template for new networks generally.
 *
 * --- READ-ONLY NUANCE (differs from impact-advertiser) ------------------------
 *
 * impact-advertiser enforces read-only by refusing every non-GET method.
 * Adtraction's reporting endpoints are POST-with-JSON-body BY DESIGN (filters
 * travel in the body even for pure reads), so a blanket non-GET refusal would
 * block all reads. Instead the HTTP client (./client.ts) enforces read-only via
 * an ALLOWLIST of documented data-READ paths: only advertiser transactions and
 * advertiser programmes are reachable; every write/mutation endpoint is
 * structurally unreachable. The spirit matches impact-advertiser — only
 * data-read endpoints are callable — but the mechanism is a path allowlist, not
 * a method ban.
 *
 * --- Multi-brand context ------------------------------------------------------
 *
 * `credentialScope` is `multi-brand`: a single advertiser token may address
 * several programmes the advertiser runs. The adapter receives a
 * `ctx?: AdapterCallContext` carrying `networkBrandId` (the advertiser's PROGRAM
 * id). Brand-scoped operations REQUIRE the context — without it we cannot scope
 * to a programme; we throw a `config_error` envelope rather than guessing.
 *
 * Auth: a single API access token generated inside the Adtraction ADVERTISER
 * account, supplied as a `token` QUERY parameter (NOT a header). auth_model is
 * therefore `custom`.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *
 * Endpoints (POST with a JSON body of filters; token as ?token=...):
 *   POST /v3/advertiser/programs/       — the advertiser's programmes
 *   POST /v3/advertiser/transactions/   — the advertiser's transactions
 *     Body: { fromDate?, toDate?, currency?, market?, transactionStatus?,
 *             programId?, channelId? }
 *     transactionStatus is a numeric code: 1 = approved, 2 = pending,
 *       3 = approved + pending (filter only), 4 = open claims, 5 = rejected
 *   Source: search snippets of https://apidocs.adtraction.net/v2/ and the
 *           Apiary "#reference/advertiser" section.
 *
 * BLOCKED(verify): both Apiary docs sites returned HTTP 403 to automated fetch
 * during this PR. The exact v3 advertiser paths, the request/response field
 * names, and the base host (api.adtraction.com vs api.adtraction.net) are
 * inferred from public docs and the v2 partner pattern; they have not been
 * confirmed against a live advertiser account. The adapter reads every field
 * defensively and preserves the verbatim payload in `rawNetworkData`.
 *
 * Operations:
 *   listBrands             → POST /v3/advertiser/programs/  (enumerate the
 *                            programmes the token addresses)  REQUIRED
 *   verifyAuth             → cheap authenticated programmes probe
 *   listProgrammes         → POST /v3/advertiser/programs/   (brand-scoped)
 *   listTransactions       → POST /v3/advertiser/transactions/ (brand-scoped)
 *   getProgrammePerformance→ POST /v3/advertiser/transactions/, grouped by
 *                            affiliate/channel into ProgrammePerformanceRow[]
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use the helpers from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. NORMALISE status enums; prefer a canonical state over a wrong guess.
 *   5. UK English in user-visible strings ("programme", not "program").
 *   6. Read credentials via auth helpers — never process.env (except in tests).
 */

import {
  adtractionAdvRequest,
  listAdvertiserProgrammesRaw,
  coerceArray,
  ADV_TRANSACTIONS_PATH,
  type AdtractionAdvProgrammeRaw,
} from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiToken, SLUG } from './auth.js';
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

const log = createLogger('adtraction-advertiser.adapter');

const NAME = 'Adtraction (advertiser)';

const MANDATORY_LIMITATION =
  'Adapter built from public API documentation; not yet verified against a live account.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.adtraction.com',
  authModel: 'custom',
  docsUrl: 'https://adtractionv3.docs.apiary.io/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    MANDATORY_LIMITATION,
    'Read-only at v0.1. Adtraction reporting reads are POST-with-body by design, so read-only is enforced by an ALLOWLIST of documented data-READ paths (advertiser transactions and advertiser programmes) rather than by refusing POST; any write/mutation endpoint is structurally unreachable through the client.',
    'Authentication is a single API access token sent as a `token` query parameter (not a header); auth_model is "custom".',
    'Multi-brand: a single advertiser token may address several programmes. `listBrands()` enumerates them; brand-scoped tools take `brand` and resolve to a programme id (networkBrandId) via brands.json.',
    'getProgrammePerformance is derived from the advertiser transactions endpoint, grouped by affiliate/channel; Adtraction transactions are per-conversion so clicks are reported as 0 unless the row carries a click count.',
    'getProgramme, getEarningsSummary, listClicks and generateTrackingLink are not implemented for the advertiser side at v0.1 (throw NotImplementedError).',
    'Exact v3 advertiser endpoint paths (/v3/advertiser/transactions/, /v3/advertiser/programs/), the request/response field names, and the API host (api.adtraction.com vs api.adtraction.net) are inferred from public docs and the v2 partner pattern; BLOCKED(verify) against a live account (both Apiary docs sites returned HTTP 403 to automated fetch).',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 6,
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

// ---------------------------------------------------------------------------
// Require ctx for brand-scoped operations
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on brand-scoped operations. We throw a
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
        message: `Adtraction advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Adtraction programme id) via brands.json.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Adtraction advertiser raw transaction shape
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Adtraction's exact v3 advertiser field names are not
// documented publicly (docs 403). Treating every field as possibly absent and
// preserving the original under `rawNetworkData` keeps the adapter robust to
// upstream drift. BLOCKED(verify): confirm field names against a live response.

interface AdtractionAdvTransactionRaw {
  transactionId?: string | number;
  /** Numeric status code (1 approved, 2 pending, 4 open claim, 5 rejected) OR a string. */
  transactionStatus?: number | string;
  status?: number | string;
  programId?: number | string;
  programName?: string;
  /** The affiliate/channel that drove the conversion. */
  channelId?: number | string;
  channelName?: string;
  affiliateId?: number | string;
  affiliateName?: string;
  /** Gross order/sale amount. */
  orderValue?: number | string;
  amount?: number | string;
  /** Commission paid to the affiliate. */
  commissionValue?: number | string;
  commission?: number | string;
  /** ISO 4217 currency code — read per row, never hardcoded. */
  currency?: string;
  /** Conversion timestamp. */
  transactionTime?: string;
  transactionDate?: string;
  clickTime?: string;
  modified?: string;
  validated?: string;
  paid?: string;
  /** Optional click count, where the advertiser feed carries one. */
  clicks?: number | string;
  /** Reason a transaction was rejected. */
  rejectionReason?: string;
  invalidReason?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Adtraction transaction status to the canonical TransactionStatus.
 *
 * Adtraction encodes status as a numeric code and may also return string labels:
 *   1 / 'approved' / 'confirmed'  → 'approved'
 *   2 / 'pending'  / 'open'       → 'pending'
 *   4 / 'claim'    / 'open claim' → 'pending'   (an open claim is unresolved)
 *   5 / 'rejected' / 'declined'   → 'reversed'  (the sale did not pay out)
 *   'paid' / 'settled'            → 'paid'
 *   anything else                 → 'other'
 *
 * Note: code 3 ('approved + pending') is a server-side FILTER value only, never a
 * per-row status, so it is intentionally not mapped here.
 *
 * BLOCKED(verify): per-row string labels are inferred; confirm against a live
 * v3 advertiser response.
 */
function mapTransactionStatus(raw: AdtractionAdvTransactionRaw): TransactionStatus {
  const code = raw.transactionStatus ?? raw.status;
  if (typeof code === 'number') {
    switch (code) {
      case 1:
        return 'approved';
      case 2:
        return 'pending';
      case 4:
        return 'pending';
      case 5:
        return 'reversed';
      default:
        return 'other';
    }
  }
  const s = String(code ?? '').toLowerCase().trim();
  if (s === '') return 'other';
  if (s === '1' || s === 'approved' || s === 'confirmed') return 'approved';
  if (s === '2' || s === 'pending' || s === 'open') return 'pending';
  if (s === '4' || s === 'claim' || s === 'open claim') return 'pending';
  if (s === '5' || s === 'rejected' || s === 'declined' || s === 'reversed') return 'reversed';
  if (s === 'paid' || s === 'settled') return 'paid';
  return 'other';
}

/**
 * Collapse the five-state canonical TransactionStatus into the three-state
 * ProgrammePerformanceRow status. 'paid' is a settled approval, so it rolls into
 * 'approved'; 'other' has no clear meaning for a performance row, so it falls
 * back to 'pending' (the not-yet-approved bucket, per the type's convention).
 */
function toPerformanceStatus(s: TransactionStatus): ProgrammePerformanceRow['status'] {
  if (s === 'approved' || s === 'paid') return 'approved';
  if (s === 'reversed') return 'reversed';
  return 'pending';
}

/**
 * Map an Adtraction programme lifecycle status to the canonical ProgrammeStatus.
 *
 * BLOCKED(verify): the upstream status vocabulary is inferred; confirm against a
 * live response. We prefer 'unknown' to a wrong guess.
 */
function mapProgrammeStatus(raw: { programStatus?: string; status?: number | string }): ProgrammeStatus {
  const s = String(raw.programStatus ?? raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'live' || s === '1') return 'joined';
  if (s === 'pending' || s === 'review') return 'pending';
  if (s === 'rejected' || s === 'declined') return 'declined';
  if (s === 'available' || s === 'open') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'closed' || s === 'inactive') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
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
 * Compute the age (in days) of an Adtraction transaction at the moment the
 * adapter responded. Anchor priority: validated date, then conversion date,
 * then click time.
 */
function computeAgeDays(raw: AdtractionAdvTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.validated ?? raw.transactionTime ?? raw.transactionDate ?? raw.clickTime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toTransaction(raw: AdtractionAdvTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commissionValue ?? raw.commission);
  const sale = toAmount(raw.orderValue ?? raw.amount);
  // Currency is read per row (Adtraction spans multiple Nordic markets).
  const currency = (raw.currency ?? '').toUpperCase() || 'EUR';

  const converted = nullableIso(raw.transactionTime ?? raw.transactionDate) ?? new Date(0).toISOString();
  const clicked = nullableIso(raw.clickTime);
  const approved = nullableIso(raw.validated);
  const paid = nullableIso(raw.paid);

  return {
    id: String(raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.programId ?? ''),
    programmeName: raw.programName ?? `Adtraction programme ${raw.programId ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clicked,
    dateConverted: converted,
    dateApproved: approved,
    datePaid: paid,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.rejectionReason ?? raw.invalidReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: AdtractionAdvProgrammeRaw): Programme {
  const currency = raw.currency ? String(raw.currency).toUpperCase() : undefined;
  const categoryLabel = raw.categoryName ?? raw.category;
  const categories = categoryLabel ? [String(categoryLabel)] : undefined;
  const programme: Programme = {
    id: String(raw.programId ?? ''),
    name: raw.programName ?? `Adtraction programme ${raw.programId ?? ''}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (currency) programme.currency = currency;
  if (categories) programme.categories = categories;
  if (raw.programURL) programme.advertiserUrl = String(raw.programURL);
  return programme;
}

function toDiscoveredBrand(raw: AdtractionAdvProgrammeRaw): DiscoveredBrand {
  const id = String(raw.programId ?? '');
  // `active` is the closest signal to "addressable via the API". When the field
  // is absent we assume the programme is enabled rather than hiding it.
  const apiEnabled = raw.active === undefined ? true : raw.active !== false;
  return {
    networkBrandId: id,
    displayName: raw.programName ?? `Adtraction programme ${id}`,
    apiEnabled,
  };
}

// ---------------------------------------------------------------------------
// Performance grouping — advertiser transactions → per-affiliate rows
// ---------------------------------------------------------------------------

/** Pick the affiliate/channel identity off a raw transaction row. */
function affiliateIdentity(raw: AdtractionAdvTransactionRaw): { id: string; name: string } {
  const id = String(raw.channelId ?? raw.affiliateId ?? '');
  const name =
    raw.channelName ?? raw.affiliateName ?? (id ? `Adtraction channel ${id}` : 'Unknown affiliate');
  return { id, name };
}

/** The date bucket for a performance row: yyyy-mm-dd of the conversion. */
function performanceDate(raw: AdtractionAdvTransactionRaw): string {
  const iso = nullableIso(raw.transactionTime ?? raw.transactionDate);
  return iso ? iso.slice(0, 10) : '';
}

/**
 * Group raw advertiser transactions into per-(date, affiliate, status)
 * performance rows. Adtraction transactions are per-conversion, so we aggregate
 * conversions/grossSale/commission and count conversions; clicks come through
 * only when the row carries a click count (most advertiser transaction rows do
 * not — see knownLimitations).
 */
function groupPerformance(rows: AdtractionAdvTransactionRaw[]): ProgrammePerformanceRow[] {
  const buckets = new Map<string, ProgrammePerformanceRow>();
  for (const raw of rows) {
    const { id, name } = affiliateIdentity(raw);
    const date = performanceDate(raw);
    const status = toPerformanceStatus(mapTransactionStatus(raw));
    const currency = (raw.currency ?? '').toUpperCase() || 'EUR';
    const key = `${date}|${id}|${status}|${currency}`;

    const clicks = toAmount(raw.clicks);
    const grossSale = toAmount(raw.orderValue ?? raw.amount);
    const commission = toAmount(raw.commissionValue ?? raw.commission);

    const existing = buckets.get(key);
    if (existing) {
      existing.clicks += clicks;
      existing.conversions += 1;
      existing.grossSale += grossSale;
      existing.commission += commission;
    } else {
      buckets.set(key, {
        date,
        publisherId: id,
        publisherName: name,
        clicks,
        conversions: 1,
        grossSale,
        commission,
        currency,
        status,
        rawNetworkData: raw,
      });
    }
  }
  return [...buckets.values()];
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

/**
 * Map a set of canonical TransactionStatus values to a single Adtraction numeric
 * `transactionStatus` filter. Returns undefined when client-side filtering is
 * required (multiple statuses, or statuses with no single upstream code).
 *
 *   approved → 1   pending → 2   reversed → 5   paid/other → (no code)
 */
function mapCanonicalToAdtractionStatus(statuses?: TransactionStatus[]): number | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'approved':
      return 1;
    case 'pending':
      return 2;
    case 'reversed':
      return 5;
    default:
      return undefined;
  }
}

/**
 * Build the advertiser-transactions request body from a date window plus
 * optional programme/channel/status filters. Defaults to a 30-day window.
 */
function buildTransactionsBody(opts: {
  from?: string;
  to?: string;
  programmeId?: string;
  channelId?: string;
  upstreamStatus?: number;
  now: Date;
}): Record<string, unknown> {
  const to = opts.to ? new Date(opts.to) : opts.now;
  const from = opts.from
    ? new Date(opts.from)
    : new Date(opts.now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const body: Record<string, unknown> = {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
  if (opts.programmeId) body['programId'] = opts.programmeId;
  if (opts.channelId) body['channelId'] = opts.channelId;
  if (opts.upstreamStatus !== undefined) body['transactionStatus'] = opts.upstreamStatus;
  return body;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdtractionAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the programmes the advertiser token addresses. Each programme is
   * one addressable brand. BLOCKED(verify): the advertiser-programmes response
   * shape against a live account.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const token = requireApiToken('listBrands');
    const raw = await listAdvertiserProgrammesRaw(token, 'listBrands');
    return raw.map(toDiscoveredBrand);
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
  // listProgrammes — the advertiser's programmes (brand-scoped).
  // -------------------------------------------------------------------------

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const token = requireApiToken('listProgrammes');
    const raw = await listAdvertiserProgrammesRaw(token, 'listProgrammes', {
      programId: c.networkBrandId,
    });
    // Scope to the resolved programme id; Adtraction may return the whole set.
    let programmes = raw
      .filter((r) => String(r.programId ?? '') === c.networkBrandId || raw.length === 1)
      .map(toProgramme);
    if (programmes.length === 0) programmes = raw.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = query?.status
      ? new Set(Array.isArray(query.status) ? query.status : [query.status])
      : undefined;
    if (statusFilter) programmes = programmes.filter((p) => statusFilter.has(p.status));
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — the advertiser's transactions (brand-scoped).
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const token = requireApiToken('listTransactions');
    const now = new Date();

    const statusFilter = toTransactionStatusList(query?.status);
    const upstreamStatus = mapCanonicalToAdtractionStatus(statusFilter);

    const body = buildTransactionsBody({
      from: query?.from,
      to: query?.to,
      programmeId: c.networkBrandId,
      upstreamStatus,
      now,
    });

    const response = await adtractionAdvRequest<unknown>({
      operation: 'listTransactions',
      path: ADV_TRANSACTIONS_PATH,
      token,
      method: 'POST',
      body,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawTransactions = coerceArray<AdtractionAdvTransactionRaw>(response, ['transactions']);
    let transactions = rawTransactions.map((r) => toTransaction(r, now));

    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    const minAge = query?.minAgeDays;
    if (typeof minAge === 'number') transactions = transactions.filter((t) => t.ageDays >= minAge);
    const maxAge = query?.maxAgeDays;
    if (typeof maxAge === 'number') transactions = transactions.filter((t) => t.ageDays <= maxAge);
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — advertiser transactions grouped by affiliate.
  // -------------------------------------------------------------------------

  /**
   * Read the advertiser's transactions for the period and group them by
   * affiliate/channel into ProgrammePerformanceRow[]. Adtraction does not expose
   * a pre-built per-affiliate report on the advertiser API, so we derive the
   * rollup from the transactions feed (same source of truth the operator can
   * recompute). BLOCKED(verify): the advertiser transactions response shape.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const token = requireApiToken('getProgrammePerformance');
    const now = new Date();

    const body = buildTransactionsBody({
      from: query?.from,
      to: query?.to,
      programmeId: query?.programmeId ?? c.networkBrandId,
      channelId: query?.publisherId,
      now,
    });

    const response = await adtractionAdvRequest<unknown>({
      operation: 'getProgrammePerformance',
      path: ADV_TRANSACTIONS_PATH,
      token,
      method: 'POST',
      body,
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    const rawTransactions = coerceArray<AdtractionAdvTransactionRaw>(response, ['transactions']);
    let rows = groupPerformance(rawTransactions);
    if (query?.publisherId) rows = rows.filter((r) => r.publisherId === query.publisherId);
    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Adtraction advertiser adapter does not implement getProgramme at v0.1; use listProgrammes.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Adtraction advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-affiliate rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Adtraction does not expose click-level data via the advertiser API; click counts surface in getProgrammePerformance only where the transaction feed carries them.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Adtraction advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Adtraction advertiser adapter does not implement listPublishers at v0.1; per-affiliate performance is available via getProgrammePerformance.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Adtraction advertiser at v0.1.');
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
      note: 'Cheap authenticated programmes probe; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'Enumerates the advertiser programmes the token addresses. Endpoint shape BLOCKED(verify) against a live account.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = { supported: true, claimStatus: 'experimental' };
    operations['listTransactions'] = { supported: true, claimStatus: 'experimental' };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Derived from the advertiser transactions feed, grouped by affiliate/channel. BLOCKED(verify) against a live account.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = {
      supported: false,
      note: 'Adtraction does not expose click-level data via the advertiser API.',
    };
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

export const adtractionAdvertiserAdapter = new AdtractionAdvertiserAdapter();
registerAdapter(adtractionAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  toPerformanceStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toDiscoveredBrand,
  groupPerformance,
  mapCanonicalToAdtractionStatus,
  buildTransactionsBody,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
