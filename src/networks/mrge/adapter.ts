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
 *   - Marks the field or path with `BLOCKED(verify)` (upgraded from TODO(verify))
 *   - Throws NotImplementedError rather than guessing at an invented endpoint
 *   - Notes the limitation in META.knownLimitations and network.json
 *
 * Hardening pass 2026-05-28 upgraded many TODO(verify) items to either
 * CONFIRMED or BLOCKED with specific blockers. See docs/findings/mrge.md.
 *
 * --- API map (grounded in public documentation) --------------------------------
 *
 *   Advertiser API (programme discovery):
 *     GET https://api.yieldkit.com/v2/advertiser/terms
 *       ?api_key=… &api_secret=… &site_id=… [&advertiser_id=…] [&limit=…]
 *     Returns: active advertiser offers with commission terms and tracking links.
 *
 *   Reporting API (commissions/transactions):
 *     GET https://reporting-api.yieldkit.com/v3/commission  [BLOCKED: host unverified]
 *       ?api_key=… &api_secret=… &site_id=…
 *       &modified_date=YYYY-MM-DD  (filter by last-modified date — CONFIRMED field name)
 *     Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED  [CONFIRMED]
 *
 *   Click data: not grounded in public docs — listClicks throws NotImplementedError.
 *
 *   Tracking link: constructed from advertiser/terms tracking_url field, or
 *   falling back to r.srvtrck.com/v1/redirect (CONFIRMED Yieldkit redirect host).
 *   Fallback format: ?api_key=…&type=url&site_id=…&url=…&yk_tag=… [CONFIRMED]
 *
 * --- Auth model ----------------------------------------------------------------
 *
 * Custom: api_key + api_secret + site_id as query parameters. CONFIRMED.
 * Source: Yieldkit docs (public.yieldkit.com) + live API call captures.
 * All three credentials are 24–32-character hexadecimal strings.
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
    'Reporting API host (reporting-api.yieldkit.com) and full path (/v3/commission) are BLOCKED pending live verification; listTransactions may fail until verified.',
    'generateTrackingLink fallback uses the confirmed r.srvtrck.com/v1/redirect pattern; exact parameter order requires live verification.',
    'All response field names (advertiser/terms and commission endpoints) are BLOCKED pending live API access; field names are derived from S2S macro names.',
    'Credentials (api_key, api_secret, site_id) are confirmed as 24-32 character hex strings; validator updated accordingly.',
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
// every field as possibly absent. Fields marked BLOCKED(verify) need
// confirmation against a live account.

/**
 * One advertiser (programme) entry from GET /v2/advertiser/terms.
 * BLOCKED(verify): exact field names require live api.yieldkit.com access.
 * Field names below are derived from Yieldkit S2S macro names ({ADVERTISER_ID}
 * etc.) and search snippets from Yieldkit documentation pages. The commission
 * terms endpoint response structure is not directly accessible (returns 403).
 */
interface MrgeAdvertiserRaw {
  id?: number | string;
  advertiser_id?: number | string;
  name?: string;
  advertiser_name?: string;
  status?: string; // BLOCKED(verify): exact values require live account
  url?: string; // advertiser website — BLOCKED(verify)
  description?: string;
  categories?: string[] | string;
  commission?: string | number; // free-text or numeric — BLOCKED(verify)
  commission_type?: string; // BLOCKED(verify): "percent" | "fixed" | etc.
  currency?: string; // BLOCKED(verify): assumed EUR for European platform
  tracking_url?: string; // base tracking URL — BLOCKED(verify): field name in response
  deep_link?: string; // BLOCKED(verify): alternative deeplink field
}

/**
 * One commission entry from the Reporting API.
 * BLOCKED(verify): exact JSON field names require live Reporting API access.
 * Derived from: Yieldkit S2S tracking macro names ({EVENT_ID}, {COMMISSION_ID},
 * {ADVERTISER_ID}, {COMMISSION}, {SALES_DATE}, {MODIFIED_DATE}) + search
 * result snippets. The REST JSON field names may use the same snake_case
 * convention as the S2S macros but this is not confirmed.
 *
 * What IS confirmed:
 *   - Status values: OPEN, CONFIRMED, REJECTED, DELAYED (confirmed from Yieldkit docs)
 *   - modified_date filter: confirmed as Reporting API date filter parameter name
 *   - sales_date: confirmed as S2S macro {SALES_DATE} — REST field name may differ
 *   - yk_tag: confirmed as the click ID / sub-ID tracking parameter
 */
interface MrgeCommissionRaw {
  // Yieldkit docs use {EVENT_ID}, {COMMISSION_ID}, {ADVERTISER_ID} etc.
  // in their S2S template — the REST JSON field names likely follow the same
  // snake_case convention but are BLOCKED pending live API verification.
  event_id?: string | number;
  commission_id?: string | number;
  advertiser_id?: string | number;
  advertiser_name?: string; // BLOCKED(verify): field name
  commission?: number | string;
  sale_amount?: number | string; // BLOCKED(verify): field name
  currency?: string; // BLOCKED(verify): assumed EUR for European platform
  // Status values CONFIRMED: OPEN, CONFIRMED, REJECTED, DELAYED
  state?: string;
  status?: string; // BLOCKED(verify): alias for state; exact field name unclear
  sales_date?: string; // ISO date — S2S macro {SALES_DATE} confirmed; REST name BLOCKED
  modified_date?: string; // ISO date — CONFIRMED as API filter param name
  click_date?: string; // BLOCKED(verify): field name
  event_type?: string; // "NEW" | "UPDATE" — from S2S docs; REST name BLOCKED
  click_id?: string; // yk_tag value — CONFIRMED parameter name; REST field name BLOCKED
  rejection_reason?: string; // BLOCKED(verify): field name for rejection reason
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
 * CONFIRMED: OPEN, CONFIRMED, REJECTED, DELAYED are documented in Yieldkit
 *   knowledge base. There may be additional values not documented publicly;
 *   unknown values fall through to 'other'. BLOCKED: full set of values
 *   requires live reporting API access.
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
 * BLOCKED(verify): confirm whether the advertiser/terms endpoint returns
 *   advertisers in states other than active/joined, and what status field
 *   values they carry. Requires live API access.
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
 * modified_date CONFIRMED as a Reporting API filter parameter name.
 * sales_date CONFIRMED from S2S macro {SALES_DATE} — REST field name BLOCKED
 * pending live Reporting API access.
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
  // Yieldkit is a European (Hamburg-based) platform; EUR is the default currency.
  // BLOCKED(verify): confirm that non-EUR commissions are also returned with their
  // own currency field. The field name 'currency' is derived from commission terms
  // response structure — requires live API access to confirm.
  const currency = raw.currency ?? 'EUR';

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
    datePaid: undefined, // Yieldkit/mrge does not expose a paid date via the reporting API. BLOCKED: confirm with live account.
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
  // CONFIRMED: the modified_date parameter accepts YYYY-MM-DD from the
  // Yieldkit knowledge base documentation snippets.
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
   * BLOCKED(verify): confirm the full response shape and available query
   *   parameters (e.g. whether pagination is supported, and how). The Reporting
   *   API V3 uses a 'next' URL for pagination; the advertiser API pagination
   *   is unconfirmed. Requires live account access.
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
        // BLOCKED(verify): confirm whether advertiser_id can be used to filter
        // by ID, and whether the API supports limit/offset pagination.
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    // The Yieldkit API response shape is uncertain — handle both array and
    // enveloped forms. BLOCKED(verify): confirm the exact response envelope.
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
   * BLOCKED(verify): confirm whether ?advertiser_id=… is a supported
   *   filter on the /v2/advertiser/terms endpoint, or whether there is a
   *   dedicated /v2/advertiser/{id}/terms endpoint. Requires live API access.
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

    // BLOCKED(verify): confirm whether advertiser_id is a valid filter param
    // on /v2/advertiser/terms or if a dedicated endpoint exists.
    const rawResponse = await mrgeRequest<MrgeAdvertiserRaw[] | { advertiser?: MrgeAdvertiserRaw[] } | { results?: MrgeAdvertiserRaw[] }>({
      operation: 'getProgramme',
      baseUrl: MRGE_BASE_URL,
      path: '/v2/advertiser/terms',
      apiKey,
      apiSecret,
      query: {
        site_id: siteId,
        advertiser_id: programmeId, // BLOCKED(verify): param name
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
   * Uses GET /v3/commission on the reporting API host. The Reporting API V3
   * is documented at yieldkit.com/knowledge/reporting-api-v3/ (403 to fetches)
   * and supports a modified_date filter to pull commissions updated within a
   * time range. Pagination via 'next' URL in response is CONFIRMED.
   *
   * Commission status values: OPEN (pending), CONFIRMED (approved),
   * DELAYED (pending), REJECTED (reversed). All four status values CONFIRMED.
   *
   * BLOCKED(verify): confirm the full endpoint path on reporting-api.yieldkit.com,
   *   all supported query parameters, and the response envelope shape. The host
   *   and path /v3/commission are derived from doc page URL fragments — the exact
   *   URL requires live Reporting API access.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { apiKey, apiSecret, siteId } = requireAuthParams('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // BLOCKED(verify): confirm whether the Yieldkit reporting API supports
    //   a date range (from + to), or only a single modified_date lower bound.
    //   The Yieldkit docs mention modified_date as a filter; whether a 'to' date
    //   is accepted is unconfirmed. For now, use modified_date = from as the
    //   lower bound and filter client-side on the upper bound.
    //
    //   CONFIRMED: modified_date parameter name and YYYY-MM-DD format.
    //   BLOCKED: whether a separate 'to' date param exists.
    const reportingQuery: Record<string, string | number | undefined> = {
      site_id: siteId,
      modified_date: formatDateParam(from), // CONFIRMED: modified_date param name
    };

    if (query?.programmeId) {
      reportingQuery['advertiser_id'] = query.programmeId; // BLOCKED(verify): param name
    }

    const rawResponse = await mrgeRequest<MrgeCommissionRaw[] | { commissions?: MrgeCommissionRaw[] } | { results?: MrgeCommissionRaw[] }>({
      operation: 'listTransactions',
      baseUrl: MRGE_REPORTING_URL,
      // BLOCKED(verify): confirm full endpoint path; /v3/commission is derived
      // from yieldkit.com/knowledge/reporting-api-v3/ URL fragment pattern.
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
      currency: 'EUR', // Yieldkit is a European (Hamburg-based) platform; EUR default. BLOCKED: confirm with live account.
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
   * BLOCKED(verify): if a click-level endpoint is available in
   *   publisher-api.mrge.com, implement this operation. Requires live
   *   credentials and access to publisher-api.mrge.com documentation.
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
   * Format (confirmed from Yieldkit docs):
   *   {tracking_url}&url={destinationUrl, URL-encoded}
   *
   * When the tracking_url field is absent from the programme, falls back to
   * constructing a Yieldkit redirect URL using the confirmed r.srvtrck.com
   * pattern:
   *   https://r.srvtrck.com/v1/redirect?api_key=…&type=url&site_id=…&url=…
   * Source: Yieldkit Redirect API documentation + live API call captures.
   *
   * Because we do not have the tracking_url at call time without making an
   * API call, we make a cheap listProgrammes call to retrieve it. This is
   * acceptable latency for a link-generation operation.
   *
   * BLOCKED(verify): confirm whether publisher-api.mrge.com provides a
   *   dedicated deeplink generation endpoint that supersedes r.srvtrck.com.
   *   Requires live credentials to test.
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
    // BLOCKED(verify): if publisher-api.mrge.com has a dedicated deeplink
    // generation endpoint, use that instead. Requires live API access.
    const programme = await this.getProgramme(input.programmeId);
    const raw = programme.rawNetworkData as MrgeAdvertiserRaw;

    const trackingBase = raw.tracking_url ?? raw.deep_link;

    let trackingUrl: string;
    if (trackingBase) {
      // Append the destination URL to the tracking base.
      const sep = trackingBase.includes('?') ? '&' : '?';
      trackingUrl = `${trackingBase}${sep}url=${encodeURIComponent(input.destinationUrl)}`;
    } else {
      // No tracking URL in the programme data — construct a Yieldkit redirect
      // URL using the confirmed r.srvtrck.com pattern.
      // Source: Yieldkit public documentation + live API call captures:
      //   https://r.srvtrck.com/v1/redirect?url=…&api_key=…&type=url&site_id=…&yk_tag=…
      // r.srvtrck.com is confirmed as the YIELDKIT redirect service host.
      const { apiKey, siteId } = requireAuthParams('generateTrackingLink');
      trackingUrl =
        `https://r.srvtrck.com/v1/redirect` +
        `?api_key=${encodeURIComponent(apiKey)}` +
        `&type=url` +
        `&site_id=${encodeURIComponent(siteId)}` +
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
          ? 'tracking_url from advertiser/terms response + ?url= destination'
          : 'r.srvtrck.com redirect (confirmed Yieldkit redirect host; requires live verification of exact param order)',
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
      note: 'Requires a known programme ID; not probed automatically. Fallback uses confirmed r.srvtrck.com pattern; exact param order requires live verification.',
    };

    // getProgramme filters from listProgrammes — record as supported.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Filters listProgrammes response client-side. BLOCKED: dedicated single-advertiser endpoint unconfirmed without live API access.',
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
