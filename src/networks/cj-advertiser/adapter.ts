/**
 * CJ Affiliate advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. The GraphQL twin of the Impact advertiser REST adapter
 * (`src/networks/impact-advertiser/`): same chassis contract, same ctx
 * threading, same defensive transformer style. Read THAT adapter first; this
 * file documents only the CJ-specific decisions.
 *
 * --- Why this exists separately from `src/networks/cj/` --------------------
 *
 * The publisher CJ adapter at `src/networks/cj/` queries CJ from the
 * publisher's point of view (`publisherCommissions`, `advertisers` lookup).
 * The advertiser surface uses the SAME GraphQL endpoint (commissions.api.cj.com)
 * and the SAME PAT-based auth, but the queries are different
 * (`commissionDetails`, scoped via `forAdvertisers`). Sharing code with the
 * publisher adapter would mean either threading `side` enums through its
 * core, or having one adapter pretend to be both — both bad. A dedicated
 * advertiser adapter keeps the publisher adapter unchanged and makes the
 * brand-side stance (read-only, multi-brand, synthetic programmes) explicit.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listBrands             best-effort. CJ does NOT publish a clean "list
 *                          every CID this PAT can see" endpoint, so we throw
 *                          NotImplementedError with a clear hint to add
 *                          brands manually to `brands.json`. Documented in
 *                          per-network README + network.json.
 *   verifyAuth             reuses the auth.ts probe (cheap commissionDetails
 *                          query against a placeholder CID).
 *   listProgrammes         synthetic. CJ has no advertiser-programmes query;
 *                          we return one Programme per CID derived from
 *                          advertiserLookup metadata.
 *   listTransactions       commissionDetails → Transaction[]. Follows the
 *                          `sinceCommissionId` cursor while CJ reports
 *                          `payloadComplete: false`, so an absent `limit`
 *                          pulls the complete window (MAX_PAGES backstop,
 *                          warned on stderr, never silent).
 *   listMediaPartners      derived from a recent commissionDetails pull —
 *                          aggregate the distinct (publisherId, publisherName)
 *                          tuples over the complete window (same cursor
 *                          loop). Documented as a derived view.
 *   getProgrammePerformance computed client-side from commissionDetails:
 *                          group by (publisherId, day) over the complete
 *                          window (same cursor loop), aggregate clicks
 *                          (always 0 — commissionDetails has no click data,
 *                          documented as a gap), conversions, grossSale,
 *                          commission. USD-only currency.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `cjAdvGraphQL` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings.
 *   5. NEVER issue a `mutation` or `subscription`. The client enforces this;
 *      the adapter must not work around it.
 */

import { cjAdvGraphQL, CJ_ADVERTISER_GRAPHQL } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { COMMISSION_DETAILS_QUERY } from './queries.js';
import { requireCredential } from '../../shared/config.js';
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
  type MediaPartner,
  type MediaPartnerQuery,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
  type ProgrammeQuery,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('cj-advertiser.adapter');
const NAME = 'CJ Affiliate (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://commissions.api.cj.com',
  authModel: 'bearer',
  docsUrl: 'https://developers.cj.com/',
  adapterVersion: '0.2.0',
  lastVerified: '2026-05-23',
  claimStatus: 'experimental',
  knownLimitations: [
    'Read-only at v0.1. The GraphQL client refuses any operation that is not `query` (no mutations, no subscriptions); defence in depth against an accidentally introduced write.',
    '`listBrands` is not implemented: CJ does not publish a clean "list every CID this PAT can see" endpoint. Users must add brands manually to `brands.json` (see docs/networks/cj-advertiser.md).',
    '`listProgrammes` is synthetic: CJ has no advertiser-programmes query, so the adapter returns one Programme per CID resolved from the call context.',
    '`getProgrammePerformance` is computed client-side from `commissionDetails`. Clicks are NOT available from `commissionDetails` and are reported as 0 (TODO(verify): legacy REST report endpoints may surface clicks for some accounts).',
    'Status mapping for performance rows uses CJ `actionStatus`: EXTENDED / LOCKED → pending, CLOSED → approved, CORRECTED / REVERSED → reversed. The CLOSED semantics are TODO(verify) against a live tenant.',
    'All amounts use CJ\'s USD-normalised fields (`saleAmountUsd`, `commissionAmountUsd`); rows are emitted with `currency: USD` regardless of the brand\'s settlement currency.',
    '`commissionDetails` is paginated via the `sinceCommissionId` cursor: when no `limit` is supplied the adapter follows `payloadComplete` to completion, capped at MAX_PAGES (10 pages of up to 10,000 rows) with a stderr warning rather than a silent truncation.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 8,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // commissionDetails powers listTransactions, listMediaPartners, and
  // getProgrammePerformance — wider date windows can take a while, so we give
  // these ops more budget. Same rationale as the publisher adapter's
  // listTransactions config.
  listTransactions: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  listMediaPartners: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
};

// ---------------------------------------------------------------------------
// Helpers — ctx, status mapping, raw shapes
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `CJ advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the CJ CID) via brands.json. Call `affiliate_resolve_brand` to see ' +
          'which brands are bound.',
      }),
    );
  }
  return ctx;
}

function requireToken(operation: string): string {
  return requireCredential('CJ_ADVERTISER_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Generate a Personal Access Token at the CJ dashboard → Account → Personal Access Tokens. ' +
      'The same PAT works for both the publisher and advertiser surfaces.',
  });
}

// CJ commission row shape — minimal, defensive. We read only what we use.
interface CjAdvCommissionRaw {
  commissionId?: string;
  advertiserId?: string | number;
  advertiserName?: string;
  publisherId?: string | number;
  publisherName?: string;
  postingDate?: string;
  eventDate?: string;
  actionStatus?: string;
  actionType?: string;
  saleAmountUsd?: string | number;
  commissionAmountUsd?: string | number;
  items?: Array<{
    quantity?: number;
    totalCommissionUsd?: string | number;
    perItemSaleAmountUsd?: string | number;
  }>;
}

interface CjAdvCommissionDetailsEnvelope {
  commissionDetails?: {
    payloadComplete?: boolean;
    count?: number;
    records?: CjAdvCommissionRaw[];
  };
}

// ---------------------------------------------------------------------------
// Pagination — sinceCommissionId cursor loop over commissionDetails
// ---------------------------------------------------------------------------

/** CJ's documented per-page ceiling for `maxRows` on `commissionDetails`. */
const PAGE_MAX_ROWS = 10_000;

/**
 * Backstop on the cursor loop: 10 pages of up to 10,000 rows (100,000 rows)
 * per pull. Hitting the cap logs a stderr warning so a truncated result is
 * never silent (principle 4.1) — same pattern as the tolt adapter.
 */
const MAX_PAGES = 10;

/**
 * Fetch commissionDetails rows for one CID, following CJ's cursor pagination
 * to completion.
 *
 * CJ's commission-detail GraphQL contract: each page reports
 * `payloadComplete`. While it is `false`, re-issue the same query (same date
 * window) with `sinceCommissionId` set to the last record's `commissionId` to
 * receive the next batch. `maxRows` caps a single page at 10,000.
 *
 * When `limit` is present we stop as soon as `limit` rows are collected —
 * backward-compatible with the pre-pagination behaviour where `limit` passed
 * straight through as `maxRows` (never fewer rows than before). When `limit`
 * is absent we pull the complete window, capped at MAX_PAGES with a stderr
 * warning.
 */
async function fetchCommissionRecords(input: {
  operation: 'listTransactions' | 'listMediaPartners' | 'getProgrammePerformance';
  cid: string;
  from: Date;
  to: Date;
  token: string;
  resilience: ResilienceConfig;
  limit?: number;
}): Promise<CjAdvCommissionRaw[]> {
  const target = typeof input.limit === 'number' ? Math.max(1, input.limit) : undefined;
  const out: CjAdvCommissionRaw[] = [];
  let sinceCommissionId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const maxRows =
      target === undefined ? PAGE_MAX_ROWS : Math.min(target - out.length, PAGE_MAX_ROWS);
    const variables: Record<string, unknown> = {
      forAdvertisers: [input.cid],
      sincePostingDate: input.from.toISOString(),
      beforePostingDate: input.to.toISOString(),
      maxRows,
    };
    if (sinceCommissionId !== undefined) variables['sinceCommissionId'] = sinceCommissionId;

    const data = await cjAdvGraphQL<CjAdvCommissionDetailsEnvelope>({
      operation: input.operation,
      endpoint: CJ_ADVERTISER_GRAPHQL,
      query: COMMISSION_DETAILS_QUERY,
      variables,
      token: input.token,
      resilience: input.resilience,
    });

    const envelope = data?.commissionDetails;
    const batch = envelope?.records ?? [];
    out.push(...batch);

    if (target !== undefined && out.length >= target) return out.slice(0, target);
    // `payloadComplete === false` is CJ's explicit "more rows remain" signal.
    // `true` or absent both mean the window is exhausted — absent is treated
    // as complete so a schema drift cannot cause an infinite loop.
    if (envelope?.payloadComplete !== false) return out;
    // Defensive: an incomplete claim with no rows offers no cursor to advance
    // from; stop rather than re-issue an identical query forever.
    if (batch.length === 0) return out;
    const lastId = batch[batch.length - 1]?.commissionId;
    if (lastId === undefined || String(lastId) === '') return out;
    sinceCommissionId = String(lastId);
  }

  log.warn(
    { operation: input.operation, cap: MAX_PAGES, fetched: out.length },
    'cj-advertiser commissionDetails pagination hit MAX_PAGES cap; result may be truncated',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map CJ's `actionStatus` to canonical `TransactionStatus`.
 *
 * CJ's brand-side action vocabulary:
 *   - EXTENDED / LOCKED → 'pending' (advertiser has not yet finalised)
 *     `// TODO(verify): on the brand side LOCKED may mean "approved by
 *     advertiser" rather than "approved by CJ". The publisher adapter maps
 *     LOCKED → approved; for advertiser symmetry we follow the user-side
 *     reading "still pending finalisation" because the brand decides when
 *     payment posts.`
 *   - CLOSED → 'approved' (locked + paid out from the brand's perspective)
 *     `// TODO(verify): CJ docs use CLOSED in multiple senses; confirm.`
 *   - CORRECTED / REVERSED → 'reversed'
 *   - Anything else → 'other'.
 */
function mapTransactionStatus(raw: CjAdvCommissionRaw): TransactionStatus {
  const s = String(raw.actionStatus ?? '').toUpperCase();
  switch (s) {
    case 'EXTENDED':
    case 'LOCKED':
    case 'NEW':
      return 'pending';
    case 'CLOSED':
      // TODO(verify): CJ's CLOSED on the advertiser side typically means
      // "locked and paid out". We map to 'approved' here (the report layer
      // re-maps to a 3-value scale separately).
      return 'approved';
    case 'CORRECTED':
    case 'REVERSED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Map CJ's `actionStatus` to the 3-value `ProgrammePerformanceRow` status.
 *
 *   EXTENDED / LOCKED / NEW → 'pending'
 *   CLOSED → 'approved'
 *   CORRECTED / REVERSED → 'reversed'
 */
function mapPerformanceStatus(raw: CjAdvCommissionRaw): ProgrammePerformanceRow['status'] {
  const s = String(raw.actionStatus ?? '').toUpperCase();
  if (s === 'CORRECTED' || s === 'REVERSED') return 'reversed';
  if (s === 'CLOSED') return 'approved';
  return 'pending';
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseCjDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  let candidate = input.trim();
  if (candidate === '') return undefined;
  // CJ returns ISO 8601 strings; tolerate missing Z by appending UTC.
  if (!/[Zz]$/.test(candidate) && !/[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

function computeAgeDays(raw: CjAdvCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.postingDate ?? raw.eventDate;
  const parsed = parseCjDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toTransaction(raw: CjAdvCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.commissionAmountUsd);
  const sale = toNumber(raw.saleAmountUsd);

  const eventDate = parseCjDate(raw.eventDate) ?? new Date(0).toISOString();
  const postingDate = parseCjDate(raw.postingDate);

  return {
    id: String(raw.commissionId ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiserId ?? ''),
    programmeName: raw.advertiserName ?? '',
    status,
    amount: sale,
    currency: 'USD',
    commission,
    dateClicked: undefined,
    dateConverted: eventDate,
    // CJ does not publish a separate approved-date on commissionDetails; the
    // posting date is the closest analogue.
    dateApproved: postingDate,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

function toMediaPartner(
  publisherId: string,
  publisherName: string,
  rawRecords: CjAdvCommissionRaw[],
): MediaPartner {
  return {
    id: publisherId,
    name: publisherName || `CJ publisher ${publisherId}`,
    // commissionDetails does not surface a per-publisher status — derive
    // 'active' for any publisher that has at least one row in the window,
    // 'unknown' otherwise. We never fabricate `inactive`/`pending`.
    status: rawRecords.length > 0 ? 'active' : 'unknown',
    rawNetworkData: {
      derivedFrom: 'commissionDetails aggregation',
      rowCount: rawRecords.length,
      sample: rawRecords[0] ?? null,
    },
  };
}

function toPerformanceRow(
  date: string,
  publisherId: string,
  publisherName: string,
  rows: CjAdvCommissionRaw[],
): ProgrammePerformanceRow {
  let conversions = 0;
  let grossSale = 0;
  let commission = 0;
  // Choose the worst (most reversed-ish) status across the bucket as the
  // overall status — a partially-reversed day is still "reversed news" worth
  // surfacing. Order: reversed > pending > approved.
  let status: ProgrammePerformanceRow['status'] = 'approved';
  for (const r of rows) {
    conversions += 1;
    grossSale += toNumber(r.saleAmountUsd);
    commission += toNumber(r.commissionAmountUsd);
    const s = mapPerformanceStatus(r);
    if (s === 'reversed') status = 'reversed';
    else if (s === 'pending' && status !== 'reversed') status = 'pending';
  }
  return {
    date,
    publisherId,
    publisherName: publisherName || `CJ publisher ${publisherId}`,
    // commissionDetails carries no click data; documented gap.
    clicks: 0,
    conversions,
    grossSale,
    commission,
    currency: 'USD',
    status,
    rawNetworkData: {
      derivedFrom: 'commissionDetails aggregation (per-publisher per-day bucket)',
      rowCount: rows.length,
      sample: rows[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CjAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — NOT implemented; CJ has no clean enumeration endpoint.
  // -------------------------------------------------------------------------

  /**
   * CJ does NOT publish a clean "list every CID this PAT can see" GraphQL
   * query. The conventional viewer/me/currentUser names are unverified
   * against the brand-side schema, and `advertiserLookup` requires already
   * knowing the CIDs. The legacy "Advertiser Lookup REST API" is publisher-
   * oriented and reports the advertisers a publisher has joined, not the
   * brands an agency PAT can administer.
   *
   * Honest gap: throw NotImplementedError with a clear instruction. The
   * per-network README walks the user through adding entries to
   * `brands.json` by hand. Better than fake endpoints.
   *
   * TODO(verify): if CJ exposes a viewer-like query on a live tenant, prefer
   * that over throwing here.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    throw new NotImplementedError(
      'CJ advertiser brand discovery is not automated: CJ does not publish a clean ' +
        'enumeration endpoint for the CIDs a PAT can address. Add brands manually to ' +
        '~/.affiliate-mcp/brands.json with network=cj-advertiser and the networkBrandId ' +
        'set to the CID. See docs/networks/cj-advertiser.md.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth — cheap GraphQL probe.
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) {
      return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — synthetic, one Programme per CID.
  // -------------------------------------------------------------------------

  /**
   * CJ has no advertiser-programmes query that returns the brand's own
   * programme metadata. We synthesise: one Programme entry whose `id` is the
   * caller's CID and whose `name` is best-effort.
   *
   * Why we don't issue an `advertiserLookup` here:
   *   - `advertiserLookup` requires a `requestorCid` argument (the agency's
   *     own CID) on most tenants — we don't have that data.
   *   - A live verifyAuth confirms the PAT works against the CID; the human-
   *     readable name lives on `brands.json` (`displayName` of the binding).
   *
   * TODO(verify): on tenants where `advertiserLookup(advertiserIds, requestorCid)`
   * works without a separate requestor CID we should issue it here to
   * populate `name` and `currency` from real data.
   */
  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    // Ensure the PAT is configured even though we don't issue a request: a
    // user with no token gets a clear config_error rather than an empty list.
    requireToken('listProgrammes');

    const programme: Programme = {
      id: c.networkBrandId,
      name: `CJ advertiser ${c.networkBrandId}`,
      network: SLUG,
      status: 'joined',
      currency: 'USD',
      rawNetworkData: {
        derivedFrom: 'synthetic per-CID Programme (CJ has no advertiser-programmes query)',
        cid: c.networkBrandId,
      },
    };

    let programmes: Programme[] = [programme];
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — commissionDetails for one CID.
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // With a `limit`, stop as soon as that many rows are collected (the old
    // single-page behaviour, never fewer rows). Without one, follow the
    // cursor to the complete window.
    const records = await fetchCommissionRecords({
      operation: 'listTransactions',
      cid: c.networkBrandId,
      from,
      to,
      token,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      limit: query?.limit,
    });
    let transactions = records.map((r) => toTransaction(r, now));

    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
    if (typeof query?.minAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);

    return transactions;
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — derived from a recent commissionDetails pull.
  // -------------------------------------------------------------------------

  /**
   * Aggregate the distinct (publisherId, publisherName) tuples from a recent
   * commissionDetails pull. This is a DERIVED view, not a dedicated endpoint
   * — documented in `network.json.known_limitations` and reflected on the
   * `rawNetworkData` of each MediaPartner so the operator can drill in.
   */
  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const c = requireCtx('listMediaPartners', ctx);
    const token = requireToken('listMediaPartners');

    // Default to a 30-day rolling window for the derivation. The user can
    // widen via the standard transactional date window if they discover a
    // partner that hasn't transacted recently.
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // The derivation aggregates over the COMPLETE window — `query.limit`
    // bounds the derived partner list, not the upstream row pull, so no
    // limit is passed to the cursor loop.
    const records = await fetchCommissionRecords({
      operation: 'listMediaPartners',
      cid: c.networkBrandId,
      from,
      to: now,
      token,
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });
    const byPublisher = new Map<string, { name: string; rows: CjAdvCommissionRaw[] }>();
    for (const r of records) {
      const id = String(r.publisherId ?? '');
      if (!id) continue;
      const existing = byPublisher.get(id);
      if (existing) {
        existing.rows.push(r);
        if (!existing.name && r.publisherName) existing.name = r.publisherName;
      } else {
        byPublisher.set(id, { name: r.publisherName ?? '', rows: [r] });
      }
    }

    let partners: MediaPartner[] = [...byPublisher.entries()].map(([id, agg]) =>
      toMediaPartner(id, agg.name, agg.rows),
    );

    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toMediaPartnerStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') partners = partners.slice(0, query.limit);
    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — client-side aggregation.
  // -------------------------------------------------------------------------

  /**
   * Pull `commissionDetails` for the window and group by (publisherId, day).
   * Aggregate clicks (always 0), conversions, grossSale, commission. Status
   * is the worst-news of the bucket.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const token = requireToken('getProgrammePerformance');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // The aggregation needs the COMPLETE window — `query.limit` bounds the
    // derived performance rows, not the upstream row pull, so no limit is
    // passed to the cursor loop.
    const records = await fetchCommissionRecords({
      operation: 'getProgrammePerformance',
      cid: c.networkBrandId,
      from,
      to,
      token,
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    // Bucket by (publisherId, day). Day comes from postingDate where present,
    // falling back to eventDate.
    interface Bucket {
      date: string;
      publisherId: string;
      publisherName: string;
      rows: CjAdvCommissionRaw[];
    }
    const buckets = new Map<string, Bucket>();
    for (const r of records) {
      const publisherId = String(r.publisherId ?? '');
      if (!publisherId) continue;
      if (query?.publisherId && publisherId !== query.publisherId) continue;

      const iso = parseCjDate(r.postingDate ?? r.eventDate);
      const date = iso ? iso.slice(0, 10) : '';
      const key = `${publisherId}|${date}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.rows.push(r);
        if (!existing.publisherName && r.publisherName) existing.publisherName = r.publisherName;
      } else {
        buckets.set(key, {
          date,
          publisherId,
          publisherName: r.publisherName ?? '',
          rows: [r],
        });
      }
    }

    let rows: ProgrammePerformanceRow[] = [...buckets.values()].map((b) =>
      toPerformanceRow(b.date, b.publisherId, b.publisherName, b.rows),
    );

    // Stable order: by date ascending then publisherId.
    rows.sort((a, b) => (a.date === b.date ? a.publisherId.localeCompare(b.publisherId) : a.date.localeCompare(b.date)));

    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops not implemented at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'CJ advertiser adapter does not implement getProgramme at v0.1; programmes are synthetic, use listProgrammes.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'CJ advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'CJ advertiser adapter does not implement listClicks; commissionDetails does not surface click-level data.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'CJ advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for CJ advertiser at v0.1.');
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
      note: 'commissionDetails probe; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: false,
      note: 'CJ has no clean enumeration endpoint; users must add brands manually to brands.json. Throws NotImplementedError.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Synthetic per-CID Programme (CJ has no advertiser-programmes query).',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'commissionDetails query. Status mapping (CLOSED → approved, LOCKED → pending, etc.) is `// TODO(verify)` against a live tenant.',
      claimStatus: 'partial',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'Derived from commissionDetails aggregation, not a dedicated endpoint.',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Client-side aggregation from commissionDetails; clicks always 0 (gap). CLOSED status semantics `// TODO(verify)` against a live tenant.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = {
      supported: false,
      note: 'commissionDetails does not surface click-level data.',
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

export const cjAdvertiserAdapter = new CjAdvertiserAdapter();
registerAdapter(cjAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toMediaPartnerStatusList(
  v?: MediaPartner['status'] | Array<MediaPartner['status']>,
): Array<MediaPartner['status']> | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export const _internals = {
  mapTransactionStatus,
  mapPerformanceStatus,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  parseCjDate,
  computeAgeDays,
  fetchCommissionRecords,
  MAX_PAGES,
  PAGE_MAX_ROWS,
  log,
};
