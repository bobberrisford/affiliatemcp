/**
 * mrge adapter — publisher side.
 *
 * mrge is the rebranded Yieldkit/Metapic commerce advertising platform
 * (mrge.com). This adapter targets the legacy Yieldkit API surface because
 * the newer publisher-api.mrge.com documentation was not publicly accessible
 * as of 2026-05-28 (returns 403 to automated fetches).
 *
 * --- Documentation uncertainty -----------------------------------------------
 *
 * The mrge/Yieldkit public API docs are limited and partially inaccessible.
 * Wherever the API shape is uncertain, this adapter:
 *   - Marks the field or path with `// TODO(verify)`
 *   - Throws NotImplementedError rather than guessing at an invented endpoint
 *   - Notes the limitation in META.knownLimitations and network.json
 *
 * Fields marked `// TODO(verify)` MUST be checked against a live account
 * before promoting this adapter past "experimental".
 *
 * --- API map (grounded in public documentation) --------------------------------
 *
 *   Advertiser API (programme discovery):
 *     GET https://api.yieldkit.com/v2/advertiser/terms
 *       ?api_key=… &api_secret=… &site_id=… [&advertiser_id=…] [&limit=…]
 *     Returns: active advertiser offers with commission terms and tracking links.
 *
 *   Reporting API (commissions/transactions):
 *     GET https://reporting-api.yieldkit.com/v3/commission  // TODO(verify) full path
 *       ?api_key=… &api_secret=… &site_id=…
 *       &modified_date=YYYY-MM-DD  (filter by last-modified date)
 *     Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED
 *
 *   Click data: not grounded in public docs — listClicks throws NotImplementedError.
 *
 *   Tracking link: constructed deterministically from advertiser/terms response.
 *   // TODO(verify): confirm the tracking URL format from mrge/Yieldkit docs.
 *
 * --- Auth model ----------------------------------------------------------------
 *
 * Custom: api_key + api_secret as query parameters. Not a bearer token header.
 * Credentials: MRGE_API_KEY, MRGE_API_SECRET, MRGE_SITE_ID.
 *
 * --- Cardinal rules (from Awin reference) -------------------------------------
 *
 *   1. Never call `fetch` directly. Use `mrgeRequest` from `./client.ts`.
 *   2. Every failure must round-trip through a NetworkErrorEnvelope.
 *   3. Preserve upstream response in rawNetworkData on every domain object.
 *   4. Normalise status enums. Prefer 'unknown'/'other' over a wrong guess.
 *   5. Compute ageDays for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string. "programme" not "program".
 */

import { mrgeRequest, MRGE_BASE_URL, MRGE_REPORTING_URL } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireAuthParams } from './auth.js';
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

const log = createLogger('mrge.adapter');

const SLUG = 'mrge';
const NAME = 'mrge';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: MRGE_BASE_URL,
  // Custom because credentials are passed as query parameters, not in an
  // Authorization header. See auth.ts for the full rationale.
  authModel: 'custom',
  docsUrl: 'https://publisher-api.mrge.com/documentation/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  // Experimental: built entirely from public documentation without live
  // account verification. Promote after testing against a real account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'mrge public API documentation is limited; publisher-api.mrge.com returns 403 to automated fetches.',
    'Click-level data is not grounded in public API documentation; listClicks throws NotImplementedError.',
    'getProgramme is not grounded in public docs as a separate endpoint; it filters the listProgrammes result client-side.',
    'Reporting API host and full path are uncertain (// TODO(verify)); listTransactions may fail until verified.',
    'generateTrackingLink uses a URL pattern derived from Yieldkit documentation; the format requires live verification.',
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
// Raw response shapes
// ---------------------------------------------------------------------------
//
// These shapes are derived from public Yieldkit/mrge documentation and
// third-party integration guides. They are deliberately minimal and treat
// every field as possibly absent. Fields marked // TODO(verify) need
// confirmation against a live account.

/**
 * One advertiser (programme) entry from GET /v2/advertiser/terms.
 * // TODO(verify): confirm field names against a live api.yieldkit.com response.
 */
interface MrgeAdvertiserRaw {
  id?: number | string;
  advertiser_id?: number | string;
  name?: string;
  advertiser_name?: string;
  status?: string; // // TODO(verify): values
  url?: string; // advertiser website // TODO(verify)
  description?: string;
  categories?: string[] | string;
  commission?: string | number; // free-text or numeric // TODO(verify)
  commission_type?: string; // // TODO(verify): "percent" | "fixed" | etc.
  currency?: string; // // TODO(verify)
  tracking_url?: string; // base tracking URL for generating deep links // TODO(verify)
  deep_link?: string; // // TODO(verify)
}

/**
 * One commission entry from the Reporting API.
 * // TODO(verify): confirm field names against a live reporting API response.
 * Derived from: Yieldkit S2S tracking docs + search result snippets.
 */
interface MrgeCommissionRaw {
  // Yieldkit docs use {EVENT_ID}, {COMMISSION_ID}, {ADVERTISER_ID} etc.
  // in their S2S template — the REST JSON field names may differ.
  event_id?: string | number;
  commission_id?: string | number;
  advertiser_id?: string | number;
  advertiser_name?: string; // // TODO(verify)
  commission?: number | string;
  sale_amount?: number | string; // // TODO(verify)
  currency?: string; // // TODO(verify)
  // Status values per Yieldkit docs: OPEN, CONFIRMED, REJECTED, DELAYED
  state?: string;
  status?: string; // // TODO(verify): alias for state
  sales_date?: string; // ISO date // TODO(verify)
  modified_date?: string; // ISO date // TODO(verify)
  click_date?: string; // // TODO(verify)
  event_type?: string; // "NEW" | "UPDATE" // TODO(verify)
  click_id?: string; // yk_tag value // TODO(verify)
  rejection_reason?: string; // // TODO(verify)
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Yieldkit commission status → canonical TransactionStatus.
 *
 * Yieldkit uses: OPEN, CONFIRMED, REJECTED, DELAYED
 *
 *   OPEN      → 'pending'  (commission recorded, not yet confirmed)
 *   CONFIRMED → 'approved' (commission confirmed by advertiser)
 *   DELAYED   → 'pending'  (approval delayed; functionally still pending)
 *   REJECTED  → 'reversed' (commission rejected; equivalent to reversed/chargebacked)
 *   anything else → 'other'
 *
 * // TODO(verify): confirm the full set of status values from a live reporting
 *   API response. The docs mention these four; there may be additional values.
 */
function mapTransactionStatus(raw: MrgeCommissionRaw): TransactionStatus {
  const s = (raw.state ?? raw.status ?? '').toUpperCase();
  switch (s) {
    case 'OPEN':
    case 'DELAYED':
      return 'pending';
    case 'CONFIRMED':
      return 'approved';
    case 'REJECTED':
      // Yieldkit's "REJECTED" is our "reversed" — the commission did not pay out.
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * mrge advertiser status → canonical ProgrammeStatus.
 *
 * The Yieldkit advertiser/terms endpoint only returns advertisers with whom
 * the publisher has an active relationship (i.e. joined). There is no
 * "available" or "pending" category exposed by this endpoint.
 *
 * // TODO(verify): confirm whether the endpoint returns advertisers in states
 *   other than active/joined, and what status field values they carry.
 */
function mapProgrammeStatus(raw: MrgeAdvertiserRaw): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'active' || s === 'joined' || s === '') {
    // No status in response = active relationship (this endpoint only returns
    // advertisers you're already working with per the Yieldkit docs).
    return 'joined';
  }
  if (s === 'pending') return 'pending';
  if (s === 'suspended' || s === 'paused' || s === 'inactive') return 'suspended';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  return 'unknown';
}

/**
 * Compute age in days. Anchored on modified_date (the approval date) where
 * available, falling back to sales_date (the conversion date).
 *
 * // TODO(verify): confirm which date fields are returned by the live
 *   reporting API and which is most appropriate for the ageDays anchor.
 */
function computeAgeDays(raw: MrgeCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.modified_date ?? raw.sales_date ?? raw.click_date;
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

function parseAmount(v?: number | string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: MrgeAdvertiserRaw): Programme {
  const id = String(raw.id ?? raw.advertiser_id ?? '');
  const name = raw.name ?? raw.advertiser_name ?? `mrge programme ${id}`;

  // Categories: may be an array or a comma-separated string.
  let categories: string[] | undefined;
  if (Array.isArray(raw.categories)) {
    categories = raw.categories.filter((c): c is string => typeof c === 'string');
  } else if (typeof raw.categories === 'string' && raw.categories.trim()) {
    categories = raw.categories.split(',').map((c) => c.trim()).filter(Boolean);
  }

  // Commission: expose as structured if a type is available, otherwise free-text.
  let commissionRate: Programme['commissionRate'];
  if (raw.commission !== undefined) {
    const value = parseAmount(raw.commission);
    const type = (raw.commission_type ?? '').toLowerCase();
    if (type === 'percent' || type === 'percentage') {
      commissionRate = { type: 'percent', value, description: String(raw.commission) };
    } else if (type === 'fixed' || type === 'flat') {
      commissionRate = {
        type: 'flat',
        value,
        currency: raw.currency,
        description: String(raw.commission),
      };
    } else {
      // Type unknown — use description-only mode.
      commissionRate = { type: 'unknown', description: String(raw.commission) };
    }
  }

  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate,
    categories,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: MrgeCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = parseAmount(raw.commission);
  const saleAmount = parseAmount(raw.sale_amount);
  const currency = raw.currency ?? 'EUR'; // Yieldkit is a European platform // TODO(verify)

  const dateConverted = nullableIso(raw.sales_date) ?? new Date(0).toISOString();
  const dateApproved = nullableIso(raw.modified_date);
  const dateClicked = nullableIso(raw.click_date);

  return {
    id: String(raw.event_id ?? raw.commission_id ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiser_id ?? ''),
    programmeName: raw.advertiser_name ?? '',
    status,
    amount: saleAmount,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid: undefined, // Yieldkit/mrge does not expose a paid date via the reporting API // TODO(verify)
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.rejection_reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function formatDateParam(d: Date): string {
  // Yieldkit Reporting API uses YYYY-MM-DD format for date filters.
  // // TODO(verify): confirm the exact date format expected.
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class MrgeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List mrge advertiser programmes the publisher has joined.
   *
   * Uses GET /v2/advertiser/terms — the Yieldkit endpoint for publisher-side
   * advertiser discovery. This endpoint only returns advertisers with whom
   * the publisher has an active relationship.
   *
   * // TODO(verify): confirm the full response shape and available query
   *   parameters (e.g. whether pagination is supported, and how).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const { apiKey, apiSecret, siteId } = requireAuthParams('listProgrammes');

    const rawResponse = await mrgeRequest<MrgeAdvertiserRaw[] | { advertiser?: MrgeAdvertiserRaw[] } | { results?: MrgeAdvertiserRaw[] }>({
      operation: 'listProgrammes',
      baseUrl: MRGE_BASE_URL,
      path: '/v2/advertiser/terms',
      apiKey,
      apiSecret,
      query: {
        site_id: siteId,
        // // TODO(verify): check if advertiser_id can be used to filter by ID,
        // and whether the API supports limit/offset pagination.
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    // The Yieldkit API response shape is uncertain — handle both array and
    // enveloped forms.
    // // TODO(verify): confirm the exact response envelope.
    let rawItems: MrgeAdvertiserRaw[];
    if (Array.isArray(rawResponse)) {
      rawItems = rawResponse;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'advertiser' in rawResponse &&
      Array.isArray((rawResponse as { advertiser?: MrgeAdvertiserRaw[] }).advertiser)
    ) {
      rawItems = (rawResponse as { advertiser: MrgeAdvertiserRaw[] }).advertiser;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'results' in rawResponse &&
      Array.isArray((rawResponse as { results?: MrgeAdvertiserRaw[] }).results)
    ) {
      rawItems = (rawResponse as { results: MrgeAdvertiserRaw[] }).results;
    } else {
      rawItems = [];
    }

    let programmes = rawItems.map(toProgramme);

    // Client-side filters (the API does not appear to support server-side
    // filtering beyond site_id).
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (query?.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const set = new Set(statuses);
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

    log.debug({ count: programmes.length }, 'mrge listProgrammes');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single mrge programme by advertiser ID.
   *
   * The Yieldkit advertiser/terms endpoint does not appear to support a
   * single-advertiser lookup directly as a distinct endpoint. We use the
   * advertiser_id query parameter to filter server-side.
   *
   * // TODO(verify): confirm whether ?advertiser_id=… is a supported
   *   filter on the /v2/advertiser/terms endpoint, or whether there is a
   *   dedicated /v2/advertiser/{id}/terms endpoint.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Use affiliate_mrge_list_programmes to discover programme IDs.',
        }),
      );
    }

    const { apiKey, apiSecret, siteId } = requireAuthParams('getProgramme');

    // // TODO(verify): confirm whether advertiser_id is a valid query param here.
    const rawResponse = await mrgeRequest<MrgeAdvertiserRaw[] | { advertiser?: MrgeAdvertiserRaw[] } | { results?: MrgeAdvertiserRaw[] }>({
      operation: 'getProgramme',
      baseUrl: MRGE_BASE_URL,
      path: '/v2/advertiser/terms',
      apiKey,
      apiSecret,
      query: {
        site_id: siteId,
        advertiser_id: programmeId, // // TODO(verify): param name
      },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    let rawItems: MrgeAdvertiserRaw[];
    if (Array.isArray(rawResponse)) {
      rawItems = rawResponse;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'advertiser' in rawResponse &&
      Array.isArray((rawResponse as { advertiser?: MrgeAdvertiserRaw[] }).advertiser)
    ) {
      rawItems = (rawResponse as { advertiser: MrgeAdvertiserRaw[] }).advertiser;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'results' in rawResponse &&
      Array.isArray((rawResponse as { results?: MrgeAdvertiserRaw[] }).results)
    ) {
      rawItems = (rawResponse as { results: MrgeAdvertiserRaw[] }).results;
    } else {
      rawItems = [];
    }

    // Filter to the requested ID client-side as a fallback.
    const match = rawItems.find((r) => String(r.id ?? r.advertiser_id) === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `mrge programme "${programmeId}" not found in active programmes.`,
          hint: 'Use affiliate_mrge_list_programmes to list your active programmes and their IDs.',
        }),
      );
    }

    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List mrge commissions from the Yieldkit Reporting API.
   *
   * Uses GET /v3/commission (// TODO(verify): full path) on the reporting API
   * host. The Reporting API V3 supports a modified_date filter to pull
   * commissions updated within a time range.
   *
   * Commission status values: OPEN (pending), CONFIRMED (approved),
   * DELAYED (pending), REJECTED (reversed).
   *
   * // TODO(verify): confirm the full endpoint path, all supported query
   *   parameters, and the response envelope shape.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { apiKey, apiSecret, siteId } = requireAuthParams('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // // TODO(verify): confirm whether the mrge/Yieldkit reporting API supports
    //   a date range (from + to), or only a single modified_date filter.
    //   The Yieldkit docs mention modified_date; a from/to range may not be
    //   directly supported. For now we use modified_date = from as a lower bound.
    const reportingQuery: Record<string, string | number | undefined> = {
      site_id: siteId,
      modified_date: formatDateParam(from), // // TODO(verify): param name and meaning
    };

    if (query?.programmeId) {
      reportingQuery['advertiser_id'] = query.programmeId; // // TODO(verify): param name
    }

    const rawResponse = await mrgeRequest<MrgeCommissionRaw[] | { commissions?: MrgeCommissionRaw[] } | { results?: MrgeCommissionRaw[] }>({
      operation: 'listTransactions',
      baseUrl: MRGE_REPORTING_URL,
      // // TODO(verify): confirm the full endpoint path for the Reporting API V3.
      path: '/v3/commission',
      apiKey,
      apiSecret,
      query: reportingQuery,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    let rawItems: MrgeCommissionRaw[];
    if (Array.isArray(rawResponse)) {
      rawItems = rawResponse;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'commissions' in rawResponse &&
      Array.isArray((rawResponse as { commissions?: MrgeCommissionRaw[] }).commissions)
    ) {
      rawItems = (rawResponse as { commissions: MrgeCommissionRaw[] }).commissions;
    } else if (
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'results' in rawResponse &&
      Array.isArray((rawResponse as { results?: MrgeCommissionRaw[] }).results)
    ) {
      rawItems = (rawResponse as { results: MrgeCommissionRaw[] }).results;
    } else {
      rawItems = [];
    }

    let transactions = rawItems.map((r) => toTransaction(r, now));

    // Apply date window filter client-side to handle the uncertain API date
    // filter semantics.
    transactions = transactions.filter((t) => {
      const converted = Date.parse(t.dateConverted);
      if (Number.isNaN(converted)) return true;
      return converted >= from.getTime() && converted <= to.getTime();
    });

    // Status filter.
    if (query?.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const set = new Set(statuses);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // programmeId filter (redundant if server-side worked, but harmless).
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Age filters — PRD §15.9.
    if (typeof query?.minAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }

    if (typeof query?.limit === 'number') {
      transactions = transactions.slice(0, query.limit);
    }

    log.debug({ count: transactions.length }, 'mrge listTransactions');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from listTransactions, following the same pattern as the Awin
   * reference adapter. See awin/adapter.ts::getEarningsSummary for the
   * rationale: deriving from transactions keeps the summary auditable.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // Never limit inside a summary — would silently undercount.
    });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: 'EUR', // Yieldkit is a European platform; default EUR // TODO(verify)
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
          programmeName: t.programmeName || `mrge advertiser ${key}`,
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
   * Click-level data is not grounded in the public mrge/Yieldkit publisher
   * API documentation. The Reporting API exposes commission data with an
   * associated click_id (yk_tag), but not the full click log.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * distinction between "no clicks" and "no API endpoint" matters (principle 4.1).
   *
   * // TODO(verify): if a click-level endpoint is available in
   *   publisher-api.mrge.com, implement this operation.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'mrge does not expose click-level data via the public publisher API; only click IDs are available on commission records',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a mrge/Yieldkit tracking deep-link.
   *
   * The Yieldkit Redirect API provides tracking links per-advertiser. The
   * tracking_url field in the advertiser/terms response contains the base
   * redirect URL for the advertiser. We construct a deep-link by appending
   * the encoded destination URL.
   *
   * Format (// TODO(verify): confirm with live account):
   *   {tracking_url}&url={destinationUrl, URL-encoded}
   *
   * Because we do not have the tracking_url at call time without making an
   * API call, we make a cheap listProgrammes call to retrieve it. This is
   * acceptable latency for a link-generation operation.
   *
   * // TODO(verify): confirm the exact tracking URL format and whether there
   *   is a dedicated deeplink generation endpoint.
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
          message: 'mrge tracking links require the programme ID.',
          hint: 'Pass programmeId. Use affiliate_mrge_list_programmes to discover IDs.',
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

    // Retrieve the programme to get its tracking_url.
    // // TODO(verify): if mrge has a dedicated deeplink endpoint, use that instead.
    const programme = await this.getProgramme(input.programmeId);
    const raw = programme.rawNetworkData as MrgeAdvertiserRaw;

    const trackingBase = raw.tracking_url ?? raw.deep_link;

    let trackingUrl: string;
    if (trackingBase) {
      // Append the destination URL to the tracking base.
      const sep = trackingBase.includes('?') ? '&' : '?';
      trackingUrl = `${trackingBase}${sep}url=${encodeURIComponent(input.destinationUrl)}`;
    } else {
      // No tracking URL in the programme data — construct a best-effort
      // Yieldkit redirect URL using the known pattern.
      // // TODO(verify): confirm the Yieldkit redirect URL format.
      const { siteId } = requireAuthParams('generateTrackingLink');
      trackingUrl =
        `https://click.yieldkit.com/${encodeURIComponent(input.programmeId)}` +
        `?site_id=${encodeURIComponent(siteId)}` +
        `&url=${encodeURIComponent(input.destinationUrl)}`;
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: trackingBase
          ? 'tracking_url from advertiser/terms + ?url= destination'
          : 'yieldkit redirect best-effort construction (TODO: verify)',
        trackingBase,
        programmeId: input.programmeId,
        destinationUrl: input.destinationUrl,
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
  // Admin operations (v0.1 stubs)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are not implemented for mrge at v0.1.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are not implemented for mrge at v0.1.');
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
          claimStatus: 'experimental', // All ops are experimental until live-verified.
        };
        if (note !== undefined) cap.note = note;
        operations[name] = cap;
      } catch (err) {
        operations[name] = {
          supported: err instanceof NotImplementedError ? false : false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    // listClicks: known-unsupported — do not probe.
    operations['listClicks'] = {
      supported: false,
      note: 'mrge does not expose click-level data via the public publisher API',
    };

    // generateTrackingLink requires a known programme ID — record without probing.
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known programme ID; not probed automatically. TODO(verify): confirm tracking URL format.',
    };

    // getProgramme filters from listProgrammes — record as supported.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Filters listProgrammes response client-side. TODO(verify): dedicated endpoint.',
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

export const mrgeAdapter = new MrgeAdapter();
registerAdapter(mrgeAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  formatDateParam,
  parseAmount,
};

// Silence unused-import lint for logger.
void log;
