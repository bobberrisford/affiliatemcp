/**
 * Tradedoubler adapter — publisher side.
 *
 * Built from public API documentation (connect.tradedoubler.com / Apiary) and
 * verified against third-party client libraries and integration guides as of
 * 2026-05-28. NOT yet verified against a live Tradedoubler account.
 *
 * --- Tradedoubler API surface used -------------------------------------------
 *
 *   Base URL: https://connect.tradedoubler.com
 *   Auth:     OAuth2 bearer token in `Authorization: Bearer {token}` header.
 *
 *             The connect.tradedoubler.com API uses a full OAuth2 Resource Owner
 *             Password Credentials (ROPC) flow to obtain the bearer token:
 *               POST /uaa/oauth/token
 *               grant_type=password, client_id, client_secret, username, password
 *             Credentials are created under publisher dashboard → Tools → API Info.
 *             Tokens are obtained automatically via fetchOAuthToken() on each
 *             session and cached for 55 minutes.
 *             Source: packagist.org/packages/eelcol/laravel-tradedoubler,
 *                     Funnel Knowledge Base (help.funnel.io)
 *
 *   GET /publisher/programs
 *     → List programmes the publisher has joined / can join.
 *     Params: status, fromDate, toDate, offset, limit, sortBy, sortOrder
 *     Status values (confirmed from Apiary): JOINED, NOT_JOINED, APPLIED,
 *       DECLINED, TERMINATED.
 *
 *   GET /publisher/programs/detail?programId={id}
 *     → Single programme detail including tracking links and commission tariffs.
 *     Query param confirmed as `programId` from the Apiary blueprint.
 *
 *   GET /publisher/report/transactions
 *     → Transactions (conversions) for the publisher.
 *     Params: fromDate (YYYYMMDD), toDate (YYYYMMDD), programId, status,
 *             offset, limit, sortBy, sortOrder
 *     Status values (confirmed from Apiary): A=Accepted/approved, P=Pending,
 *       D=Denied/reversed
 *     Core fields confirmed from multiple sources (Apiary + whitelabeled client
 *     + third-party integrations):
 *       transactionId, programId, status, commission, orderValue,
 *       timeOfTransaction, timeOfLastModified, clickDate, statusReason,
 *       reasonId, orderNr, epi1, epi2, eventId, eventName, mediaId
 *     Currency field name not confirmed from public docs — `currency` is used
 *     defensively with `currencyCode` fallback (BLOCKED pending live account).
 *     No `paid` boolean field documented — BLOCKED pending live account.
 *     No `datePaid` field documented — BLOCKED.
 *
 *   GET /publisher/payments/earnings
 *     → Publisher earnings summary (not used at v0.1 — derived from transactions).
 *
 *   Tracking links: deterministic construction (confirmed from dev.tradedoubler.com).
 *     https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}
 *     p = programme ID (mandatory)
 *     a = publisher SITE ID (mandatory; this is the website-level ID, not the
 *         organisation ID — see note in generateTrackingLink). For a publisher
 *         with a single registered site the site ID often equals the org ID,
 *         but they are architecturally distinct.
 *     url = destination URL, URL-encoded, must be last param
 *     Source: dev.tradedoubler.com search results, Stape.io Tradedoubler tag docs.
 *
 *   GET /usermanagement/users/me → auth check (see auth.ts)
 *     Returns: id, email, firstName, lastName, organisationId (field name not
 *     confirmed against live account — BLOCKED).
 *
 *   listClicks: Tradedoubler publisher statistics API exposes only aggregated
 *     click/impression counts grouped by programme, site, or ad — NOT
 *     individual click records. NotImplementedError is correct here.
 *     Source: Supermetrics Tradedoubler connection guide search result,
 *             Apiary publisher stats endpoint description.
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
  docsUrl: 'https://docs.tradedoubler.com/',
  adapterVersion: '0.1.1',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Click-level data is not exposed via the public Tradedoubler publisher API; only aggregated statistics (counts by programme/site/ad) are available. listClicks throws NotImplementedError.',
    'The connect.tradedoubler.com API uses OAuth2 Resource Owner Password Credentials (ROPC) flow; tokens are obtained automatically from TRADEDOUBLER_CLIENT_ID/CLIENT_SECRET/USERNAME/PASSWORD and cached for 55 minutes.',
    'The tracking link `a=` parameter is the publisher SITE ID (website-level), which may differ from TRADEDOUBLER_ORGANIZATION_ID in multi-site publisher accounts.',
    'The `paid` boolean field on transactions and `currency` field name are not confirmed from public documentation; blocked pending live account verification.',
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
// the Apiary blueprint and third-party client libraries as of 2026-05-28)
// ---------------------------------------------------------------------------

/**
 * A programme returned by GET /publisher/programs.
 *
 * Status strings confirmed from Apiary blueprint: JOINED, NOT_JOINED, APPLIED,
 * DECLINED, TERMINATED.
 *
 * Field-name notes:
 *   id / programId     — primary field confirmed as `id` from Apiary; `programId`
 *                        is kept as fallback (some detail endpoints use it).
 *   name               — confirmed field name from Apiary.
 *   programName / advertiserName — alternates kept defensively; not confirmed.
 *   status             — confirmed from Apiary status enum values.
 *   currency           — confirmed as the field name in Apiary programme objects.
 *   currencyCode / currency3Code — defensive fallbacks; not confirmed in docs.
 *   advertiserUrl      — confirmed from Apiary.
 *   websiteUrl         — defensive fallback; not confirmed.
 *   category           — singular string variant (observed in third-party libs).
 *   categories         — object-array variant confirmed from Apiary example.
 *   commissionMin/Max/Type — BLOCKED: field names not confirmed from public docs.
 *   defaultTracking    — confirmed from Apiary detail endpoint.
 */
interface TdProgrammeRaw {
  id?: number | string;
  programId?: number | string; // alternate (used in detail endpoint queries)
  name?: string;
  programName?: string; // defensive fallback; not confirmed from docs
  advertiserName?: string; // defensive fallback; not confirmed from docs
  status?: string; // JOINED | NOT_JOINED | APPLIED | DECLINED | TERMINATED
  currency?: string; // confirmed field name from Apiary programme objects
  currencyCode?: string; // defensive fallback; not confirmed
  currency3Code?: string; // defensive fallback; not confirmed
  advertiserUrl?: string; // confirmed from Apiary
  websiteUrl?: string; // defensive fallback; not confirmed
  category?: string; // singular string (observed in third-party integrations)
  categories?: string[] | Array<{ name?: string }>; // array form (Apiary example)
  commissionMin?: number; // BLOCKED: field name not confirmed from public docs
  commissionMax?: number; // BLOCKED: field name not confirmed from public docs
  commissionType?: string; // BLOCKED: field name not confirmed from public docs
  defaultTracking?: string; // confirmed from Apiary detail endpoint
}

/**
 * Paginated programmes response from /publisher/programs.
 * Pagination envelope shape (items/offset/limit/total) confirmed from Apiary
 * blueprint as the standard connect.tradedoubler.com pagination model.
 */
interface TdProgrammesResponse {
  items?: TdProgrammeRaw[];
  offset?: number;
  limit?: number;
  total?: number;
}

/**
 * A transaction returned by GET /publisher/report/transactions.
 *
 * Field names sourced from the Apiary blueprint, whitelabeled/tradedoubler-api-client
 * README (getTransactions() response), and cross-referenced with the legacy
 * XML API (reports.tradedoubler.com) field mapping in that client's Transaction.php.
 *
 * Confirmed fields (Apiary + whitelabeled client + third-party corroboration):
 *   transactionId, programId, status (A/P/D), commission, orderValue,
 *   timeOfTransaction, timeOfLastModified, clickDate, statusReason, reasonId,
 *   orderNr, leadNr, epi1, epi2, eventId, eventName, mediaId, deviceType.
 *
 * BLOCKED fields (not confirmed from any public source):
 *   currency / currencyCode — currency field name not documented in modern JSON API.
 *   paid — no `paid` boolean mentioned in Apiary or any third-party source.
 *   reasonName — not in Apiary or whitelabeled client.
 *
 * Defensive alternate field names are retained with comments indicating
 * "defensive fallback" to distinguish from BLOCKED unknowns.
 */
interface TdTransactionRaw {
  transactionId?: number | string; // confirmed from Apiary + whitelabeled client
  generatedId?: number | string; // legacy XML API field name (defensive fallback)
  programId?: number | string; // confirmed from Apiary + whitelabeled client
  sourceId?: number | string; // publisher site ID (defensive; not in modern docs)
  eventTypeId?: number; // 4=Lead, 5=Sale (confirmed from Apiary)
  eventId?: number | string; // confirmed from whitelabeled client
  eventName?: string; // confirmed from whitelabeled client
  status?: string; // A=Accepted, P=Pending, D=Denied — confirmed from Apiary
  statusReason?: string; // confirmed from whitelabeled client (pendingReason in XML)
  reasonId?: number; // confirmed from Apiary (added 2022-06-01 changelog)
  reasonName?: string; // BLOCKED: not confirmed from any public source
  timeOfTransaction?: string; // confirmed from Apiary (ISO 8601 format)
  transactionDate?: string; // legacy/alternate spelling (defensive fallback)
  clickDate?: string; // confirmed from whitelabeled client (timeOfVisit in XML)
  timeOfLastModified?: string; // confirmed from Apiary + whitelabeled client
  lastModifiedDate?: string; // alternate spelling (defensive fallback)
  orderValue?: number; // confirmed from Apiary + whitelabeled client
  commission?: number; // confirmed from Apiary + whitelabeled client
  currency?: string; // BLOCKED: currency field name not confirmed in modern JSON API
  currencyCode?: string; // BLOCKED: alternate — not confirmed in any source
  orderNr?: string; // confirmed from whitelabeled client (orderNR in XML)
  leadNr?: string; // confirmed from whitelabeled client (leadNR in XML)
  deviceType?: string; // confirmed from whitelabeled client
  epi1?: string; // confirmed from Apiary + whitelabeled client
  epi2?: string; // confirmed from Apiary + whitelabeled client
  mediaId?: number | string; // confirmed from whitelabeled client (siteId in XML)
  mediaName?: string; // confirmed from whitelabeled client (siteName in XML)
  program?: string; // programme name string (confirmed from whitelabeled client)
  programName?: string; // alternate spelling (defensive fallback)
  paid?: boolean; // BLOCKED: no `paid` boolean documented in any public source
}

/**
 * Paginated transactions response from /publisher/report/transactions.
 * Pagination envelope (items/offset/limit/total) confirmed from Apiary
 * blueprint as the standard connect.tradedoubler.com pagination model.
 */
interface TdTransactionsResponse {
  items?: TdTransactionRaw[];
  offset?: number;
  limit?: number;
  total?: number;
}

/**
 * A single publisher source (registered website/site) returned by
 * GET /publisher/sources.
 *
 * Field names sourced from Tradedoubler publisher API docs (2026-06-01).
 * All fields are optional defensively; `id` is the site ID used as the
 * `a=` parameter in tracking links.
 */
interface TdSourceRaw {
  id?: number | string;
  name?: string;
  url?: string;
  type?: string;
  status?: string;
}

/**
 * Paginated response from GET /publisher/sources.
 */
interface TdSourcesResponse {
  items?: TdSourceRaw[];
  offset?: number;
  limit?: number;
  total?: number;
}

/**
 * A publisher source (registered site) — the canonical shape returned by
 * `listPublisherSources`. Network-specific to Tradedoubler; not a shared
 * cross-network type.
 */
export interface TdPublisherSource {
  id: string;
  name: string;
  url?: string;
  type?: string;
  status?: string;
  rawNetworkData: unknown;
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
//   currencyCode?: string; // BLOCKED: exact field name not confirmed from public docs
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
 * Tradedoubler uses single-char codes confirmed from Apiary docs:
 *   A = Accepted  → 'approved'
 *   P = Pending   → 'pending'
 *   D = Denied    → 'reversed'
 *
 * `paid` is a BLOCKED field — no public documentation confirms a `paid` boolean
 * exists in the modern JSON API. The mapping is kept for robustness; if a live
 * account reveals the field exists under a different name, correct here and in
 * TdTransactionRaw.
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
  // BLOCKED: currency field name not confirmed from public docs for the modern
  // JSON API. `currency` is used first as the most common convention; currencyCode
  // and currency3Code are defensive fallbacks. Verify against a live account.
  const currency =
    raw.currency ?? raw.currencyCode ?? raw.currency3Code;

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
  // BLOCKED: currency field name not confirmed from public docs for the modern
  // JSON API. Defaulting to GBP as the network's primary market.
  const currency = raw.currency ?? raw.currencyCode ?? 'GBP';

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
    datePaid: undefined, // BLOCKED: No datePaid / paymentDate / paidDate field found in
    // any Tradedoubler public documentation (Apiary, dev.tradedoubler.com, third-party clients).
    // Verify against a live account before implementing.
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.statusReason ?? raw.reasonName ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Source transformer
// ---------------------------------------------------------------------------

function toSource(raw: TdSourceRaw): TdPublisherSource {
  const id = String(raw.id ?? '');
  const name = raw.name ?? id;
  return {
    id,
    name,
    url: raw.url,
    type: raw.type,
    status: raw.status,
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
   * Status filter values: The Apiary docs show status values as UPPERCASE strings
   * (JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED). Server-side filtering
   * by status is not yet live-tested so we fetch all and filter client-side to
   * avoid silent mismatches.
   * BLOCKED: Exact server-side status filter behaviour requires live testing.
   *
   * Field names: `id`, `name`, `status`, `currency`, `advertiserUrl`, `categories`
   * confirmed from Apiary. `commissionMin`/`commissionMax`/`commissionType` are
   * BLOCKED (not confirmed from public docs).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = await requireToken();

    const raw = await fetchAllPages<TdProgrammeRaw>(
      (offset, limit) =>
        tradedoublerRequest<TdProgrammesResponse>({
          operation: 'listProgrammes',
          path: '/publisher/programs',
          token,
          query: {
            offset,
            limit,
            // BLOCKED: It is not confirmed from public docs whether Tradedoubler
          // requires an organisation ID query parameter for publisher programme
          // listing. The orgId is read above and available if needed.
          // Verify against a live account.
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
   * Query parameter `programId` confirmed from Apiary blueprint.
   * Response shape may wrap the result in a `program` envelope — handled
   * defensively via the flat/unwrap logic below.
   * BLOCKED: Exact response envelope shape (flat vs wrapped) requires live testing.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw configError(
        'getProgramme',
        'programmeId is required for Tradedoubler.',
        'Use listProgrammes to discover programme IDs.',
      );
    }

    const token = await requireToken();

    const raw = await tradedoublerRequest<TdProgrammeRaw | { program?: TdProgrammeRaw }>({
      operation: 'getProgramme',
      path: '/publisher/programs/detail',
      token,
      query: { programId: programmeId }, // confirmed from Apiary blueprint
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
   * Date format confirmed as YYYYMMDD from Apiary blueprint.
   * Status values confirmed as A (Accepted), P (Pending), D (Denied) from Apiary.
   * Server-side status filter values are not yet live-tested; filtering is
   * applied client-side after normalisation.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = await requireToken();
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
   * BLOCKED: The /publisher/payments/earnings endpoint response shape is not
   * confirmed from public docs. Using transaction-derived aggregation is safer
   * for now as it correctly populates ageDays and per-transaction status.
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
   * Tradedoubler does not expose per-click records via the public publisher API.
   *
   * GET /publisher/report/statistics returns aggregated click and impression
   * counts grouped by programme, affiliate site, or ad — NOT individual click
   * records with unique IDs or timestamps. This is confirmed from Tradedoubler's
   * statistics API description (Supermetrics integration guide and Apiary docs).
   *
   * Source: Supermetrics Tradedoubler connection guide (search result 2026-05-28),
   *         Apiary publisher stats endpoint description.
   *
   * We throw `NotImplementedError` rather than returning empty — the difference
   * between "no clicks" and "clicks not exposed" is the difference between an
   * actionable observation and a wild goose chase (same rationale as Awin adapter).
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
   * Documented format (confirmed from dev.tradedoubler.com and Stape.io docs):
   *
   *   https://clk.tradedoubler.com/click
   *     ?p={programId}    — mandatory: the programme/advertiser ID
   *     &a={siteId}       — mandatory: the publisher SITE ID (website-level)
   *     &url={encoded}    — destination URL, URL-encoded, must be last param
   *
   * Why deterministic construction: Tradedoubler's tracking URL format is
   * stable and publicly documented. An API round-trip would add latency and a
   * failure mode with no benefit — all properties of the resulting URL are
   * already known at call time.
   *
   * SITE ID vs ORGANISATION ID:
   * The `a=` parameter is the publisher's registered SITE ID (per-website),
   * which is architecturally distinct from the ORGANISATION ID. For publishers
   * with a single registered website the two values are usually the same number,
   * but for multi-site publishers the site ID must match the traffic source.
   * This adapter uses TRADEDOUBLER_ORGANIZATION_ID as a sensible single-site
   * default. Publishers with multiple registered sites should set a per-site
   * ID in their configuration.
   * Source: dev.tradedoubler.com FAQ (search snippet: "Site ID (a) is a unique
   * identifier that ensures valid clicks, leads and sales are attributed to
   * your publisher site")
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
    await requireToken();
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
        // Note: `a` is the publisher site ID (= TRADEDOUBLER_ORGANIZATION_ID here).
        // For multi-site publishers this should be the specific site's ID.
        // See generateTrackingLink docstring for full explanation.
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
  // listPublisherSources
  // -------------------------------------------------------------------------

  /**
   * List publisher sources (registered websites/sites) for this account.
   *
   * Tradedoubler endpoint: GET /publisher/sources
   *
   * Sources are the publisher's registered sites. The `id` of each source is
   * the site ID used as the `a=` parameter in tracking links, and may be used
   * as a filter parameter in other publisher endpoints.
   *
   * Source: https://docs.tradedoubler.com/docs/publisher/jdqpo3oryw7zn-list-publisher-sources
   */
  async listPublisherSources(): Promise<TdPublisherSource[]> {
    const token = await requireToken();

    const raw = await fetchAllPages<TdSourceRaw>(
      (offset, limit) =>
        tradedoublerRequest<TdSourcesResponse>({
          operation: 'listPublisherSources',
          path: '/publisher/sources',
          token,
          query: { offset, limit },
          resilience: RESILIENCE.default,
        }),
    );

    return raw.map(toSource);
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
  toSource,
  formatTdDate,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
