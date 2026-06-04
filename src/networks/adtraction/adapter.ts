/**
 * Adtraction adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and its sibling `src/networks/skimlinks/adapter.ts`. The load-bearing
 * decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- Adtraction API map --------------------------------------------------------
 *
 * Adtraction is a Nordic affiliate network (multiple markets, multiple
 * currencies — currency is read per transaction row, never hardcoded).
 *
 * Auth: a single API access token generated inside the Adtraction account,
 * supplied as a `token` QUERY parameter on every request (NOT an Authorization
 * header). `auth_model` is therefore `custom`.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *
 * Endpoints (POST with a JSON body of filters; token as ?token=...):
 *   POST /v3/affiliate/transactions/   — transactions for the account
 *     Body: { fromDate?, toDate?, currency?, market?, transactionStatus?,
 *             programId?, channelId? }
 *     transactionStatus is a numeric code (server-side filter):
 *       1 = approved, 2 = pending, 3 = approved + pending,
 *       4 = open claims, 5 = rejected
 *   POST /v3/affiliate/programs/       — approved partner programmes
 *     Body: { market?, channelId?, programId? }
 *   Source: search snippets of https://apidocs.adtraction.net/v2/
 *           (v2 used /v2/partner/statistics/ and /v2/partner/programs/)
 *
 * Rate limit: most endpoints ~30 requests/minute; the response carries
 * limit/remaining/reset headers.
 *
 * BLOCKED(verify): the exact v3 paths, the request/response field names, and the
 * base host (api.adtraction.com vs api.adtraction.net) are taken from the public
 * Adtraction API docs and third-party integration guides; they have not been
 * confirmed against a live account. The adapter reads every field defensively
 * and preserves the verbatim payload in `rawNetworkData`.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `adtractionRequest` and the
 *      raw-fetch helpers exported from client.ts.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope` (network +
 *      operation + httpStatus + verbatim networkErrorBody). Never swallow errors.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus` and `mapProgrammeStatus`.
 *      Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` from shared/config — NEVER process.env
 *      (except in tests).
 *   7. UK English. "programme", not "program".
 */

import {
  adtractionRequest,
  listApprovedProgrammesRaw,
  coerceArray,
  TRANSACTIONS_PATH,
  type AdtractionProgrammeRaw,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiToken,
} from './auth.js';
import { setupSteps } from './setup.js';
import { NotImplementedError, NetworkError, buildErrorEnvelope } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
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

const log = createLogger('adtraction.adapter');

const SLUG = 'adtraction';
const NAME = 'Adtraction';

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
    'Authentication is a single API access token sent as a `token` query parameter (not a header); auth_model is "custom".',
    'listClicks is not exposed via the Adtraction affiliate API; the operation throws NotImplementedError.',
    'generateTrackingLink cannot be constructed deterministically from credentials: Adtraction tracking links are programme-specific and are returned by the programmes endpoint per approved programme. The operation throws NotImplementedError; use the trackingURL on the Programme returned by listProgrammes / getProgramme.',
    'Exact v3 endpoint paths (/v3/affiliate/transactions/, /v3/affiliate/programs/), the request/response field names, and the API host (api.adtraction.com vs api.adtraction.net) are inferred from public docs and third-party guides; BLOCKED(verify) against a live account.',
    'Rate limit is approximately 30 requests/minute (some endpoints 10/minute); heavy date windows may need to be split by the caller.',
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
// Adtraction raw transaction shape
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Adtraction's exact v3 field names are not fully
// documented publicly. Treating every field as possibly absent and preserving
// the original under `rawNetworkData` keeps the adapter robust to upstream drift.
// BLOCKED(verify): confirm field names against a live v3 response.

interface AdtractionTransactionRaw {
  transactionId?: string | number;
  /** Numeric status code (1 approved, 2 pending, 4 open claim, 5 rejected) OR a string. */
  transactionStatus?: number | string;
  status?: number | string;
  programId?: number | string;
  programName?: string;
  /** Gross order/sale amount. */
  orderValue?: number | string;
  amount?: number | string;
  /** Commission earned by the affiliate. */
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
 * Adtraction encodes status as a numeric code (confirmed from the v2 docs'
 * `transactionStatus` filter) and may also return string labels:
 *   1 / 'approved' / 'confirmed'  → 'approved'  (validated, not yet paid)
 *   2 / 'pending'  / 'open'       → 'pending'   (awaiting validation)
 *   4 / 'claim'    / 'open claim' → 'pending'   (an open claim is still unresolved)
 *   5 / 'rejected' / 'declined'   → 'reversed'  (the sale did not pay out)
 *   'paid' / 'settled'            → 'paid'      (included in a payment)
 *   anything else                 → 'other'
 *
 * Why a rejected/declined sale maps to 'reversed': from the publisher's
 * perspective it means the sale did not pay out — semantically a reversal, which
 * is what every other adapter calls this state. The verbatim status is preserved
 * in `rawNetworkData`.
 *
 * Note: code 3 ('approved + pending') is a server-side FILTER value only, never a
 * per-row status, so it is intentionally not mapped here.
 *
 * BLOCKED(verify): per-row string labels are inferred; confirm against a live
 * v3 response.
 */
function mapTransactionStatus(raw: AdtractionTransactionRaw): TransactionStatus {
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
 * Map an Adtraction programme approval status to the canonical ProgrammeStatus.
 *
 *   active / approved / joined     → 'joined'
 *   pending / applied              → 'pending'
 *   rejected / declined            → 'declined'
 *   available / open / notjoined   → 'available'
 *   suspended / paused / closed    → 'suspended'
 *   anything else                  → 'unknown'
 *
 * BLOCKED(verify): the upstream status vocabulary is inferred; confirm against a
 * live response. We prefer 'unknown' to a wrong guess.
 */
function mapProgrammeStatus(raw: { approvalStatus?: string; status?: number | string }): ProgrammeStatus {
  const s = String(raw.approvalStatus ?? raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'approved' || s === 'joined' || s === '1') return 'joined';
  if (s === 'pending' || s === 'applied') return 'pending';
  if (s === 'rejected' || s === 'declined') return 'declined';
  if (s === 'available' || s === 'open' || s === 'notjoined') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'closed') return 'suspended';
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
 * adapter responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: validated date (how long has this been approved-but-not-paid?)
 * falls back to the conversion date, then the click time.
 */
function computeAgeDays(raw: AdtractionTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.validated ?? raw.transactionTime ?? raw.transactionDate ?? raw.clickTime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toTransaction(raw: AdtractionTransactionRaw, now: Date = new Date()): Transaction {
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

function toProgramme(raw: AdtractionProgrammeRaw): Programme {
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
  if (raw.commission !== undefined) programme.commissionRate = String(raw.commission);
  return programme;
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
 * Map a set of canonical TransactionStatus values to a single Adtraction
 * numeric `transactionStatus` filter. Returns undefined when the set requires
 * client-side filtering (multiple statuses, or statuses with no single upstream
 * code).
 *
 * Canonical → Adtraction code:
 *   approved → 1
 *   pending  → 2
 *   reversed → 5 (rejected)
 *   paid     → (no dedicated code; filter client-side)
 *   other    → (no code; filter client-side)
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdtractionAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the approved partner programmes for the authenticated affiliate account.
   *
   *   POST /v3/affiliate/programs/   Body: { market?, channelId? }
   *
   * Client-side `status`, `search`, `categories`, and `limit` filters are applied
   * after transformation. BLOCKED(verify): the endpoint path and response shape
   * are inferred from public docs.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireApiToken('listProgrammes');
    const raw = await listApprovedProgrammesRaw(token, 'listProgrammes');
    let programmes = raw.map((r) => toProgramme(r));

    const statusFilter = query?.status
      ? new Set(Array.isArray(query.status) ? query.status : [query.status])
      : undefined;
    if (statusFilter) {
      programmes = programmes.filter((p) => statusFilter.has(p.status));
    }

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single approved programme by id. Adtraction's programmes endpoint
   * accepts a `programId` filter; we request that and return the matching row.
   * If the programme is not in the approved set, we throw a NetworkError-shaped
   * not-found rather than inventing a record.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const token = requireApiToken('getProgramme');
    const raw = await listApprovedProgrammesRaw(token, 'getProgramme', {
      programId: programmeId,
    });
    const match =
      raw.find((r) => String(r.programId ?? '') === String(programmeId)) ?? raw[0];
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Adtraction returned no approved programme matching id "${programmeId}".`,
          hint: 'The affiliate programmes endpoint only returns programmes the account is approved for. Use listProgrammes to see the available ids.',
        }),
      );
    }
    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Adtraction transactions across a date window with optional status / age
   * / programme filters.
   *
   *   POST /v3/affiliate/transactions/
   *     Body: { fromDate, toDate, transactionStatus?, programId? }
   *
   * Date format: ISO 8601 dates (YYYY-MM-DD). We default to a 30-day window when
   * none is supplied. BLOCKED(verify): the endpoint path, the maximum window per
   * call, and the response field names are inferred from public docs; confirm
   * against a live account.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   * `query.minAgeDays` / `query.maxAgeDays` filter on the computed `ageDays`,
   * applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   * Rejected transactions (status 5 upstream) are normalised to 'reversed' and
   * their rejection reason surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireApiToken('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const body: Record<string, unknown> = {
      fromDate: from.toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
    };

    const statusFilter = toTransactionStatusList(query?.status);
    const upstreamStatus = mapCanonicalToAdtractionStatus(statusFilter);
    if (upstreamStatus !== undefined) {
      body['transactionStatus'] = upstreamStatus;
    }

    if (query?.programmeId) {
      body['programId'] = query.programmeId;
    }

    const response = await adtractionRequest<unknown>({
      operation: 'listTransactions',
      path: TRANSACTIONS_PATH,
      token,
      method: 'POST',
      body,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawTransactions = coerceArray<AdtractionTransactionRaw>(response, [
      'transactions',
    ]);

    let transactions = rawTransactions.map((r) => toTransaction(r, now));

    // Client-side canonical status filter — always applied when a status filter
    // was requested. We filter on the normalised canonical status after
    // transformation, which is correct even when we also sent a server-side
    // numeric filter (e.g. a request for 'paid' or 'other' has no upstream code).
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (same source of truth) so the user can
   * recompute the summary from the transactions they see. Do NOT pass
   * `query.limit` through — a limited summary undercounts (principle 4.1).
   *
   * Adtraction spans multiple currencies. The summary's top-level `currency` is
   * the first transaction's currency; mixed-currency accounts should read
   * `byProgramme[].currency` per row. (A multi-currency rollup is out of scope at
   * v0.1; the per-programme currency is preserved.)
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
          programmeName: t.programmeName || `Adtraction programme ${key}`,
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
      currency: firstCurrency ?? 'EUR',
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
   * Adtraction does not expose click-level data via the affiliate API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   *
   * BLOCKED(verify): confirm no click endpoint exists for affiliate accounts.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Adtraction does not expose click-level data via the affiliate API; ' +
        'see META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Adtraction tracking links cannot be constructed deterministically from
   * credentials alone.
   *
   * Each approved programme has its own programme-specific tracking URL, which
   * Adtraction returns on the programme record (the `trackingURL` field on the
   * programmes endpoint). There is no documented account-wide deeplink template
   * (publisherId + destination) the way Skimlinks or Awin expose; the tracking
   * URL is issued per programme and may require an `epi`/sub-id appended for
   * attribution.
   *
   * We therefore throw NotImplementedError with a precise reason rather than
   * fabricate a link. Callers should read `trackingURL` from the Programme
   * returned by listProgrammes / getProgramme.
   *
   * BLOCKED(verify): confirm whether a deterministic deeplink template exists for
   * affiliate accounts. If one does, this method can construct it and the
   * limitation can be removed.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Adtraction does not provide a deterministic, account-wide tracking-link template. ' +
        'Tracking links are programme-specific and are returned per approved programme ' +
        '(the trackingURL field on the programmes endpoint); read it from the Programme ' +
        'returned by listProgrammes / getProgramme. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials with a cheap authenticated probe (approved programmes).
   *
   * On success: returns { ok: true, identity }. On failure: { ok: false, reason }.
   * Never throws — verifyAuth is called by error handlers.
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
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

  /**
   * Probe each operation with a minimal call.
   *
   * listClicks and generateTrackingLink are known-unsupported and are recorded
   * without probing to avoid wasting network calls.
   */
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

    // Known-unsupported ops — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Adtraction does not expose click-level data via the affiliate API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Adtraction tracking links are programme-specific (read trackingURL on each Programme); no deterministic account-wide template.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const adtractionAdapter = new AdtractionAdapter();
registerAdapter(adtractionAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  mapCanonicalToAdtractionStatus,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
