/**
 * FlexOffers adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and `src/networks/skimlinks/adapter.ts` (a sibling publisher
 * adapter). Read those for the deep reasoning behind the structure. The
 * load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- FlexOffers API map --------------------------------------------------------
 *
 * Base URL: https://api.flexoffers.com  (FlexOffers.Services.RestApi)
 * Auth: a single account API Key in the `apiKey` request header (auth_model
 *   `custom` — it is not an `Authorization: Bearer` token).
 *
 * Sales / transaction reporting:
 *   GET /allsales?reportType=details&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *       [&status=pending|approved|canceled|bonus|non-commissionable][&page=N]
 *   Source: https://www.flexoffers.com/new-features/sales-api-and-transaction-reporting-updates/
 *           https://www.flexoffers.com/new-features/api-endpoints-update/
 *
 * Payments:
 *   GET /payments/summary , GET /payments/details?paymentId=N
 *   Source: https://www.flexoffers.com/new-features/performance-report-enhancement-and-payments-api/
 *
 * Deep link (tracking link) — publisher links are served from the FlexLinks
 *   redirect host track.flexlinkspro.com (the API /deeplink endpoint mints the
 *   same shape). We construct the redirect URL deterministically.
 *   Source: https://support.flexoffers.com/hc/en-us/articles/360042474432
 *           https://www.flexoffers.com/new-features/api-endpoints-update/
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `flexoffersRequest`.
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

import { flexoffersRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiKey } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('flexoffers.adapter');

const SLUG = 'flexoffers';
const NAME = 'FlexOffers';

/**
 * FlexOffers is a US aggregator; sales most often clear in USD. We never
 * hardcode a per-row currency — each transaction carries the currency the
 * upstream row reported. USD is used only as the summary fallback when a window
 * returned no rows at all (so the currency field is non-empty).
 */
const FALLBACK_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.flexoffers.com',
  authModel: 'custom',
  docsUrl: 'https://www.flexoffers.com/publishers/web-service-api/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listProgrammes / getProgramme are not implemented: the publisher-side advertiser/programme listing endpoint shape is not documented well enough publicly to map joined-programme status reliably; both operations throw NotImplementedError until verified against a live account.',
    'listClicks is not exposed as a click-level endpoint via the public FlexOffers Web Service API (only aggregated click counts appear in sales reports); the operation throws NotImplementedError.',
    'generateTrackingLink builds a FlexLinks redirect URL (track.flexlinkspro.com) deterministically from FLEXOFFERS_ACCOUNT_ID and the advertiser id passed as programmeId; the exact redirect parameter names are taken from public link examples and require live verification.',
    'The API key header name (apiKey) and the /allsales pagination parameter are taken from public integration write-ups, not a confirmed live response; see BLOCKED(verify) markers in client.ts and listTransactions.',
    'Per-row currency is read from each sales row; FlexOffers is a US aggregator and most rows clear in USD, but the adapter never hardcodes currency.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
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
// FlexOffers raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal and defensive: FlexOffers' field names have drifted
// across API versions (e.g. `postedDate` was previously `transactionDate`).
// Treating every field as possibly absent and preserving the original under
// `rawNetworkData` keeps the adapter robust to upstream drift.

interface FlexOffersSaleRaw {
  // Field names corroborated from the FlexOffers /allsales "details" report and
  // public integration documentation. Read defensively; live verification
  // required before bumping claim_status above 'experimental'.
  saleId?: string | number;
  transactionId?: string | number;
  advertiserId?: string | number;
  programId?: string | number;
  advertiserName?: string;
  programName?: string;
  status?: string; // pending | approved | canceled | bonus | non-commissionable
  saleAmount?: number | string; // gross sale value
  amount?: number | string; // synonym in some report variants
  commission?: number | string; // commission paid to the publisher
  currency?: string;
  clickDate?: string; // ISO 8601 — when the click occurred
  saleDate?: string; // ISO 8601 — when the sale/event occurred
  eventDate?: string; // ISO 8601 — synonym for saleDate in some variants
  postedDate?: string; // ISO 8601 — when the advertiser acknowledged the sale
  transactionDate?: string; // ISO 8601 — older name for postedDate
  paidDate?: string; // ISO 8601 — set once included in a publisher payment
  adjustmentType?: string; // reason when a sale is adjusted/cancelled
}

interface FlexOffersSalesResponse {
  // The /allsales response envelope key is not fully documented publicly; the
  // transformer reads rows from several candidate keys (sales / data / results)
  // and falls back to a bare array.
  sales?: FlexOffersSaleRaw[];
  data?: FlexOffersSaleRaw[];
  results?: FlexOffersSaleRaw[];
  totalCount?: number;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a FlexOffers sale status string to the canonical TransactionStatus.
 *
 * FlexOffers status → canonical:
 *   pending             → 'pending'  (awaiting advertiser validation)
 *   approved            → 'approved' (validated, not yet paid out)
 *   bonus               → 'approved' (a bonus commission is payable)
 *   paid                → 'paid'     (included in a publisher payment)
 *   canceled / cancelled→ 'reversed' (the sale was reversed / will not pay out)
 *   non-commissionable  → 'reversed' (no commission will be paid)
 *   anything else       → 'other'
 *
 * Why 'canceled'/'non-commissionable' → 'reversed': from the publisher's
 * perspective these mean the sale did not (or will not) pay out — semantically a
 * reversal, which is what every other network calls this state. The verbatim
 * status is preserved in `rawNetworkData`.
 */
function mapTransactionStatus(raw: FlexOffersSaleRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-');
  if (s === 'pending') return 'pending';
  if (s === 'approved' || s === 'bonus') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'canceled' || s === 'cancelled' || s === 'reversed' || s === 'non-commissionable') {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map a FlexOffers programme/advertiser relationship to the canonical
 * ProgrammeStatus.
 *
 * Programme listing is not implemented for FlexOffers (see listProgrammes), so
 * this helper is currently exercised only by unit tests. It defaults to
 * 'unknown' for any value it cannot confidently map.
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'approved' || s === 'joined') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'notjoined' || s === 'open') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'inactive') return 'suspended';
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
 * Compute the age (in days) of a FlexOffers sale at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: postedDate (when the advertiser acknowledged the sale —
 * "how long has this been sitting?") then saleDate/eventDate (conversion date)
 * then clickDate. For pending sales the saleDate is usually the earliest anchor.
 */
function computeAgeDays(raw: FlexOffersSaleRaw, now: Date = new Date()): number {
  const anchor =
    raw.postedDate ??
    raw.transactionDate ??
    raw.saleDate ??
    raw.eventDate ??
    raw.clickDate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toTransaction(raw: FlexOffersSaleRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission);
  const sale = toAmount(raw.saleAmount ?? raw.amount);
  // Read currency per row; never hardcode. Fall back only when the row omits it.
  const currency = (raw.currency ?? FALLBACK_CURRENCY).toUpperCase();

  // dateConverted is required by the contract; anchor on saleDate/eventDate,
  // then postedDate, then clickDate; epoch if none present.
  const converted =
    nullableIso(raw.saleDate) ??
    nullableIso(raw.eventDate) ??
    nullableIso(raw.postedDate) ??
    nullableIso(raw.transactionDate) ??
    nullableIso(raw.clickDate) ??
    new Date(0).toISOString();

  const clickDate = nullableIso(raw.clickDate);
  // FlexOffers has no distinct "approved date"; the postedDate is the closest
  // signal of advertiser acknowledgement once a sale is approved.
  const approvedDate =
    status === 'approved' || status === 'paid'
      ? nullableIso(raw.postedDate) ?? nullableIso(raw.transactionDate)
      : undefined;
  const paidDate = nullableIso(raw.paidDate);

  return {
    id: String(raw.saleId ?? raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiserId ?? raw.programId ?? ''),
    programmeName:
      raw.advertiserName ??
      raw.programName ??
      `FlexOffers advertiser ${raw.advertiserId ?? raw.programId ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: converted,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.adjustmentType ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Local query helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Map a set of canonical TransactionStatus values to a single FlexOffers
 * `status` query parameter. Returns undefined if the set requires client-side
 * filtering (multiple statuses, or statuses with no single upstream value).
 *
 * Canonical → FlexOffers `status`:
 *   pending  → 'pending'
 *   approved → 'approved'  (note: 'bonus' also maps to approved canonically, but
 *                           a single server filter can express only one value)
 *   paid     → 'paid'      BLOCKED(verify): public docs list pending/approved/
 *                          canceled/bonus/non-commissionable as the queryable
 *                          statuses; whether 'paid' is a server-side filter value
 *                          is unconfirmed, so paid is filtered client-side.
 *   reversed → 'canceled'
 *   other    → (no mapping; filter client-side)
 */
function mapCanonicalToFlexOffersStatus(statuses?: TransactionStatus[]): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'reversed':
      return 'canceled';
    default:
      return undefined;
  }
}

function extractRows(response: FlexOffersSalesResponse | FlexOffersSaleRaw[]): FlexOffersSaleRaw[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.sales)) return response.sales;
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.results)) return response.results;
  return [];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class FlexoffersAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * FlexOffers exposes advertiser/programme data, but the public documentation
   * does not pin down the publisher-side joined-programme endpoint shape or its
   * status semantics well enough to map reliably. We throw NotImplementedError
   * rather than returning an empty array — the difference between "no programmes"
   * and "not yet mapped" is principle 4.1.
   *
   * When a live account confirms the endpoint shape, implement it here and remove
   * the corresponding entry from META.knownLimitations and network.json.
   */
  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(
      'FlexOffers programme/advertiser listing is not implemented: the publisher-side ' +
        'joined-programme endpoint shape is not documented well enough publicly to map ' +
        'reliably. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Same restriction as listProgrammes — the programme endpoint shape is not yet
   * mapped against a live account.
   */
  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(
      'FlexOffers single-programme lookup is not implemented: the publisher-side ' +
        'advertiser/programme endpoint shape is not documented well enough publicly to ' +
        'map reliably.',
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List FlexOffers sales across a date window with optional status / age /
   * programme filters.
   *
   * Endpoint:
   *   GET /allsales?reportType=details&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *       [&status=pending|approved|canceled|bonus|non-commissionable][&page=N]
   *
   * The public docs do not document a maximum window per call; we default to a
   * 30-day window when none is supplied and pass the full window in one call.
   * BLOCKED(verify): confirm the maximum window and the pagination parameter
   * (page vs pageSize) against a live account.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *   `query.minAgeDays` / `query.maxAgeDays` filter on computed `ageDays`,
   *   applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *   Canceled / non-commissionable sales normalise to 'reversed' and their
   *   `adjustmentType` surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      reportType: 'details',
      startDate: from.toISOString().slice(0, 10),
      endDate: to.toISOString().slice(0, 10),
    };

    // Server-side status filter when a single canonical status maps cleanly.
    // We always re-filter on the normalised status client-side (see below).
    const statusFilter = toTransactionStatusList(query?.status);
    const upstreamStatus = mapCanonicalToFlexOffersStatus(statusFilter);
    if (upstreamStatus) {
      params['status'] = upstreamStatus;
    }

    const response = await flexoffersRequest<FlexOffersSalesResponse>({
      operation: 'listTransactions',
      path: '/allsales',
      apiKey,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rows = extractRows(response);
    let transactions = rows.map((r) => toTransaction(r, now));

    // Client-side canonical status filter — always applied when a status filter
    // was requested, even when a server-side filter was also sent.
    //
    // Why filter client-side even when `upstreamStatus` is set: the server-side
    // filter uses FlexOffers' upstream names (e.g. 'canceled'), which the
    // transformer normalises to canonical names (e.g. 'reversed'). Filtering on
    // the normalised status after transformation is always correct, including for
    // statuses with no single upstream value (e.g. 'paid', 'other').
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Programme filter is client-side: the /allsales endpoint does not document
    // an advertiser-id query parameter for the publisher report.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
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
   * We derive from `listTransactions` (not the dedicated performance report) for
   * the same reason as Awin/Skimlinks: a separate report endpoint would be a
   * second source of truth for the same numbers, and we still need the
   * per-transaction `ageDays` to compute `oldestUnpaidAgeDays`. One call, one
   * source.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (4.1).
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
      currency: FALLBACK_CURRENCY,
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
          programmeName: t.programmeName || `FlexOffers advertiser ${key}`,
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
      currency: firstCurrency ?? FALLBACK_CURRENCY,
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
   * FlexOffers does not expose click-level data via the public Web Service API.
   * Click counts appear only as aggregates inside sales/performance reports, not
   * as individual click records.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'FlexOffers does not expose click-level data via the public Web Service API ' +
        '(only aggregated click counts appear in sales reports).',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a FlexOffers (FlexLinks) deeplink (deterministic, no API call).
   *
   * FlexOffers publisher links resolve through the FlexLinks redirect host:
   *
   *   https://track.flexlinkspro.com/a.ashx?foid={accountId}.{advertiserId}&foc=1&fot=9999&fos=1&url={encodedDestination}
   *
   * `foid` encodes the account/advertiser pairing; `fos` carries an optional
   * sub-id (we leave it at the default). The advertiser id is supplied as
   * `programmeId`. We require FLEXOFFERS_ACCOUNT_ID to mint the link.
   * Source: https://support.flexoffers.com/hc/en-us/articles/360042474432
   *         live link example: track.flexlinkspro.com/a.ashx?foid=177.A171465&foc=1&fot=9999&fos=1&url=...
   * BLOCKED(verify): the exact `foid` encoding and parameter defaults are taken
   * from public link examples and need confirmation against a live account.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the advertiser page you want to link to.',
        }),
      );
    }
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'programmeId (FlexOffers advertiser id) is required.',
          hint: 'Pass the advertiser id of the programme you have joined.',
        }),
      );
    }

    const accountId = requireCredential('FLEXOFFERS_ACCOUNT_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint:
        'generateTrackingLink needs FLEXOFFERS_ACCOUNT_ID to build the FlexLinks redirect URL. ' +
        'Find it under Tools → Web Services → API Keys.',
    });

    const foid = `${accountId}.${input.programmeId}`;
    const encodedDestination = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://track.flexlinkspro.com/a.ashx?foid=${foid}&foc=1&fot=9999&fos=1&url=${encodedDestination}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'track.flexlinkspro.com deterministic construction',
        foid,
        foc: 1,
        fot: 9999,
        fos: 1,
        url: input.destinationUrl,
        note: 'foid={accountId}.{advertiserId}; parameter defaults taken from public FlexLinks examples (BLOCKED(verify)).',
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify the API key by issuing a minimal authenticated /allsales request.
   *
   * On success: returns { ok: true, identity }.
   * On failure: returns { ok: false, reason }. Never throws — verifyAuth is
   * called by error handlers.
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
   * listProgrammes / getProgramme / listClicks are known-unsupported and are
   * recorded without probing to avoid wasting network calls.
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
    operations['listProgrammes'] = {
      supported: false,
      note: 'FlexOffers programme/advertiser listing is not implemented (endpoint shape unverified).',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'FlexOffers single-programme lookup is not implemented (endpoint shape unverified).',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'FlexOffers does not expose click-level data via the public Web Service API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    // generateTrackingLink is deterministic — record as supported without a probe.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic track.flexlinkspro.com URL construction; no live probe needed.',
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
// Registration
// ---------------------------------------------------------------------------

export const flexoffersAdapter = new FlexoffersAdapter();
registerAdapter(flexoffersAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  mapCanonicalToFlexOffersStatus,
  extractRows,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
