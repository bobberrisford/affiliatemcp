/**
 * Scaleo adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and closely mirrors `src/networks/everflow/adapter.ts` (api-key auth,
 * publisher side). Read those files before modifying this one.
 *
 * --- What Scaleo is ---------------------------------------------------------
 *
 * Scaleo is a tenant affiliate-platform engine: a single parameterised API
 * shape powers many independently-operated networks. Two things are therefore
 * CREDENTIALS rather than constants:
 *
 *   - Base URL: the network's own tracking URL / domain (SCALEO_BASE_URL),
 *     e.g. https://sandbox.scaletrk.com. There is no shared API host.
 *   - API key: the affiliate key (SCALEO_API_KEY), sent as the `api-key`
 *     query parameter on every request (NOT an Authorization header).
 *
 * --- API overview (confirmed 2026-06-05) -----------------------------------
 *
 * Auth:    `?api-key=<key>` query parameter (custom).
 * Base:    per-tenant tracking URL via SCALEO_BASE_URL.
 * Prefix:  /api/v2/affiliate/...
 * Docs:    https://developers.scaleo.io/
 *
 * --- Endpoint map -----------------------------------------------------------
 *
 *   GET  /api/v2/affiliate/offers
 *     → list of offers; params search, countries, categories, onlyFeatured,
 *       page, perPage. Paginated.
 *   GET  /api/v2/affiliate/offers/{id}
 *     → single offer detail.
 *   GET  /api/v2/affiliate/reports/conversions
 *     → conversions report; params rangeFrom, rangeTo, columns, page, perPage.
 *   GET  /api/v2/affiliate/reports/clicks
 *     → clicks report; params rangeFrom, rangeTo, columns, page, perPage.
 *
 * Endpoint paths confirmed via the community PHP client
 * (github.com/jakuborava/scaleo-io-client) and the developers.scaleo.io
 * request format. Exact response field names were NOT confirmable from the
 * public docs without a live tenant; the transformers below read the field
 * names Scaleo's help docs describe (payout, revenue, currency, status) with
 * defensive fallbacks, and preserve the verbatim payload on `rawNetworkData`.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `scaleoRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to canonical set. Prefer `unknown`/`other` over
 *      a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live Scaleo tenant. Response field names carry defensive fallbacks.
 *   - listProgrammes walks the offers pagination (page / perPage) to
 *     completion when the caller sets no limit, capped at MAX_PAGES with a
 *     logged warning rather than a silent truncation.
 *   - The base API host is per-tenant (the network's tracking URL) and must be
 *     supplied via SCALEO_BASE_URL — there is no shared host.
 *   - Affiliate API access is enabled per user by the platform administrator,
 *     not self-service.
 *   - Monetary amounts are assumed to be major currency units (the value of
 *     `payout` / `revenue` in `currency`); confirm against a live tenant.
 *   - generateTrackingLink is not implemented: a Scaleo click link
 *     (`/click?o={offer}&a={affiliate}`) requires the affiliate id, which is
 *     not among the configured credentials. Use the per-offer tracking link
 *     surfaced on a programme's rawNetworkData instead.
 */

import { scaleoRequest, requireBaseUrl, requireApiKey } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
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

const log = createLogger('scaleo.adapter');

const SLUG = 'scaleo';
const NAME = 'Scaleo';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Placeholder host: the REAL base is the per-tenant tracking URL supplied via
  // SCALEO_BASE_URL. This value is never used for requests — see client.ts.
  baseUrl: 'https://api.scaleo.io',
  // Scaleo authenticates with an `api-key` query parameter, not a standard
  // header scheme → 'custom'.
  authModel: 'custom',
  docsUrl: 'https://developers.scaleo.io/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live tenant.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The base API host is per-tenant (the network\'s tracking URL) and must be supplied via SCALEO_BASE_URL; there is no shared host.',
    'listProgrammes walks the offers pagination (page / perPage) to completion when no limit is set, capped at MAX_PAGES with a logged warning rather than a silent truncation.',
    'Monetary amounts are assumed to be major currency units in the reported currency; confirm against a live tenant.',
    'Affiliate API access is enabled per user by the platform administrator, not self-service.',
    'generateTrackingLink is not implemented: Scaleo click links require the affiliate id, which is not among the configured credentials.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // Access gated: the affiliate cannot self-enable API access — the admin must.
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 1,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Conversion / click reports can be slow over wide windows. Give them a 60s
 * timeout and 3 retries, matching the Awin / Everflow reporting profile.
 */
const REPORTING_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTING_RESILIENCE,
  getEarningsSummary: REPORTING_RESILIENCE,
  listClicks: REPORTING_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Scaleo raw response shapes (deliberately minimal — see Awin adapter rationale)
// ---------------------------------------------------------------------------

/** Minimal shape of one offer record from GET /affiliate/offers. */
interface ScaleoOfferRaw {
  id?: number | string;
  name?: string;
  // Offer status / the affiliate's approval status for the offer. Scaleo offers
  // can be public, private/approval-required, etc. Field name not confirmed
  // against a live tenant; we read `status` then `approval_status` defensively.
  status?: string;
  approval_status?: string;
  currency?: string;
  // Payout shown on the offer (commission to the affiliate).
  payout?: number | string;
  payout_type?: string; // e.g. "CPA", "CPS", "RevShare"
  categories?: Array<string | { name?: string }>;
  category?: string;
  // Deterministic per-offer tracking link, when surfaced by the API.
  tracking_link?: string;
  preview_url?: string;
  url?: string;
}

/** Minimal shape of one conversions-report row from GET /affiliate/reports/conversions. */
interface ScaleoConversionRaw {
  // Identifier fields vary by tenant config; read several defensively.
  conversion_id?: string | number;
  id?: string | number;
  transaction_id?: string | number;
  offer_id?: string | number;
  offer_name?: string;
  // Status string: approved | pending | declined | rejected | hold | trash | ...
  status?: string;
  // Monetary fields. `payout` = commission to the affiliate;
  // `revenue` = what the advertiser pays. We use payout as the commission.
  payout?: number | string;
  revenue?: number | string;
  amount?: number | string; // sale / order amount where exposed
  sale_amount?: number | string;
  currency?: string;
  // Timestamps. Scaleo reports use date-time strings; field names vary, so we
  // read several. `conversion_date` is the recorded-at anchor for ageing.
  conversion_date?: string;
  date?: string;
  datetime?: string;
  click_date?: string;
  // Reversal / decline context where exposed.
  decline_reason?: string;
  status_reason?: string;
}

/** Minimal shape of one clicks-report row from GET /affiliate/reports/clicks. */
interface ScaleoClickRaw {
  click_id?: string | number;
  id?: string | number;
  offer_id?: string | number;
  // Timestamp string; field name varies, read several.
  click_date?: string;
  date?: string;
  datetime?: string;
  referer?: string;
  referrer?: string;
  landing_url?: string;
  url?: string;
}

/**
 * Scaleo reports are paginated and typically wrap rows in a `data` array with a
 * `meta`/`pagination` block. Field names are read defensively: `data`, then
 * `conversions` / `clicks` / `offers`, then a bare array fallback handled by
 * the extract helpers below.
 */
interface ScaleoEnvelope<Row> {
  data?: Row[];
  offers?: Row[];
  conversions?: Row[];
  clicks?: Row[];
  meta?: { total?: number; page?: number; perPage?: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function extractRows<Row>(env: ScaleoEnvelope<Row> | Row[] | undefined): Row[] {
  if (Array.isArray(env)) return env;
  if (!env) return [];
  return env.data ?? env.offers ?? env.conversions ?? env.clicks ?? [];
}

/**
 * Status normalisation: Scaleo offer / approval status → canonical ProgrammeStatus.
 *
 * Scaleo offers carry an approval relationship for the affiliate. Confirmed
 * status vocabulary from the help docs is approval-oriented
 * (approved / pending / rejected) with offer-level active/paused states.
 * We prefer the affiliate's approval status when present, then the offer status.
 *   approved / active   → 'joined' (approval) / 'available' (offer-level)
 *   pending / on review → 'pending'
 *   rejected / declined → 'declined'
 *   paused / inactive   → 'suspended'
 *   anything else       → 'unknown'
 */
function mapProgrammeStatus(raw: ScaleoOfferRaw): ProgrammeStatus {
  const approval = (raw.approval_status ?? '').toLowerCase();
  if (approval) {
    if (approval === 'approved' || approval === 'active') return 'joined';
    if (approval === 'pending' || approval === 'on_review' || approval === 'review') return 'pending';
    if (approval === 'rejected' || approval === 'declined') return 'declined';
    if (approval === 'paused' || approval === 'inactive' || approval === 'suspended') return 'suspended';
    return 'unknown';
  }
  const status = (raw.status ?? '').toLowerCase();
  if (status === 'active' || status === 'public' || status === 'available') return 'available';
  if (status === 'approved') return 'joined';
  if (status === 'pending') return 'pending';
  if (status === 'rejected' || status === 'declined') return 'declined';
  if (status === 'paused' || status === 'inactive' || status === 'stopped') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: Scaleo conversion status → canonical TransactionStatus.
 *
 * Scaleo's documented status buckets (help.scaleo.io conversions report; the
 * status-mapping params approved_status / pending_status / rejected_status /
 * trash_status) are:
 *   approved / success           → 'approved'
 *   pending / processing / hold   → 'pending' (hold is a delayed-approval bucket)
 *   declined / rejected / decline → 'reversed'
 *   trash / spam                  → 'reversed' (invalidated)
 *   paid                          → 'paid'
 *   anything else                 → 'other'
 */
function mapTransactionStatus(raw: ScaleoConversionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'approved' || s === 'success' || s === 'confirmed') return 'approved';
  if (s === 'pending' || s === 'processing' || s === 'hold' || s === 'on_hold') return 'pending';
  if (s === 'paid') return 'paid';
  if (s === 'declined' || s === 'rejected' || s === 'decline' || s === 'trash' || s === 'spam' || s === 'reversed') {
    return 'reversed';
  }
  return 'other';
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age in days of a transaction relative to `now`.
 *
 * Anchored on the conversion date (when the conversion was recorded). Scaleo
 * does not document a separate validation/approval timestamp in the affiliate
 * report, so the conversion date is the only available anchor — mirroring
 * Everflow's approach. Reads `conversion_date`, then `date`/`datetime`.
 */
function computeAgeDays(raw: ScaleoConversionRaw, now: Date = new Date()): number {
  const anchor = raw.conversion_date ?? raw.date ?? raw.datetime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ScaleoOfferRaw): Programme {
  const id = String(raw.id ?? '');
  const categories = (raw.categories ?? [])
    .map((c) => (typeof c === 'string' ? c : c.name))
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (raw.category) categories.push(raw.category);

  const payout = raw.payout !== undefined ? asNumber(raw.payout) : undefined;

  return {
    id,
    name: raw.name ?? `Scaleo offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? undefined,
    commissionRate:
      payout !== undefined
        ? {
            // RevShare / CPS are percentage-style; everything else treated as flat.
            type:
              (raw.payout_type ?? '').toLowerCase().includes('rev') ||
              (raw.payout_type ?? '').toLowerCase() === 'cps'
                ? 'percent'
                : 'flat',
            value: payout,
            description: raw.payout_type ? `${raw.payout_type} ${payout}` : String(payout),
          }
        : undefined,
    categories,
    advertiserUrl: raw.preview_url ?? raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ScaleoConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = asNumber(raw.payout);
  // Sale / order amount: prefer an explicit amount/sale field, then revenue.
  const amount =
    raw.amount !== undefined
      ? asNumber(raw.amount)
      : raw.sale_amount !== undefined
        ? asNumber(raw.sale_amount)
        : asNumber(raw.revenue);
  const offerId = String(raw.offer_id ?? '');
  const dateConverted =
    nullableIso(raw.conversion_date ?? raw.date ?? raw.datetime) ?? new Date(0).toISOString();

  return {
    id: String(raw.conversion_id ?? raw.id ?? raw.transaction_id ?? ''),
    network: SLUG,
    programmeId: offerId,
    programmeName: raw.offer_name ?? `Scaleo offer ${offerId}`,
    status,
    amount,
    currency: raw.currency ?? 'USD',
    commission,
    dateClicked: nullableIso(raw.click_date),
    dateConverted,
    // Scaleo does not document a distinct approval-date field on the affiliate
    // conversions report; use the conversion date as a best-effort proxy for
    // approved rows until confirmed against a live tenant.
    dateApproved: status === 'approved' ? dateConverted : undefined,
    datePaid: status === 'paid' ? dateConverted : undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? (raw.decline_reason ?? raw.status_reason ?? undefined) : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: ScaleoClickRaw): Click {
  const offerId = String(raw.offer_id ?? '');
  const ts = nullableIso(raw.click_date ?? raw.date ?? raw.datetime) ?? new Date(0).toISOString();
  return {
    id: String(raw.click_id ?? raw.id ?? ''),
    network: SLUG,
    programmeId: offerId || undefined,
    timestamp: ts,
    referrer: raw.referer ?? raw.referrer,
    destinationUrl: raw.landing_url ?? raw.url,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date / pagination helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date for Scaleo's `rangeFrom` / `rangeTo` parameters as
 * `YYYY-MM-DD HH:mm:SS` in UTC. Scaleo reports accept date-time range bounds;
 * the exact accepted format is not confirmed against a live tenant, so we send
 * the widely-accepted `YYYY-MM-DD HH:mm:SS` form.
 */
function formatScaleoDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Scaleo does not document a
 * per-call window cap on the affiliate reports; we keep this helper (mirroring
 * Everflow) and chunk wide ranges defensively to avoid timeouts on large
 * tenants. Mirrors Awin's `chunkDateRange`.
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

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// Wide windows are chunked into 90-day slices defensively.
const REPORT_CHUNK_DAYS = 90;

// Offers pagination (page / perPage): the page size for full pulls, and a hard
// backstop on the page walk so a tenant that ignores the page parameter cannot
// loop forever. Hitting the cap is logged, never silent — mirrors the
// Tolt / Tapfiliate MAX_PAGES pattern. 50 pages × 100 offers = 5,000 offers,
// plenty for the workflows this serves.
const OFFERS_PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ScaleoAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Scaleo offers visible to this affiliate.
   *
   * Endpoint: GET /affiliate/offers (page / perPage pagination).
   *
   * Pagination: when the caller sets no `limit`, the 1-based `page` parameter
   * is walked to completion — continuing while `meta.total` says more rows
   * exist or, when no total is returned, while pages come back full — capped
   * at MAX_PAGES with a logged warning so a truncated pull is never silent.
   * When `limit` is set, the walk stops as soon as enough rows are fetched.
   *
   * Server-side `search` is supported; status / category filters are applied
   * client-side for consistency with the other adapters.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const baseUrl = requireBaseUrl('listProgrammes');
    const apiKey = requireApiKey('listProgrammes');
    const limit = query?.limit;
    const perPage = typeof limit === 'number' ? Math.min(limit, 500) : OFFERS_PAGE_SIZE;

    const rows: ScaleoOfferRaw[] = [];
    let capped = true;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await scaleoRequest<ScaleoEnvelope<ScaleoOfferRaw>>({
        operation: 'listProgrammes',
        path: '/offers',
        baseUrl,
        apiKey,
        query: {
          page,
          perPage,
          search: query?.search,
        },
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      });

      const batch = extractRows(envelope);
      rows.push(...batch);

      // Stop conditions, in order:
      //   1. the caller's limit is satisfied (backward-compatible short-circuit);
      //   2. an empty page — nothing further to fetch;
      //   3. `meta.total` reported and reached (trusted even when the tenant
      //      caps perPage below what we requested);
      //   4. no total reported and the page came back short — defensive stop
      //      so a tenant that ignores paging never re-fetches the same rows.
      const total = Array.isArray(envelope) ? undefined : envelope.meta?.total;
      if (
        (typeof limit === 'number' && rows.length >= limit) ||
        batch.length === 0 ||
        (typeof total === 'number' && rows.length >= total) ||
        (typeof total !== 'number' && batch.length < perPage)
      ) {
        capped = false;
        break;
      }
    }
    if (capped) {
      log.warn(
        { operation: 'listProgrammes', cap: MAX_PAGES, fetched: rows.length },
        'scaleo pagination hit MAX_PAGES cap; result may be truncated',
      );
    }

    let programmes = rows.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.advertiserUrl ?? '').toLowerCase().includes(needle),
      );
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
   * Fetch a single Scaleo offer by ID.
   *
   * Endpoint: GET /affiliate/offers/{id}. The response may be flat or wrapped
   * in a `data` object; we read both.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Scaleo offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_scaleo_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const baseUrl = requireBaseUrl('getProgramme');
    const apiKey = requireApiKey('getProgramme');

    const raw = await scaleoRequest<ScaleoOfferRaw | { data?: ScaleoOfferRaw }>({
      operation: 'getProgramme',
      path: `/offers/${programmeId}`,
      baseUrl,
      apiKey,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const offer = (raw as { data?: ScaleoOfferRaw }).data ?? (raw as ScaleoOfferRaw);
    return toProgramme(offer ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversions via the Scaleo affiliate conversions report.
   *
   * Endpoint: GET /affiliate/reports/conversions
   *   params: rangeFrom, rangeTo, page, perPage.
   * Date window default: last 30 days. Wide windows are chunked into 90-day
   * slices defensively (Scaleo documents no hard per-call cap).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const baseUrl = requireBaseUrl('listTransactions');
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, REPORT_CHUNK_DAYS);
    const all: Transaction[] = [];

    for (const slice of slices) {
      const envelope = await scaleoRequest<ScaleoEnvelope<ScaleoConversionRaw>>({
        operation: 'listTransactions',
        path: '/reports/conversions',
        baseUrl,
        apiKey,
        query: {
          rangeFrom: formatScaleoDate(slice.start),
          rangeTo: formatScaleoDate(slice.end),
          page: 1,
          perPage: 1000,
          // Offer scoping where supported; harmless if ignored by the tenant.
          offer_id: query?.programmeId,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      all.push(...extractRows(envelope).map((r) => toTransaction(r, now)));
    }

    let transactions = all;

    // Programme filter (client-side belt-and-braces in case offer_id is ignored).
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9. Applied AFTER status filtering.
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
   * Aggregate the conversions report into an earnings summary.
   *
   * Derived from `listTransactions` (not a separate report endpoint) so the
   * user can reproduce the summary from the transactions they see, and so the
   * per-transaction `ageDays` is available for `oldestUnpaidAgeDays`. Same
   * rationale as Awin / Everflow.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // never apply a limit inside a summary — would undercount
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
          programmeName: t.programmeName || `Scaleo offer ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved).
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
   * List click-level data via the Scaleo affiliate clicks report.
   *
   * Endpoint: GET /affiliate/reports/clicks (rangeFrom / rangeTo / page / perPage).
   * Unlike Awin / CJ, Scaleo exposes a raw clicks report to affiliates. Wide
   * windows are chunked into 90-day slices defensively.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const baseUrl = requireBaseUrl('listClicks');
    const apiKey = requireApiKey('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, REPORT_CHUNK_DAYS);
    const all: Click[] = [];

    for (const slice of slices) {
      const envelope = await scaleoRequest<ScaleoEnvelope<ScaleoClickRaw>>({
        operation: 'listClicks',
        path: '/reports/clicks',
        baseUrl,
        apiKey,
        query: {
          rangeFrom: formatScaleoDate(slice.start),
          rangeTo: formatScaleoDate(slice.end),
          page: 1,
          perPage: 1000,
          offer_id: query?.programmeId,
        },
        resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
      });

      all.push(...extractRows(envelope).map(toClick));
    }

    let results = all;

    if (query?.programmeId) {
      results = results.filter((c) => c.programmeId === query.programmeId);
    }

    if (typeof query?.limit === 'number') {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Not implemented.
   *
   * A Scaleo click link has the form `<tracking-url>/click?o={offerId}&a={affiliateId}`.
   * It requires the affiliate id (`a=`), which is NOT among the two configured
   * credentials (SCALEO_BASE_URL, SCALEO_API_KEY). The API key does not encode
   * the affiliate id, so a correctly-attributed link cannot be constructed
   * deterministically here. Callers should use the per-offer tracking link that
   * Scaleo surfaces on a programme's `rawNetworkData` (the offer's own
   * tracking_link field) instead.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Scaleo tracking links require the affiliate id (the `a` parameter), which is not ' +
        'among the configured credentials. Use the per-offer tracking link on a programme\'s ' +
        'rawNetworkData instead.',
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
  // Admin operations (NotImplementedError — v0.2 scaffolds)
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));

    // getProgramme requires a known offer ID — mark supported without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known offer ID; not probed automatically.',
    };

    // generateTrackingLink is intentionally unsupported (see method comment).
    operations['generateTrackingLink'] = {
      supported: false,
      note:
        'Not implemented: Scaleo click links require the affiliate id, which is not among the ' +
        'configured credentials. Use the per-offer tracking link on a programme\'s rawNetworkData.',
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

export const scaleoAdapter = new ScaleoAdapter();
registerAdapter(scaleoAdapter);

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toClick,
  chunkDateRange,
  formatScaleoDate,
  extractRows,
  asNumber,
  // Pagination internals, exposed so tests can pin the cap and observe the
  // truncation warning without reaching into module state.
  MAX_PAGES,
  OFFERS_PAGE_SIZE,
  log,
};
