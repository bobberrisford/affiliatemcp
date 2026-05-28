/**
 * Tradedoubler adapter — publisher side.
 *
 * Built from public API documentation (connect.tradedoubler.com / Apiary) as of
 * 2026-05-28. NOT yet verified against a live Tradedoubler account.
 * Fields marked `// TODO(verify)` require live testing to confirm.
 *
 * --- Tradedoubler API surface used -------------------------------------------
 *
 *   Base URL: https://connect.tradedoubler.com
 *   Auth:     OAuth2 bearer token in `Authorization: Bearer {token}` header
 *
 *   GET /publisher/programs
 *     → List programmes the publisher has joined / can join.
 *     Params: status, fromDate, toDate, offset, limit, sortBy, sortOrder
 *
 *   GET /publisher/programs/detail?programId={id}
 *     → Single programme detail including tracking links and commission tariffs.
 *
 *   GET /publisher/report/transactions
 *     → Transactions (conversions) for the publisher.
 *     Params: fromDate, toDate, programId, status, offset, limit, sortBy, sortOrder
 *     Status values: A=Accepted/approved, P=Pending, D=Denied/reversed
 *
 *   GET /publisher/payments/earnings
 *     → Publisher earnings summary.
 *
 *   Tracking links: deterministic construction.
 *     https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}
 *     p = program ID (mandatory)
 *     a = publisher site ID (mandatory; derived from TRADEDOUBLER_ORGANIZATION_ID
 *         or set separately)
 *     url = destination URL, URL-encoded (at the end of the query string)
 *
 *   GET /usermanagement/users/me → auth check (see auth.ts)
 *
 *   listClicks: NOT exposed via the public publisher API → NotImplementedError.
 *
 * --- Cardinal rules (from awin/adapter.ts header) ----------------------------
 *
 *   1. NEVER call `fetch` directly. Use `tradedoublerRequest` from `./client.ts`.
 *   2. EVERY failure → `NetworkErrorEnvelope` (network + operation + httpStatus +
 *      verbatim body). Never collapse to "an error occurred".
 *   3. PRESERVE raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to canonical set.
 *   5. COMPUTE `ageDays` for every transaction.
 *   6. UK English throughout ("programme" not "program").
 */

import { tradedoublerRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import {
  requireToken,
  requireOrganizationId,
  formatTdDate,
  defaultWindow,
  configError,
} from './endpoints/shared.js';
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

const log = createLogger('tradedoubler.adapter');

const SLUG = 'tradedoubler';
const NAME = 'Tradedoubler';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://connect.tradedoubler.com',
  authModel: 'bearer',
  docsUrl: 'https://tradedoubler.docs.apiary.io/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Click-level data is not exposed via the public Tradedoubler publisher API; listClicks is unsupported.',
    'Tradedoubler uses separate per-product tokens (PRODUCTS, CONVERSIONS, VOUCHERS); this adapter uses the main Organisation API token (bearer) from connect.tradedoubler.com.',
    'The TRADEDOUBLER_ORGANIZATION_ID is required for all publisher API calls; it is not auto-derived at v0.1.',
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
// Tradedoubler response shapes (deliberately minimal — fields verified against
// the apiary doc; TODO(verify) marks those not confirmed against a live tenant)
// ---------------------------------------------------------------------------

/**
 * A programme returned by GET /publisher/programs.
 * Status strings per Tradedoubler docs: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
 * // TODO(verify): exact field names against a live account.
 */
interface TdProgrammeRaw {
  id?: number | string;
  programId?: number | string; // TODO(verify): alternate field name
  name?: string;
  programName?: string; // TODO(verify): alternate field name
  advertiserName?: string; // TODO(verify): field name
  status?: string; // JOINED | NOT_JOINED | APPLIED | DECLINED | TERMINATED
  currency?: string;
  currencyCode?: string; // TODO(verify): alternate field name
  currency3Code?: string; // TODO(verify): alternate field name
  advertiserUrl?: string;
  websiteUrl?: string; // TODO(verify): alternate field name
  category?: string;
  categories?: string[] | Array<{ name?: string }>; // TODO(verify): shape
  commissionMin?: number; // TODO(verify): field name
  commissionMax?: number; // TODO(verify): field name
  commissionType?: string; // TODO(verify): field name
  defaultTracking?: string; // default tracking link template
}

/**
 * Paginated programmes response from /publisher/programs.
 * // TODO(verify): exact envelope shape against a live account.
 */
interface TdProgrammesResponse {
  items?: TdProgrammeRaw[];
  offset?: number;
  limit?: number;
  total?: number;
}

/**
 * A transaction returned by GET /publisher/report/transactions.
 * Field names sourced from the Apiary doc and the whitelabeled/tradedoubler-api-client
 * README (getTransactions() response object).
 * // TODO(verify): all field names against a live account.
 */
interface TdTransactionRaw {
  transactionId?: number | string;
  generatedId?: number | string; // TODO(verify): alternate field name
  programId?: number | string;
  sourceId?: number | string; // publisher site ID
  eventTypeId?: number; // 4=Lead, 5=Sale
  eventId?: number | string; // TODO(verify): field name
  eventName?: string;
  status?: string; // A=Accepted, P=Pending, D=Denied
  statusReason?: string; // reason for denial (reversed transactions)
  reasonId?: number; // added 2022-06-01 per Apiary docs
  reasonName?: string; // TODO(verify): field name
  timeOfTransaction?: string; // ISO or timestamp // TODO(verify): format
  transactionDate?: string; // TODO(verify): alternate field name
  clickDate?: string; // TODO(verify): field name
  timeOfLastModified?: string; // TODO(verify): field name
  lastModifiedDate?: string; // TODO(verify): alternate field name
  orderValue?: number;
  commission?: number;
  currency?: string; // TODO(verify): field name
  currencyCode?: string; // TODO(verify): alternate field name
  orderNr?: string;
  leadNr?: string;
  deviceType?: string;
  epi1?: string; // custom field 1
  epi2?: string; // custom field 2
  mediaId?: number | string;
  mediaName?: string; // TODO(verify): field name
  program?: string; // programme name as a string field // TODO(verify)
  programName?: string; // TODO(verify): alternate field name
  paid?: boolean; // TODO(verify): field name/type for paid status
}

/**
 * Paginated transactions response from /publisher/report/transactions.
 * // TODO(verify): exact envelope shape.
 */
interface TdTransactionsResponse {
  items?: TdTransactionRaw[];
  offset?: number;
  limit?: number;
  total?: number;
}

// TdEarningsSummaryRaw is not used directly at v0.1 (we derive earnings from
// listTransactions). Retained here for documentation purposes; suppress the
// unused-interface lint with a type alias guard.
//
// interface TdEarningsSummaryRaw {
//   pendingEarnings?: number;
//   approvedEarnings?: number;
//   paidEarnings?: number;
//   totalEarnings?: number;
//   currency?: string;
//   currencyCode?: string; // TODO(verify): alternate field name
// }

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Tradedoubler programme status → canonical ProgrammeStatus.
 *
 * Tradedoubler docs use: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
 * We defensively lower-case before matching.
 *
 * Why 'suspended' for TERMINATED: the publisher is blocked from earning on the
 * programme but it still exists in the system; 'suspended' is the closest
 * canonical state. The raw value is always available in `rawNetworkData`.
 */
function mapProgrammeStatus(raw: TdProgrammeRaw): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'joined' || s === 'active') return 'joined';
  if (s === 'applied' || s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'not_joined' || s === 'not joined' || s === 'available') return 'available';
  if (s === 'terminated' || s === 'suspended' || s === 'paused') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: Tradedoubler transaction status → canonical TransactionStatus.
 *
 * Tradedoubler uses single-char codes:
 *   A = Accepted  → 'approved'
 *   P = Pending   → 'pending'
 *   D = Denied    → 'reversed'
 *
 * `paid` is a separate boolean flag (// TODO(verify): exact field name).
 * When it's true, we override to 'paid' regardless of the status char.
 *
 * Any other value → 'other' (honest over invented).
 */
function mapTransactionStatus(raw: TdTransactionRaw): TransactionStatus {
  // paid overrides the status char — same pattern as Awin's paidToPublisher.
  if (raw.paid === true) return 'paid';

  const s = (raw.status ?? '').toUpperCase();
  switch (s) {
    case 'A':
    case 'ACCEPTED':
    case 'APPROVED':
      return 'approved';
    case 'P':
    case 'PENDING':
      return 'pending';
    case 'D':
    case 'DENIED':
    case 'DECLINED':
    case 'REVERSED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Compute the age (in days) of a transaction at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this number.
 *
 * Priority order:
 *   1. timeOfLastModified / lastModifiedDate — when was the transaction last
 *      updated (approval date for accepted/denied). Best proxy for
 *      "how long has this been in its current state".
 *   2. timeOfTransaction / transactionDate — the conversion timestamp.
 *   3. 0 — no timestamp available.
 */
export function computeAgeDays(raw: TdTransactionRaw, now: Date = new Date()): number {
  const anchor =
    raw.timeOfLastModified ??
    raw.lastModifiedDate ??
    raw.timeOfTransaction ??
    raw.transactionDate;
  if (!anchor) return 0;
  const t = typeof anchor === 'number' ? anchor : Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(v?: string | number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const ts = typeof v === 'number' ? v : Date.parse(v as string);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: TdProgrammeRaw): Programme {
  // Tradedoubler may use `id` or `programId` depending on the endpoint.
  const id = String(raw.id ?? raw.programId ?? '');
  const name =
    raw.name ?? raw.programName ?? raw.advertiserName ?? `Tradedoubler programme ${id}`;
  const currency =
    raw.currency ?? raw.currencyCode ?? raw.currency3Code; // TODO(verify): field name

  // Categories: may be a string array or an object array.
  let categories: string[] | undefined;
  if (Array.isArray(raw.categories)) {
    categories = (raw.categories as Array<string | { name?: string }>)
      .map((c) => (typeof c === 'string' ? c : (c.name ?? '')))
      .filter(Boolean);
  } else if (typeof raw.category === 'string' && raw.category) {
    categories = [raw.category];
  }

  // Commission: Tradedoubler may surface min/max range or a type string.
  const commissionRate =
    raw.commissionMin !== undefined || raw.commissionMax !== undefined
      ? {
          type: 'unknown' as const,
          description:
            [
              raw.commissionMin !== undefined ? `min: ${raw.commissionMin}` : undefined,
              raw.commissionMax !== undefined ? `max: ${raw.commissionMax}` : undefined,
              raw.commissionType,
            ]
              .filter(Boolean)
              .join(', ') || undefined,
        }
      : undefined;

  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency,
    commissionRate,
    categories: categories && categories.length > 0 ? categories : undefined,
    advertiserUrl: raw.advertiserUrl ?? raw.websiteUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: TdTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // Tradedoubler surfaces `commission` directly; `orderValue` is the gross sale.
  const commission = raw.commission ?? 0;
  const sale = raw.orderValue ?? 0;
  const currency = raw.currency ?? raw.currencyCode ?? 'GBP'; // TODO(verify): currency field

  const id = String(raw.transactionId ?? raw.generatedId ?? '');
  const programmeId = String(raw.programId ?? '');
  const programmeName = raw.program ?? raw.programName ?? raw.eventName ?? '';

  const dateConverted =
    nullableIso(raw.timeOfTransaction ?? raw.transactionDate) ??
    new Date(0).toISOString();
  const dateClicked = nullableIso(raw.clickDate);
  const dateApproved = nullableIso(raw.timeOfLastModified ?? raw.lastModifiedDate);

  return {
    id,
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid: undefined, // TODO(verify): Tradedoubler doesn't expose a paid-date field per docs
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.statusReason ?? raw.reasonName ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Pagination helper — Tradedoubler paginates with offset + limit (max 100)
// ---------------------------------------------------------------------------

const TD_PAGE_SIZE = 100;

/**
 * Fetch all pages of a paginated Tradedoubler endpoint that returns
 * `{ items: T[], total?: number, offset?: number, limit?: number }`.
 *
 * Tradedoubler caps `limit` at 100 per request. We paginate automatically so
 * callers can request a wider result set without hitting the cap.
 *
 * A `maxItems` cap prevents runaway fetches in capabilitiesCheck probes.
 */
async function fetchAllPages<T>(
  fetcher: (offset: number, limit: number) => Promise<{ items?: T[]; total?: number }>,
  maxItems?: number,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  let keepGoing = true;

  while (keepGoing) {
    const remaining = maxItems !== undefined ? maxItems - all.length : TD_PAGE_SIZE;
    if (remaining <= 0) break;
    const limit = Math.min(TD_PAGE_SIZE, remaining);

    const page = await fetcher(offset, limit);
    const items = page.items ?? [];
    all.push(...items);

    if (items.length < limit) {
      keepGoing = false; // last page
    } else if (page.total !== undefined && all.length >= page.total) {
      keepGoing = false;
    } else {
      offset += limit;
    }
  }

  return all;
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class TradedoublerAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Tradedoubler programmes (advertisers) the publisher has joined or could
   * join.
   *
   * Tradedoubler endpoint: GET /publisher/programs
   * Supported query params: status, fromDate, toDate, offset, limit, sortBy, sortOrder.
   *
   * // TODO(verify): status filter values in the query string (e.g. "JOINED" vs "joined")
   * // TODO(verify): exact field names in the response against a live account.
   *
   * We default to fetching all programmes (no status filter) and perform
   * client-side filtering by status, search, and categories because the server-
   * side filter behaviour against the join-status values is not fully confirmed.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');
    const orgId = requireOrganizationId('listProgrammes');

    void orgId; // used for future per-org scoping if Tradedoubler requires it

    const raw = await fetchAllPages<TdProgrammeRaw>(
      (offset, limit) =>
        tradedoublerRequest<TdProgrammesResponse>({
          operation: 'listProgrammes',
          path: '/publisher/programs',
          token,
          query: {
            offset,
            limit,
            // TODO(verify): Tradedoubler may require organisation scoping here
          },
          resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
        }),
      query?.limit !== undefined ? query.limit * 3 : undefined, // rough page cap
    );

    let programmes = raw.map(toProgramme);

    // Client-side filters.
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
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

    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single programme by programme ID.
   *
   * Tradedoubler endpoint: GET /publisher/programs/detail?programId={id}
   * // TODO(verify): exact query parameter name and response shape.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw configError(
        'getProgramme',
        'programmeId is required for Tradedoubler.',
        'Use listProgrammes to discover programme IDs.',
      );
    }

    const token = requireToken('getProgramme');
    const orgId = requireOrganizationId('getProgramme');
    void orgId;

    const raw = await tradedoublerRequest<TdProgrammeRaw | { program?: TdProgrammeRaw }>({
      operation: 'getProgramme',
      path: '/publisher/programs/detail',
      token,
      query: { programId: programmeId }, // TODO(verify): query param name
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // Some endpoints wrap the result in a `program` envelope; unwrap if so.
    const flat =
      (raw as { program?: TdProgrammeRaw }).program ?? (raw as TdProgrammeRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List publisher transactions (conversions).
   *
   * Tradedoubler endpoint: GET /publisher/report/transactions
   * Params: fromDate (YYYYMMDD), toDate (YYYYMMDD), programId, status, offset, limit.
   *
   * Status values: A (Accepted), P (Pending), D (Denied).
   * // TODO(verify): date format confirmed as YYYYMMDD from Apiary docs.
   * // TODO(verify): status filter values in query string.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');
    const orgId = requireOrganizationId('listTransactions');
    void orgId;

    const now = new Date();
    const window = defaultWindow(30);
    const toDate = query?.to ? new Date(query.to) : window.to;
    const fromDate = query?.from ? new Date(query.from) : window.from;

    const fromDateStr = formatTdDate(fromDate);
    const toDateStr = formatTdDate(toDate);

    const raw = await fetchAllPages<TdTransactionRaw>(
      (offset, limit) =>
        tradedoublerRequest<TdTransactionsResponse>({
          operation: 'listTransactions',
          path: '/publisher/report/transactions',
          token,
          query: {
            fromDate: fromDateStr,
            toDate: toDateStr,
            offset,
            limit,
            programId: query?.programmeId,
          },
          resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
        }),
    );

    let transactions = raw.map((r) => toTransaction(r, now));

    // Status filter — client-side after normalisation.
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9.
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
   * Aggregate transactions into an earnings summary.
   *
   * We derive from `listTransactions` rather than calling
   * GET /publisher/payments/earnings directly for the same reasons as in the
   * Awin adapter: per-transaction `ageDays` is needed for `oldestUnpaidAgeDays`
   * and the dedicated earnings endpoint's bucket structure may not match our
   * canonical TransactionStatus set.
   *
   * // TODO(verify): consider using /publisher/payments/earnings for faster
   * //   summaries once the response shape is confirmed against a live account.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const window = defaultWindow(30);
    const from = query?.from ?? window.from.toISOString();
    const to = query?.to ?? window.to.toISOString();

    // Pull underlying transactions (no limit — a limited summary would silently
    // undercount, violating PRD principle 4.1).
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
      currency: 'GBP',
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
          programmeName: t.programmeName || `Tradedoubler programme ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid age.
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
      currency: firstCurrency ?? 'GBP',
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
   * Tradedoubler does not expose click-level data via the public publisher API.
   *
   * Statistics (GET /publisher/report/statistics) include aggregated click
   * counts but NOT per-click records with individual timestamps or IDs.
   * We throw `NotImplementedError` rather than returning empty — see the
   * Awin adapter for the rationale (the difference between "no clicks" and
   * "clicks not exposed" is the difference between an actionable observation
   * and a wild goose chase).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Tradedoubler does not expose click-level data via the public publisher API. ' +
        'Aggregated click statistics are available via the Tradedoubler dashboard.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Tradedoubler tracking deep-link.
   *
   * Documented format (verified from Tradedoubler tracking docs):
   *
   *   https://clk.tradedoubler.com/click
   *     ?p={programId}    — mandatory: the programme/advertiser ID
   *     &a={siteId}       — mandatory: the publisher site ID (= TRADEDOUBLER_ORGANIZATION_ID)
   *     &url={encoded}    — destination URL, URL-encoded, must be last param
   *
   * Why deterministic construction: Tradedoubler's tracking URL format is
   * stable and publicly documented. An API round-trip would add latency and a
   * failure mode with no benefit — all properties of the resulting URL are
   * already known at call time.
   *
   * Note: `a` (site ID) is the publisher's TRADEDOUBLER_ORGANIZATION_ID at the
   * moment no per-source site ID is configured. If a publisher has multiple
   * traffic sources, the correct `a` value should be the source ID matching
   * the content site — this adapter uses the organisation ID as a sensible
   * default. // TODO(verify): confirm siteId vs orgId disambiguation.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Tradedoubler tracking links require the programme ID.',
          hint:
            'Pass `programmeId`. Use listProgrammes to discover programme IDs.',
        }),
      );
    }
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the merchant page you want to link to.',
        }),
      );
    }

    // We require credentials as a sanity check even though we don't make a
    // network call — better to fail now than at first click.
    requireToken('generateTrackingLink');
    const orgId = requireOrganizationId('generateTrackingLink');

    // `url=` must be the last parameter so it captures the full encoded URL.
    const trackingUrl =
      `https://clk.tradedoubler.com/click` +
      `?p=${encodeURIComponent(input.programmeId)}` +
      `&a=${encodeURIComponent(orgId)}` +
      `&url=${encodeURIComponent(input.destinationUrl)}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'clk.tradedoubler.com/click deterministic construction',
        p: input.programmeId,
        a: orgId,
        url: input.destinationUrl,
        // TODO(verify): confirm that siteId === orgId in single-site setups
      },
    };
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
  // Admin operations (publisher adapter — throw NotImplementedError)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'listPublishers is an admin/brand-side operation; Tradedoubler publisher adapter does not implement it.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError(
      'listPublisherSectors is an admin/brand-side operation; Tradedoubler publisher adapter does not implement it.',
    );
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
   * Probe each operation with a minimal call to record live capability data.
   *
   * `listClicks` is recorded as `supported: false` without probing — Tradedoubler
   * doesn't expose per-click records, so calling it is pure waste.
   * `generateTrackingLink` is recorded as supported-without-probe because it's
   * deterministic and doesn't require a real programme ID to construct.
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
          claimStatus: 'experimental',
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

    operations['listClicks'] = {
      supported: false,
      note: 'Tradedoubler does not expose click-level data via the public publisher API',
    };

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction; no live probe.',
      claimStatus: 'experimental',
    };

    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known programme ID; not probed automatically.',
      claimStatus: 'experimental',
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

export const tradedoublerAdapter = new TradedoublerAdapter();
registerAdapter(tradedoublerAdapter);

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

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface but are accessible from fixture-only tests.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  formatTdDate,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
