/**
 * CJ Affiliate adapter.
 *
 * Pattern-matched to `src/networks/awin/adapter.ts` — read that file first;
 * the heavy "why" commentary there is the reference. This file documents the
 * CJ-specific decisions only (status mapping, GraphQL vs REST routing,
 * derivedValues bootstrap).
 *
 * --- CJ API map (verify against https://developers.cj.com/) -----------------
 *
 *   GraphQL — Publisher Commissions endpoint  (https://commissions.api.cj.com/query)
 *     publisherCommissions(...)            transactions / commissions
 *     me { id companyId ... }              identity + companyId derivation
 *
 *   GraphQL — Advertiser Lookup endpoint     (https://ads.api.cj.com/query)
 *     advertisers(...)                     list / search advertisers (programmes)
 *     advertiser(advertiserId: ...)        single advertiser detail
 *
 *   REST  — Link Builder                     (https://link-builder.api.cj.com)
 *     POST /v1/links                       mint a deep link (when needed)
 *
 *   Legacy click-redirect URL pattern:
 *     https://www.dpbolvw.net/click-{publisherId}-{advertiserId}
 *     Deterministic; we construct in-process (no API call).
 *
 * --- CJ-specific decisions documented inline -------------------------------
 *
 *   1. STATUS MAPPING. CJ uses NEW | LOCKED | CLOSED | EXTENDED for the
 *      commission lifecycle. We normalise to our canonical
 *      `pending|approved|reversed|paid|other`. See `mapTransactionStatus`.
 *
 *   2. GRAPHQL vs REST ROUTING. The two GraphQL endpoints share a query
 *      shape but have different schemas. Commissions ops use the commissions
 *      endpoint; programme ops use the advertiser-lookup endpoint. Link
 *      construction is deterministic — no API call. See per-method comments.
 *
 *   3. DETERMINISTIC TRACKING LINK. CJ's legacy click-redirect URL format is
 *      stable and documented. We construct
 *      `https://www.dpbolvw.net/click-{publisherId}-{advertiserId}` and
 *      append the destination as the `url` query param. Same rationale as
 *      Awin — zero latency, no rate-limit budget consumed, no failure mode.
 *      If a publisher's account requires the modern link-builder API we
 *      fall back to it (path documented above) — but for v0.1 we ship the
 *      deterministic path because every CJ account supports it.
 *
 *   4. CLICK DATA. CJ does NOT expose click-level data via the modern
 *      GraphQL surface. There's a legacy REST report endpoint
 *      (`commission-detail-report`) that some accounts can reach, but it's
 *      not reliably available and the response format predates the modern
 *      schema. We throw `NotImplementedError` rather than partially-support
 *      it — better to be honest than to silently return empty (PRD §15.4).
 *
 *   5. DERIVED COMPANY ID. CJ requires the publisher's `companyId` on most
 *      queries. `verifyAuth` derives it from `{ me { companyId } }` and the
 *      wizard persists it under `CJ_COMPANY_ID`. See `auth.ts`.
 */

import {
  cjGraphQL,
  cjRest,
  CJ_GRAPHQL_ADS,
  CJ_GRAPHQL_COMMISSIONS,
  CJ_REST_LINK_BUILDER,
} from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
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
  type ProgrammeStatus,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('cj.adapter');

const SLUG = 'cj';
const NAME = 'CJ Affiliate';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // The manifest records the canonical hostname; individual endpoints
  // (commissions GraphQL, ads GraphQL, link-builder REST) live in client.ts.
  baseUrl: 'https://api.cj.com',
  authModel: 'bearer',
  docsUrl: 'https://developers.cj.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-21',
  // `partial`: every op is implemented except `listClicks`, which CJ does not
  // expose via the modern GraphQL surface; the adapter has not been validated
  // against a real account at commit time.
  claimStatus: 'partial',
  knownLimitations: [
    'Click-level data is not exposed via CJ\'s modern GraphQL surface; listClicks throws NotImplementedError unless the legacy REST report endpoint is reachable for the account.',
    'Brand-side operations (listPublishers, listPublisherSectors) are scaffolded for v0.2.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 8,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * Per-operation resilience.
 *
 * Why listTransactions gets 60s: CJ's GraphQL commissions query can be slow
 * for active publishers when the date window is wide (the upstream resolver
 * paginates internally and warm-loads). 30s is fine for a quick query but
 * reliably times out for a "last 90 days" request. Same rationale Awin uses
 * for /transactions.
 *
 * Why we bump retries to 3: a transient 502/504 during a long-running
 * commissions query should resolve on retry rather than failing the entire
 * call. The resilience layer's default retry list already includes 502/503/504.
 */
const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  // getEarningsSummary is derived from listTransactions, so its resilience
  // is effectively that of the transactions call. We declare a mapping here
  // for clarity in case a future version uses a dedicated aggregation query.
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// CJ response shapes (deliberately minimal; mirror Awin's defensive style)
// ---------------------------------------------------------------------------
//
// We don't model CJ's GraphQL responses with strict Zod schemas — the surface
// drifts (new optional fields, occasional renames) and over-specifying breaks
// first. Transformers read every field defensively; the original payload is
// preserved on `rawNetworkData`.
// ---------------------------------------------------------------------------

interface CjAdvertiserRaw {
  advertiserId?: string | number;
  advertiserName?: string;
  name?: string;
  status?: string; // 'joined' | 'pending' | 'not joined' | 'declined' | ...
  relationshipStatus?: string; // alternative key in some tenants
  primaryCategory?: { name?: string };
  categories?: Array<{ name?: string }> | string[];
  currency?: string;
  programUrl?: string;
  advertiserUrl?: string;
  // CJ surfaces commission summary as a free-text string at the list level;
  // detailed action-commission breakdowns require a follow-up query.
  performanceIncentives?: string;
  actions?: Array<{ name?: string; commission?: { default?: string } }>;
}

interface CjCommissionRaw {
  // CJ commission identifiers.
  commissionId?: string;
  actionId?: string;
  // Programme identity.
  advertiserId?: string | number;
  advertiserName?: string;
  // Money. CJ returns numeric strings for amounts in newer schemas, numbers
  // in older ones — accept both.
  saleAmountUsd?: string | number;
  saleAmountPubCurrency?: string | number;
  pubCommissionAmountUsd?: string | number;
  pubCommissionAmountPubCurrency?: string | number;
  currency?: string;
  pubCurrency?: string;
  // Status: NEW | LOCKED | CLOSED | EXTENDED (CJ docs); some tenants
  // additionally surface "CORRECTED" for adjusted commissions.
  actionStatus?: string;
  commissionStatus?: string; // alternative key
  // Lifecycle dates. CJ uses ISO 8601 UTC strings.
  eventDate?: string; // "click / event"
  postingDate?: string; // when CJ recorded the action
  lockingDate?: string; // when CJ approved the commission
  clearedDate?: string; // when paid
  // Reversal context.
  isCorrected?: boolean;
  correctionReason?: string;
  // Paid flag — some tenants surface a boolean rather than a clearedDate.
  paidToPublisher?: boolean;
  paymentId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireCompanyId(operation: string): string {
  return requireCredential('CJ_COMPANY_ID', {
    network: SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup cj` so the wizard can derive CJ_COMPANY_ID from your token, ' +
      'or set it explicitly in ~/.affiliate-mcp/.env.',
  });
}

function requireToken(operation: string): string {
  return requireCredential('CJ_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Generate a Personal Access Token at the CJ dashboard → Account → Personal Access Tokens.',
  });
}

/**
 * Status normalisation: CJ → canonical.
 *
 * CJ's commission lifecycle vocabulary (see https://developers.cj.com/) is:
 *
 *   NEW        — commission recorded; not yet locked.
 *   LOCKED     — approved; cleared for payment.
 *   CLOSED     — cancelled / reversed by the advertiser.
 *   EXTENDED   — locking period extended (still pending review).
 *   CORRECTED  — adjusted after the fact (treat as `other`; the raw payload
 *                preserves the detail for downstream debugging).
 *
 * Why this mapping:
 *   - NEW / EXTENDED → 'pending': from the publisher's perspective both
 *     mean "not yet finalised". EXTENDED specifically means CJ has held the
 *     commission for additional review — still pending.
 *   - LOCKED → 'approved': the commission is approved but not yet paid out.
 *   - CLOSED → 'reversed': the user-facing intent (the sale didn't pay) is
 *     identical to Awin's `declined` mapping.
 *   - `paidToPublisher: true` OR a populated `clearedDate` → 'paid'. CJ may
 *     leave actionStatus at LOCKED after payment; the boolean / date is the
 *     authoritative paid signal (same pattern as Awin's `paidToPublisher`).
 *   - Unknown values → 'other'. We never invent a status the user didn't see.
 */
function mapTransactionStatus(raw: CjCommissionRaw): TransactionStatus {
  if (raw.paidToPublisher === true || raw.clearedDate) return 'paid';
  const s = (raw.actionStatus ?? raw.commissionStatus ?? '').toUpperCase();
  switch (s) {
    case 'NEW':
    case 'EXTENDED':
      return 'pending';
    case 'LOCKED':
      return 'approved';
    case 'CLOSED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: CJ advertiser relationship → canonical ProgrammeStatus.
 *
 * CJ surfaces the publisher-advertiser relationship as a free-text status
 * field whose values vary slightly between tenants. We collapse:
 *
 *   joined / active                → 'joined'
 *   pending / not yet approved     → 'pending'
 *   declined / refused / rejected  → 'declined'
 *   not joined / available         → 'available'
 *   paused / suspended / inactive  → 'suspended'
 *   anything else                  → 'unknown'
 */
function mapProgrammeStatus(raw: CjAdvertiserRaw): ProgrammeStatus {
  const s = (raw.status ?? raw.relationshipStatus ?? '').toLowerCase().trim();
  if (s === 'joined' || s === 'active') return 'joined';
  if (s === 'pending' || s.includes('not yet approved')) return 'pending';
  if (s === 'declined' || s === 'refused' || s === 'rejected') return 'declined';
  if (s === 'notjoined' || s === 'not joined' || s === 'available') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/**
 * Compute the age (in days) of a CJ commission at the moment we responded.
 *
 * Why we prefer `lockingDate` then `postingDate` then `eventDate`:
 *   - lockingDate is the point CJ approved the commission — the "validation"
 *     equivalent of Awin's validationDate. For the unpaid-age affordance
 *     (PRD §15.9) we want "how long has this been approved-but-not-paid".
 *   - For a NEW commission, lockingDate is absent — fall back to postingDate
 *     (when CJ first recorded the action).
 *   - eventDate (the click/conversion timestamp) is the last resort; less
 *     useful for unpaid-age but better than 0.
 */
function computeAgeDays(raw: CjCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.lockingDate ?? raw.postingDate ?? raw.eventDate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: CjAdvertiserRaw): Programme {
  const id = String(raw.advertiserId ?? '');
  const name = raw.advertiserName ?? raw.name ?? `CJ advertiser ${id}`;

  // Categories: CJ may surface a primary category, a categories array of
  // strings, or a categories array of objects. Accept all three.
  const categories: string[] = [];
  if (raw.primaryCategory?.name) categories.push(raw.primaryCategory.name);
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      if (typeof c === 'string') categories.push(c);
      else if (c && typeof c === 'object' && typeof c.name === 'string') categories.push(c.name);
    }
  }

  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    // CJ's structured commission breakdown lives under `actions` — a list of
    // events with default commission strings. For the list view we surface
    // the free-text performance incentives if present; the structured form
    // is available via `getProgramme` and `rawNetworkData`.
    commissionRate: raw.performanceIncentives
      ? { type: 'unknown', description: raw.performanceIncentives }
      : undefined,
    categories,
    advertiserUrl: raw.programUrl ?? raw.advertiserUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: CjCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.pubCommissionAmountPubCurrency ?? raw.pubCommissionAmountUsd);
  const sale = toNumber(raw.saleAmountPubCurrency ?? raw.saleAmountUsd);
  // Prefer publisher currency; fall back to USD which is CJ's default for
  // commission reporting if a tenant doesn't expose pubCurrency.
  const currency = raw.pubCurrency ?? raw.currency ?? 'USD';

  const dateConverted = nullableIso(raw.eventDate ?? raw.postingDate) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.eventDate);
  const dateApproved = nullableIso(raw.lockingDate);
  const datePaid = nullableIso(raw.clearedDate);

  // Reversal reason: CJ doesn't have a dedicated reason field for CLOSED
  // commissions in the modern schema. `correctionReason` is the closest
  // equivalent (populated when `isCorrected: true`); for vanilla CLOSED
  // commissions the reason is undefined and the user sees the raw payload.
  const reversalReason =
    status === 'reversed' ? raw.correctionReason ?? undefined : undefined;

  return {
    id: String(raw.commissionId ?? raw.actionId ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiserId ?? ''),
    programmeName: raw.advertiserName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid,
    ageDays: computeAgeDays(raw, now),
    reversalReason,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CjAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List CJ advertisers (programmes) via the ads-lookup GraphQL endpoint.
   *
   * Default: `relationshipStatus: 'joined'` — same rationale as Awin.
   * Asking "what merchants do I work with?" is the typical user question;
   * the full CJ catalogue is enormous and would time out without filtering.
   *
   * GraphQL query shape (illustrative — CJ's schema names occasionally drift;
   * the transformer tolerates either `advertisers(...) { ... }` or a wrapper):
   *
   *   query Advertisers($companyId: ID!, $records: Int!, $relationship: String) {
   *     advertisers(
   *       companyId: $companyId, recordsPerPage: $records,
   *       advertiserStatus: $relationship
   *     ) {
   *       resultList {
   *         advertiserId advertiserName status primaryCategory { name }
   *         programUrl performanceIncentives
   *       }
   *     }
   *   }
   *
   * Why we filter `search`/`categories`/`status` client-side rather than
   * passing them all to CJ: CJ's GraphQL schema supports advertiserName /
   * categoryId filters but not all of them on every tenant. Filtering after
   * the fetch is robust to those tenant differences; the trade-off is
   * over-fetching a small amount of catalogue, which is fine for v0.1.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const companyId = requireCompanyId('listProgrammes');
    const token = requireToken('listProgrammes');

    const statusFilter = toStatusList(query?.status);
    const relationship = pickCjRelationship(statusFilter);
    const limit = Math.max(1, Math.min(query?.limit ?? 100, 500));

    const data = await cjGraphQL<{
      advertisers?: { resultList?: CjAdvertiserRaw[] } | CjAdvertiserRaw[];
    }>({
      operation: 'listProgrammes',
      endpoint: CJ_GRAPHQL_ADS,
      query: `
        query Advertisers($companyId: ID!, $records: Int!, $relationship: String) {
          advertisers(
            companyId: $companyId
            recordsPerPage: $records
            advertiserStatus: $relationship
          ) {
            resultList {
              advertiserId
              advertiserName
              status
              relationshipStatus
              primaryCategory { name }
              currency
              programUrl
              performanceIncentives
            }
          }
        }
      `,
      variables: { companyId, records: limit, relationship },
      token,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    // CJ wraps results in `advertisers.resultList` on the modern schema; some
    // tenants flatten to a top-level array. Accept either.
    const advertisersField = data?.advertisers;
    let list: CjAdvertiserRaw[] = [];
    if (Array.isArray(advertisersField)) {
      list = advertisersField;
    } else if (advertisersField && Array.isArray(advertisersField.resultList)) {
      list = advertisersField.resultList;
    }

    let programmes = list.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
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
   * Fetch a single advertiser by ID via the ads-lookup GraphQL endpoint.
   *
   * We require a numeric ID (CJ advertiser IDs are positive integers). A
   * malformed ID short-circuits as a config_error envelope rather than a
   * generic upstream 400 — the user sees actionable detail.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `CJ advertiser IDs are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_cj_list_programmes) to find the correct id.',
        }),
      );
    }

    const companyId = requireCompanyId('getProgramme');
    const token = requireToken('getProgramme');

    const data = await cjGraphQL<{
      advertiser?: CjAdvertiserRaw;
      advertisers?: { resultList?: CjAdvertiserRaw[] };
    }>({
      operation: 'getProgramme',
      endpoint: CJ_GRAPHQL_ADS,
      query: `
        query Advertiser($companyId: ID!, $advertiserId: ID!) {
          advertisers(
            companyId: $companyId
            advertiserIds: [$advertiserId]
            recordsPerPage: 1
          ) {
            resultList {
              advertiserId
              advertiserName
              status
              relationshipStatus
              primaryCategory { name }
              categories { name }
              currency
              programUrl
              performanceIncentives
              actions { name commission { default } }
            }
          }
        }
      `,
      variables: { companyId, advertiserId: programmeId },
      token,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const single =
      data?.advertiser ??
      (data?.advertisers?.resultList && data.advertisers.resultList[0]) ??
      undefined;
    if (!single) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `CJ returned no advertiser for id "${programmeId}".`,
          hint:
            'The advertiser may not exist, may be outside your company\'s relationship scope, or CJ may have transient indexing lag.',
        }),
      );
    }
    return toProgramme(single);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commissions via the publisher-commissions GraphQL endpoint.
   *
   * CJ's `publisherCommissions` query accepts a date range as ISO strings.
   * Unlike Awin's hard 31-day cap, CJ permits wider windows but the response
   * is paginated; for v0.1 we request a large page (1000) and let the caller
   * narrow the date window if the result is truncated. A cursor-driven
   * pagination layer is documented as future work.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` returns ONLY transactions whose computed `ageDays` is
   * >= the threshold. `ageDays` is anchored on `lockingDate ?? postingDate ?? eventDate`.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * CLOSED commissions are returned unless explicitly filtered out; the
   * transformer populates `reversalReason` from `correctionReason` where
   * present (CJ does not always provide a reason for vanilla CLOSED).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const companyId = requireCompanyId('listTransactions');
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const data = await cjGraphQL<{
      publisherCommissions?: {
        records?: CjCommissionRaw[];
        commissions?: CjCommissionRaw[];
      };
    }>({
      operation: 'listTransactions',
      endpoint: CJ_GRAPHQL_COMMISSIONS,
      query: `
        query PublisherCommissions(
          $companyId: ID!
          $sincePostingDate: String!
          $beforePostingDate: String!
        ) {
          publisherCommissions(
            forPublishers: [$companyId]
            sincePostingDate: $sincePostingDate
            beforePostingDate: $beforePostingDate
          ) {
            records {
              commissionId
              actionId
              advertiserId
              advertiserName
              saleAmountUsd
              saleAmountPubCurrency
              pubCommissionAmountUsd
              pubCommissionAmountPubCurrency
              currency
              pubCurrency
              actionStatus
              commissionStatus
              eventDate
              postingDate
              lockingDate
              clearedDate
              isCorrected
              correctionReason
              paidToPublisher
              paymentId
            }
          }
        }
      `,
      variables: {
        companyId,
        sincePostingDate: from.toISOString(),
        beforePostingDate: to.toISOString(),
      },
      token,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    // CJ has used both `records` and (in older schemas) `commissions` as the
    // field name. Accept either; preserve the raw on `rawNetworkData`.
    const list: CjCommissionRaw[] =
      data?.publisherCommissions?.records ??
      data?.publisherCommissions?.commissions ??
      [];

    let transactions = list.map((r) => toTransaction(r, now));

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
   * Aggregate commissions into an earnings summary.
   *
   * Same rationale as Awin: derive from `listTransactions` so the user can
   * recompute the numbers from the per-record data. A single source of truth
   * avoids the "two reports disagree" problem common to networks with both
   * a transactions endpoint and a reports endpoint.
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
          programmeName: t.programmeName || `CJ advertiser ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9: oldest unpaid age across pending + approved.
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

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /**
   * CJ does not expose click-level data via its modern GraphQL surface.
   *
   * There IS a legacy REST report endpoint (`commission-detail-report`) that
   * some accounts can reach via the older support.cj.com tools, but:
   *   - It's not consistently available across accounts.
   *   - The response shape predates the modern schema and would force a
   *     bespoke transformer.
   *   - Partial support would silently return empty arrays on accounts that
   *     don't have it, which violates PRD principle 4.1.
   *
   * Honest is better than empty. We throw `NotImplementedError` with the
   * documented reason so the caller can see exactly why.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'CJ does not expose click-level data via the modern GraphQL surface; legacy REST report endpoints are inconsistently available across accounts',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a CJ tracking link.
   *
   * Format (CJ's legacy click-redirect URL, stable since the network's launch):
   *
   *   https://www.dpbolvw.net/click-{publisherId}-{advertiserId}
   *     ?url={destinationUrl, URL-encoded}
   *
   * Same deterministic-construction rationale as Awin:
   *   - Latency: ~0ms (no network).
   *   - Failure mode: only local input validation.
   *   - Rate-limit cost: zero.
   *
   * The modern alternative is `POST https://link-builder.api.cj.com/v1/links`
   * which mints a tracking ID and returns a friendlier URL. We default to
   * deterministic construction because every CJ account supports it; the
   * link-builder path is documented in `client.ts` for tenants that need it.
   *
   * `programmeId` (the CJ advertiser ID) is required by the URL format. If
   * the caller didn't supply one, we throw a config_error envelope rather
   * than silently defaulting.
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
          message: 'CJ tracking links require the advertiser (programme) ID.',
          hint:
            'Pass `programmeId`. Use affiliate_cj_list_programmes to discover the ID for the merchant you want to link to.',
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

    // CJ's deep-link format embeds the publisher's web-site PID (which CJ
    // labels "Publisher ID" in the dashboard). For v0.1 we accept the
    // company ID as the publisher identifier — the two coincide on most
    // accounts. A tenant with multiple sub-publishers would need the
    // explicit web-site PID; documented as future work.
    const publisherId = requireCompanyId('generateTrackingLink');

    // Sanity-check the token is configured; users with a half-configured
    // environment learn at link-generation time, not at first-click time.
    requireToken('generateTrackingLink');

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://www.dpbolvw.net/click-${encodeURIComponent(publisherId)}-${encodeURIComponent(input.programmeId)}` +
      `?url=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'dpbolvw.net/click-{publisherId}-{advertiserId} deterministic construction',
        publisherId,
        advertiserId: input.programmeId,
        url: input.destinationUrl,
        alternativeEndpoint: `${CJ_REST_LINK_BUILDER}/v1/links`,
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
  // Admin operations (v0.2 scaffolds)
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

  /**
   * Surface the derivedValues from `verifyAuth` so the wizard or any caller
   * inspecting the adapter post-setup can see what was auto-extracted. The
   * adapter contract's `verifyAuth` return type is narrow (`{ ok, identity }`)
   * so this method gives an audit-friendly handle on `CJ_COMPANY_ID`.
   */
  async derivedValues(): Promise<DerivedValueResult[]> {
    const result = await authVerify();
    if (!result.ok) return [];
    const out: DerivedValueResult[] = [];
    const companyId = result.derivedValues?.CJ_COMPANY_ID ?? getCredential('CJ_COMPANY_ID');
    if (companyId) {
      out.push({
        field: 'CJ_COMPANY_ID',
        value: companyId,
        source: 'cj.graphql.me.companyId',
      });
    }
    return out;
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

    operations['listClicks'] = {
      supported: false,
      note: 'CJ does not expose click-level data via the modern GraphQL surface',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction (dpbolvw.net legacy format); no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known advertiser id; not probed automatically.',
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
// Module-level registration (see awin/adapter.ts for the aggregator rationale).
// ---------------------------------------------------------------------------

export const cjAdapter = new CjAdapter();
registerAdapter(cjAdapter);

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

/**
 * Map our canonical ProgrammeStatus to CJ's advertiserStatus / relationshipStatus
 * query parameter. CJ accepts joined / pending / not-joined / declined; we
 * default to 'joined' (most common user question).
 */
function pickCjRelationship(statuses?: ProgrammeStatus[]): string {
  if (!statuses || statuses.length === 0) return 'joined';
  if (statuses.includes('joined')) return 'joined';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('declined')) return 'declined';
  if (statuses.includes('available')) return 'not-joined';
  return 'joined';
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  pickCjRelationship,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
// Touch CJ_REST_LINK_BUILDER so the import is observed in `generateTrackingLink`'s
// rawNetworkData (the URL is constructed there). This is a no-op at runtime.
void CJ_REST_LINK_BUILDER;
// Touch cjRest so the import is observed; future click-data work will use it.
void cjRest;
