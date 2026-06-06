/**
 * CAKE adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and `src/networks/everflow/adapter.ts`. Read those files and their header
 * comments before modifying this one.
 *
 * --- What CAKE is -----------------------------------------------------------
 *
 * CAKE (getcake) is a per-instance affiliate-platform engine: every CAKE-powered
 * network runs on its OWN host. There is no single global CAKE API host. The
 * instance host is therefore a CREDENTIAL, supplied via `CAKE_BASE_URL`. One
 * parameterised adapter (base URL + API key) covers every CAKE network. This is
 * the "multiplier base-URL" pattern.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Affiliate API Key as the `api_key` QUERY parameter, plus the numeric
 *          `affiliate_id`. Both are shown in the affiliate portal under the
 *          "Reporting API" panel. Confirmed via support.getcake.com (2026-06-05).
 * Base:    Per-instance, via CAKE_BASE_URL (e.g. https://your-network.cakemarketing.com).
 * Format:  XML (classic ASP.NET `.asmx` web services). See client.ts parseXml.
 * Docs:    https://support.getcake.com/support/solutions/folders/5000173061
 *          (AFFILIATE API Documentation) / https://developer.cake.net/apis
 *
 * --- Affiliate endpoint map (verified against support.getcake.com, 2026-06-05) ---
 *
 *   GET /affiliates/api/4/offers.asmx/OfferFeed
 *     ?api_key=...&affiliate_id=...
 *     → list of offers (programmes) visible to the affiliate. Fields include
 *       offer_id, offer_name, payout (e.g. "$6.00"), price_format (e.g. "CPA").
 *   GET /affiliates/api/2/offers.asmx/GetCampaign
 *     ?api_key=...&affiliate_id=...&campaign_id=... (or offer_id)
 *     → single campaign/offer detail.
 *   GET /affiliates/api/5/reports.asmx/Conversions
 *     ?api_key=...&affiliate_id=...&start_date=...&end_date=...&offer_id=...
 *     → conversion report. XML wrapper conversion_report_response → conversions
 *       → conversion, with conversion_id, conversion_date, offer/affiliate ids,
 *       paid amount, received (revenue), currency, disposition (approval state).
 *
 * Date format: MM/DD/YYYY HH:mm:ss (confirmed via the Conversions docs).
 * Pagination: start_at_row + row_limit on the report endpoints.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `cakeRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live CAKE instance.
 *   - The API base is the per-instance CAKE host, supplied via CAKE_BASE_URL —
 *     not a fixed value.
 *   - Conversion amounts are assumed to be major currency units (e.g. dollars,
 *     not cents); CAKE reports money as decimal strings such as "6.00".
 *   - listClicks: CAKE's documented affiliate reporting surface exposes
 *     conversions, not affiliate-scoped click rows; click reports are
 *     admin-side. Throws NotImplementedError until confirmed against a live tenant.
 *   - generateTrackingLink: CAKE tracking URLs are per-creative/per-campaign
 *     redirect links assigned server-side (GetCreativeCode returns creative HTML,
 *     not a clean deep-link). No deterministic construction is documented; throws
 *     NotImplementedError.
 */

import {
  cakeRequest,
  findAll,
  findFirst,
  childText,
  SLUG,
  type CakeElement,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requireAffiliateId,
} from './auth.js';
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

const log = createLogger('cake.adapter');

const NAME = 'CAKE';

const KNOWN_LIMITATIONS = [
  'Adapter built from public API documentation; not yet verified against a live CAKE instance.',
  'The API base is the per-instance CAKE host, supplied via CAKE_BASE_URL — not a fixed value.',
  'Conversion amounts are assumed to be major currency units (e.g. dollars, not cents).',
  'Click-level data is not exposed via the documented CAKE affiliate reporting API; listClicks is unsupported.',
  'Tracking links are assigned server-side per creative; generateTrackingLink is unsupported (no documented deterministic construction).',
];

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Placeholder only — the real base is the per-instance host via CAKE_BASE_URL.
  baseUrl: 'https://your-instance.cakemarketing.com',
  // CAKE passes the key as a query parameter, not a header — closest model is `custom`.
  authModel: 'custom',
  docsUrl: 'https://support.getcake.com/support/solutions/folders/5000173061',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live instance.
  claimStatus: 'experimental',
  knownLimitations: KNOWN_LIMITATIONS,
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Conversion reports (listTransactions / getEarningsSummary) can be slow when
 * the date window is wide. Give them a 60s timeout and 3 retries, matching the
 * pattern established by Awin's listTransactions.
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
};

// Affiliate endpoint paths (version pinned per the documented affiliate API).
const OFFERFEED_PATH = '/affiliates/api/4/offers.asmx/OfferFeed';
const GETCAMPAIGN_PATH = '/affiliates/api/2/offers.asmx/GetCampaign';
const CONVERSIONS_PATH = '/affiliates/api/5/reports.asmx/Conversions';

// CAKE conversion reports cap a single call's window; chunk to <=31 days to stay
// well within typical report limits and keep payloads manageable.
const CONVERSION_WINDOW_DAYS = 31;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Parse a CAKE money string into a number.
 *
 * CAKE renders money as decimal strings, sometimes with a leading currency
 * symbol, e.g. "$6.00" or "6.00". We strip everything that is not a digit,
 * minus, or decimal point. AMOUNT-UNIT ASSUMPTION: the value is in MAJOR units
 * (dollars/pounds), not minor units (cents). This is recorded as a known
 * limitation; correct against a live tenant if it proves wrong.
 */
function parseMoney(raw?: string): number {
  if (raw === undefined) return 0;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Extract a 3-letter ISO currency code from a CAKE money string if present. */
function currencyFromMoney(raw?: string): string | undefined {
  if (!raw) return undefined;
  // CAKE money strings lead with a symbol ($) rather than an ISO code; we cannot
  // reliably derive ISO from "$6.00". Return undefined and let callers default.
  const iso = raw.match(/\b([A-Z]{3})\b/);
  return iso?.[1];
}

function isoFromCakeDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Status normalisation: CAKE offer status → canonical ProgrammeStatus.
 *
 * The affiliate OfferFeed exposes the affiliate's contract/visibility against an
 * offer. Documented offer/contract states map as follows (support.getcake.com,
 * 2026-06-05). CAKE wording varies across versions, so we read defensively and
 * fall back to `available`/`unknown` rather than guessing.
 *
 *   public / active / approved      → 'joined'    (running for this affiliate)
 *   apply-to-run / pending          → 'pending'   (awaiting approval)
 *   private / rejected / declined   → 'declined'  (not available to this affiliate)
 *   paused / expired / deleted      → 'suspended'
 *   (no contract / generic active)  → 'available'
 */
function mapProgrammeStatus(raw: CakeOfferRaw): ProgrammeStatus {
  const s = (raw.offer_status ?? raw.offer_contract_status ?? '').toLowerCase();
  if (s === '') return raw.offer_id ? 'available' : 'unknown';
  if (s.includes('approved') || s === 'active' || s === 'public' || s === 'running') return 'joined';
  if (s.includes('pending') || s.includes('apply') || s.includes('review')) return 'pending';
  if (s.includes('reject') || s.includes('declin') || s === 'private') return 'declined';
  if (s.includes('paus') || s.includes('expir') || s.includes('delet') || s.includes('inactiv'))
    return 'suspended';
  if (s === 'available' || s === 'open') return 'available';
  return 'unknown';
}

/**
 * Status normalisation: CAKE conversion disposition → canonical TransactionStatus.
 *
 * CAKE conversions carry a `disposition` (and a paid flag). Documented
 * disposition names map as follows (support.getcake.com Conversions, 2026-06-05).
 * We read the disposition name defensively; unknown values map to 'other'.
 *
 *   approved / converted / valid       → 'approved'
 *   pending / new / in review          → 'pending'
 *   rejected / reversed / charged back  → 'reversed'
 *   (paid flag true)                   → 'paid'   (overrides the above)
 */
function mapTransactionStatus(raw: CakeConversionRaw): TransactionStatus {
  // CAKE marks a conversion as paid via an explicit flag once billed.
  const paid = (raw.paid ?? '').toString().toLowerCase();
  if (paid === 'true' || paid === '1' || paid === 'yes') return 'paid';

  const d = (raw.disposition ?? raw.disposition_name ?? '').toLowerCase();
  if (d === '') return 'other';
  if (d.includes('approv') || d.includes('convert') || d === 'valid') return 'approved';
  if (d.includes('pending') || d.includes('new') || d.includes('review')) return 'pending';
  if (d.includes('reject') || d.includes('revers') || d.includes('charge') || d.includes('declin') || d.includes('invalid'))
    return 'reversed';
  return 'other';
}

/**
 * Compute the age in days of a transaction relative to `now`, anchored on the
 * conversion date. PRD §15.9 — the unpaid-age affordance depends on this number.
 */
function computeAgeDays(raw: CakeConversionRaw, now: Date = new Date()): number {
  const anchor = raw.conversion_date;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/** Format a Date for CAKE's `start_date`/`end_date` params: MM/DD/YYYY HH:mm:ss (UTC). */
function formatCakeDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Raw shapes (defensive — every field optional; see Awin adapter for rationale)
// ---------------------------------------------------------------------------

interface CakeOfferRaw {
  offer_id?: string;
  offer_name?: string;
  offer_status?: string;
  offer_contract_status?: string;
  payout?: string; // e.g. "$6.00"
  price_format?: string; // e.g. "CPA", "RevShare"
  currency?: string;
  currency_id?: string;
  preview_link?: string;
  category?: string;
  vertical_name?: string;
}

interface CakeConversionRaw {
  conversion_id?: string;
  conversion_date?: string;
  click_date?: string;
  offer_id?: string;
  offer_name?: string;
  affiliate_id?: string;
  disposition?: string;
  disposition_name?: string;
  paid?: string;
  price?: string; // amount paid to the affiliate (commission)
  received?: string; // revenue received
  currency?: string;
  currency_symbol?: string;
}

// ---------------------------------------------------------------------------
// XML element → raw record extraction
// ---------------------------------------------------------------------------
//
// CAKE returns each offer/conversion as an element whose children are scalar
// fields. We read a fixed set of fields plus a couple of nested-name fallbacks
// (CAKE nests offer name under <offer>/<offer_name> in some report versions).

function elementToOffer(el: CakeElement): CakeOfferRaw {
  const offerEl = findFirst(el, 'offer') ?? el;
  return {
    offer_id: childText(el, 'offer_id') ?? childText(offerEl, 'offer_id'),
    offer_name: childText(el, 'offer_name') ?? childText(offerEl, 'offer_name'),
    offer_status: childText(el, 'offer_status'),
    offer_contract_status: childText(el, 'offer_contract_status') ?? childText(el, 'contract_status'),
    payout: childText(el, 'payout'),
    price_format: childText(el, 'price_format'),
    currency: childText(el, 'currency'),
    currency_id: childText(el, 'currency_id'),
    preview_link: childText(el, 'preview_link') ?? childText(el, 'thank_you_url'),
    category: childText(el, 'category'),
    vertical_name: childText(el, 'vertical_name'),
  };
}

function elementToConversion(el: CakeElement): CakeConversionRaw {
  const offerEl = findFirst(el, 'offer');
  return {
    conversion_id: childText(el, 'conversion_id'),
    conversion_date: childText(el, 'conversion_date'),
    click_date: childText(el, 'click_date'),
    offer_id: childText(el, 'offer_id') ?? (offerEl ? childText(offerEl, 'offer_id') : undefined),
    offer_name:
      childText(el, 'offer_name') ?? (offerEl ? childText(offerEl, 'offer_name') : undefined),
    affiliate_id: childText(el, 'affiliate_id'),
    disposition: childText(el, 'disposition'),
    disposition_name: childText(el, 'disposition_name'),
    paid: childText(el, 'paid'),
    price: childText(el, 'price'),
    received: childText(el, 'received'),
    currency: childText(el, 'currency'),
    currency_symbol: childText(el, 'currency_symbol'),
  };
}

// ---------------------------------------------------------------------------
// Transformers (CAKE raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: CakeOfferRaw): Programme {
  const id = String(raw.offer_id ?? '');
  const categories: string[] = [];
  if (raw.category) categories.push(raw.category);
  if (raw.vertical_name) categories.push(raw.vertical_name);

  return {
    id,
    name: raw.offer_name ?? `CAKE offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? currencyFromMoney(raw.payout),
    commissionRate:
      raw.payout !== undefined
        ? {
            // CAKE price_format names the model: CPA/CPL → flat; RevShare → percent.
            type: /rev\s*share|percent/i.test(raw.price_format ?? '') ? 'percent' : 'flat',
            value: parseMoney(raw.payout),
            description: raw.price_format ? `${raw.price_format} ${raw.payout}` : raw.payout,
          }
        : undefined,
    categories,
    advertiserUrl: raw.preview_link,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: CakeConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = parseMoney(raw.price);
  const sale = parseMoney(raw.received);
  const currency = raw.currency ?? currencyFromMoney(raw.price) ?? 'USD';
  const offerId = String(raw.offer_id ?? '');

  const dateConverted = isoFromCakeDate(raw.conversion_date) ?? new Date(0).toISOString();
  const dateClicked = isoFromCakeDate(raw.click_date);

  return {
    id: String(raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: offerId,
    programmeName: raw.offer_name ?? `CAKE offer ${offerId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    // CAKE does not expose a distinct approval-date field on the conversion row;
    // use the conversion date for approved rows as a best-effort proxy.
    dateApproved: status === 'approved' || status === 'paid' ? dateConverted : undefined,
    // No payment-date field on the conversion report; leave undefined rather than fabricate.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.disposition_name ?? raw.disposition ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date chunking
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/** Split `[from, to]` into <=`maxDays`-day chunks (mirrors Awin/Everflow). */
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CakeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List offers (programmes) visible to this affiliate via the OfferFeed.
   *
   * CAKE endpoint: GET /affiliates/api/4/offers.asmx/OfferFeed
   * The feed has no server-side free-text search; we apply search / status /
   * category / limit filters client-side for consistency with the other adapters.
   * Pagination uses start_at_row + row_limit; we fetch the first page.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    const affiliateId = requireAffiliateId('listProgrammes');
    const rowLimit = Math.min(query?.limit ?? 100, 500);

    const root = await cakeRequest({
      operation: 'listProgrammes',
      path: OFFERFEED_PATH,
      apiKey,
      query: { affiliate_id: affiliateId, start_at_row: 1, row_limit: rowLimit },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = findAll(root, 'offer').map((el) => toProgramme(elementToOffer(el)));

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
   * Fetch a single offer (programme) by ID.
   *
   * CAKE endpoint: GET /affiliates/api/2/offers.asmx/GetCampaign
   * CAKE addresses a single offer via the campaign endpoint; we pass the offer
   * id as both campaign_id and offer_id so either tenant convention resolves.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `CAKE offer IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_cake_list_programmes to discover valid offer IDs.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');
    const affiliateId = requireAffiliateId('getProgramme');

    const root = await cakeRequest({
      operation: 'getProgramme',
      path: GETCAMPAIGN_PATH,
      apiKey,
      query: { affiliate_id: affiliateId, campaign_id: programmeId, offer_id: programmeId },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // The single-offer response wraps the offer in an <offer> (or <campaign>)
    // element; fall back to the root if neither is present.
    const offerEl = findFirst(root, 'offer') ?? findFirst(root, 'campaign') ?? root;
    return toProgramme(elementToOffer(offerEl));
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions via the affiliate Conversions report.
   *
   * CAKE endpoint: GET /affiliates/api/5/reports.asmx/Conversions
   *   ?api_key=...&affiliate_id=...&start_date=MM/DD/YYYY HH:mm:ss
   *   &end_date=...&offer_id=...
   *
   * Date window default: last 30 days. We chunk wide windows into <=31-day
   * slices so callers can request long ranges without tripping report caps.
   * Status / age / limit filters are applied client-side.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');
    const affiliateId = requireAffiliateId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, CONVERSION_WINDOW_DAYS);

    const allRaw: CakeConversionRaw[] = [];
    for (const slice of slices) {
      const root = await cakeRequest({
        operation: 'listTransactions',
        path: CONVERSIONS_PATH,
        apiKey,
        query: {
          affiliate_id: affiliateId,
          start_date: formatCakeDate(slice.start),
          end_date: formatCakeDate(slice.end),
          // CAKE uses 0 to mean "all offers" on report endpoints.
          offer_id: query?.programmeId ?? 0,
          start_at_row: 1,
          row_limit: 5000,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...findAll(root, 'conversion').map(elementToConversion));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
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
   * Aggregate the conversion report into an earnings summary.
   *
   * Derived from `listTransactions` (same rationale as Awin/Everflow): the
   * per-transaction `ageDays` needed for `oldestUnpaidAgeDays` is only available
   * from the raw rows, and deriving keeps the summary auditable.
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
          programmeName: t.programmeName || `CAKE offer ${key}`,
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
   * CAKE's documented affiliate reporting surface exposes conversions, not
   * affiliate-scoped click rows — the Clicks report is admin-side (under /api/,
   * not /affiliates/api/). We throw NotImplementedError rather than returning an
   * empty array: the difference between "no clicks" and "no affiliate clicks
   * endpoint" is the difference between an actionable observation and a wild
   * goose chase (PRD principle 4.1). If a live tenant confirms an affiliate
   * click report, this becomes a real implementation and the limitation drops.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'CAKE does not expose click-level data via the documented affiliate reporting API; ' +
        'the Clicks report is admin-side only.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * CAKE tracking links are per-creative/per-campaign redirect URLs assigned
   * server-side. The documented affiliate path (GetCreativeCode) returns creative
   * HTML rather than a clean deep-link, and there is no documented deterministic
   * URL format keyed on (affiliate, offer, destination). Rather than fabricate a
   * URL that may not route, we throw NotImplementedError with the reason. This is
   * the honest choice under principle 4.1 until verified against a live tenant.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'CAKE tracking links are assigned server-side per creative; no documented ' +
        'deterministic link construction is available for the affiliate API.',
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

    const probe = async (name: string, fn: () => Promise<unknown>, note?: string): Promise<void> => {
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

    // getProgramme requires a known offer ID — record without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known offer ID; not probed automatically.',
    };

    // Known-unsupported on the documented affiliate API. Record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'CAKE does not expose click-level data via the documented affiliate reporting API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'CAKE tracking links are assigned server-side per creative; no deterministic construction.',
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

export const cakeAdapter = new CakeAdapter();
registerAdapter(cakeAdapter);

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  parseMoney,
  toProgramme,
  toTransaction,
  elementToOffer,
  elementToConversion,
  chunkDateRange,
  formatCakeDate,
};

// Silence unused-import lint for the logger.
void log;
