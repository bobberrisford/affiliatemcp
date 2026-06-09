/**
 * Involve Asia adapter — publisher side, single-brand.
 *
 * Involve Asia is an affiliate network focused on APAC / South-East Asia.
 * This adapter follows the Awin reference (`src/networks/awin/adapter.ts`);
 * read that file for the full reasoning behind the six cardinal rules. The
 * Involve-Asia-specific divergences are documented inline.
 *
 * --- Auth model (differs from Awin) -----------------------------------------
 *
 * Awin uses a long-lived static bearer token. Involve Asia instead exchanges an
 * API **key** + **secret** for a short-lived bearer token (~2 hours) via
 * `POST /authenticate`, then sends `Authorization: Bearer <token>` on data
 * calls. The token is cached and refreshed (proactively, and reactively on a
 * 401) in `auth.ts` — the Rakuten pattern. The data client (`client.ts`) asks
 * `auth.getAccessToken()` for a token per call rather than receiving one.
 *
 * --- Involve Asia API map ---------------------------------------------------
 *
 * Base: https://api.involve.asia/api
 * (Verify against https://help.involve.asia/hc/en-us/articles/360029841771 and
 *  https://involve.asia/partners/api-overview/. The help-centre articles are
 *  gated to logged-out fetchers; the shapes below are modelled on the public
 *  integration guides and MUST be confirmed against a live account before this
 *  adapter is promoted past `experimental`.)
 *
 *   POST /authenticate              key, secret → { data: { token } }   (auth.ts)
 *   POST /offers/all                page, limit, filters[...] → offers (programmes)
 *   POST /offers/links              offer_id, url → affiliate (tracking) link
 *   POST /conversions/range         start_date, end_date, page, limit, filters[...] → conversions
 *
 * Pagination is page-based: each data response carries `{ page, limit, count,
 * nextPage, data: [...] }` under a top-level `data` envelope. We follow
 * `nextPage` until exhausted.
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * Involve Asia reports `sale_amount` / `payout` as decimal strings in the
 * conversion's own currency (the `currency` field). We parse them as major
 * currency units (e.g. "12.34" → 12.34), NOT minor units. This is the documented
 * behaviour for the conversion report but has not been confirmed against a live
 * account; the assumption is recorded in `META.knownLimitations` and the raw
 * payload is preserved on `rawNetworkData` so a user can reconcile.
 */

import { involveAsiaRequest } from './client.js';
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

const log = createLogger('involve-asia.adapter');

const SLUG = 'involve-asia';
const NAME = 'Involve Asia';

const EXPERIMENTAL_LIMITATION =
  'Experimental: the adapter has not been validated against a live Involve Asia publisher account; endpoint shapes and field names are modelled on the public API documentation and may differ in production.';
const AMOUNT_UNIT_LIMITATION =
  'Amount-unit assumption: sale_amount and payout are read as major currency units (e.g. "12.34" → 12.34) in the conversion currency, not minor units. Verify against your own conversions; the raw payload is preserved on rawNetworkData.';
const TOKEN_LIMITATION =
  'Authentication uses an API key + secret exchanged for a bearer token that expires roughly every 2 hours; the adapter caches and refreshes the token (proactively and on a 401) so callers do not handle the exchange.';
const CLICKS_LIMITATION =
  'Click-level data is not exposed via the public Involve Asia publisher API; listClicks is unsupported.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.involve.asia/api',
  // key + secret → short-lived bearer token. Not a standard static bearer and
  // not OAuth2 client-credentials, so `custom` is the honest classification.
  authModel: 'custom',
  docsUrl: 'https://involve.asia/partners/api-overview/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    EXPERIMENTAL_LIMITATION,
    AMOUNT_UNIT_LIMITATION,
    TOKEN_LIMITATION,
    CLICKS_LIMITATION,
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
//
// listTransactions paginates over a (potentially wide, chunked) date range and
// is the slowest op, so it gets the same longer-timeout / extra-retry profile
// Awin uses for the same reason. getEarningsSummary derives from it.

const CONVERSIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: CONVERSIONS_RESILIENCE,
  getEarningsSummary: CONVERSIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Involve Asia response shapes (deliberately minimal — every field optional)
// ---------------------------------------------------------------------------
//
// As with Awin, we do not model these with strict schemas: the surface is
// weakly documented and may drift. Transformers read keys defensively and
// preserve the original under `rawNetworkData`.

/** Page envelope shared by /offers/all and /conversions/range. */
interface PagedEnvelope<Row> {
  status?: string;
  message?: string;
  data?: {
    page?: number;
    limit?: number;
    count?: number;
    nextPage?: number | null;
    data?: Row[];
  };
}

interface OfferRaw {
  offer_id?: number | string;
  id?: number | string;
  offer_name?: string;
  name?: string;
  status?: string;
  currency?: string;
  // Commission is reported as a free-text descriptor on the offer listing.
  commission?: string;
  commission_rate?: string;
  categories?: string[];
  category?: string;
  preview_url?: string;
  offer_url?: string;
  tracking_link?: string;
}

interface ConversionRaw {
  conversion_id?: number | string;
  id?: number | string;
  offer_id?: number | string;
  offer_name?: string;
  // Amounts are decimal strings in the conversion currency.
  sale_amount?: string | number;
  payout?: string | number;
  currency?: string;
  // Status is a free-text label: pending | approved | rejected | paid (verify).
  conversion_status?: string;
  status?: string;
  // Reason populated when a conversion is rejected.
  rejected_reason?: string;
  rejection_reason?: string;
  reason?: string;
  // Timestamps. `datetime_conversion` is when the sale happened;
  // `datetime_validated` is when Involve Asia approved/validated it.
  datetime_conversion?: string;
  datetime_validated?: string;
  click_time?: string;
  datetime_click?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Involve Asia → canonical.
 *
 * Involve Asia's conversion report uses (verify against the live account):
 *   pending             → 'pending'    (awaiting validation)
 *   approved / validated → 'approved'  (validated, not yet paid)
 *   paid                → 'paid'
 *   rejected            → 'reversed'   (no payout; "reversed" is our canonical
 *                                       term for "did not pay out")
 *   anything else       → 'other'      (never invent a status the user didn't see)
 */
function mapTransactionStatus(raw: ConversionRaw): TransactionStatus {
  const s = (raw.conversion_status ?? raw.status ?? '').toString().toLowerCase().trim();
  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'validated':
    case 'valid':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'rejected':
    case 'reversed':
    case 'declined':
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Involve Asia offer status → canonical ProgrammeStatus.
 *
 * Offers a publisher can see are generally `active`. Involve Asia does not
 * model a publisher↔programme join the way Awin does, so a visible, active
 * offer is treated as 'joined' (the publisher can promote it now), a paused or
 * suspended offer as 'suspended', and anything unrecognised as 'unknown'
 * rather than a wrong guess.
 */
function mapProgrammeStatus(raw: OfferRaw): ProgrammeStatus {
  const s = (raw.status ?? '').toString().toLowerCase().trim();
  if (s === 'active' || s === 'live' || s === 'joined' || s === 'running') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'paused' || s === 'suspended' || s === 'inactive') return 'suspended';
  if (s === 'available' || s === 'notjoined') return 'available';
  if (s === 'rejected' || s === 'declined') return 'declined';
  return s === '' ? 'joined' : 'unknown';
}

/**
 * Parse an Involve Asia amount string/number into a numeric major-unit value.
 * See the amount-unit note in the file header.
 */
function parseAmount(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the age (in days) of a conversion. PRD §15.9 — the unpaid-age
 * affordance depends on this. We anchor on the validation date (when Involve
 * Asia approved the commission) and fall back to the conversion date when the
 * conversion is still pending and has no validation date.
 */
function computeAgeDays(raw: ConversionRaw, now: Date = new Date()): number {
  const anchor = raw.datetime_validated ?? raw.datetime_conversion;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: OfferRaw): Programme {
  const id = String(raw.offer_id ?? raw.id ?? '');
  const commissionText = raw.commission ?? raw.commission_rate;
  const categories =
    raw.categories ?? (raw.category ? [raw.category] : undefined);
  return {
    id,
    name: raw.offer_name ?? raw.name ?? `Involve Asia offer ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate: commissionText ? { type: 'unknown', description: commissionText } : undefined,
    categories: (categories ?? []).filter((c): c is string => typeof c === 'string'),
    advertiserUrl: raw.offer_url ?? raw.preview_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const sale = parseAmount(raw.sale_amount);
  const commission = parseAmount(raw.payout);
  const currency = raw.currency ?? 'USD';

  const dateConverted = nullableIso(raw.datetime_conversion) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.click_time ?? raw.datetime_click);
  const dateApproved = nullableIso(raw.datetime_validated);

  return {
    id: String(raw.conversion_id ?? raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.offer_id ?? ''),
    programmeName: raw.offer_name ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    // Involve Asia's conversion report carries an approved/validated date but
    // not a distinct payout date on the row; leave datePaid undefined rather
    // than fabricating. The status 'paid' still surfaces when reported.
    datePaid: status === 'paid' ? dateApproved : undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.rejected_reason ?? raw.rejection_reason ?? raw.reason ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class InvolveAsiaAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — Involve Asia "offers"
  // -------------------------------------------------------------------------

  /**
   * List Involve Asia offers (the network's term for programmes).
   *
   * `POST /offers/all` is page-based. We page through `nextPage` until the API
   * stops returning one, then apply client-side filters (search, status,
   * categories, limit) — the public offer listing does not document a search or
   * status filter, so we filter in-process rather than guessing query params.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const rawRows = await this.pageThrough<OfferRaw>('listProgrammes', '/offers/all', {
      limit: 100,
    });

    let programmes = rawRows.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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
   * Fetch a single offer by id.
   *
   * Involve Asia does not document a "single offer" endpoint distinct from the
   * listing, so we fetch the offer set and select the requested id client-side.
   * An unknown id surfaces as a network_api_error envelope rather than a
   * fabricated stub (PRD principle 4.1).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'An offer id is required.',
          hint: 'List offers first (affiliate_involve_asia_list_programmes) to find the id.',
        }),
      );
    }

    const rawRows = await this.pageThrough<OfferRaw>('getProgramme', '/offers/all', { limit: 100 });
    const match = rawRows.find((r) => String(r.offer_id ?? r.id ?? '') === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Involve Asia offer found with id "${programmeId}".`,
          hint: 'Confirm the id via affiliate_involve_asia_list_programmes.',
        }),
      );
    }
    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions — Involve Asia "conversions report"
  // -------------------------------------------------------------------------

  /**
   * List conversions across a date window.
   *
   * `POST /conversions/range` takes `start_date` / `end_date` (YYYY-MM-DD) plus
   * page/limit. Involve Asia caps a single report request to a 31-day window in
   * practice, so — like Awin — we chunk a wider `from`/`to` into ≤31-day slices
   * and page through each slice. Default window is the last 30 days.
   *
   * Status, programme, and age filters are applied client-side after fetch so
   * the canonical query shape behaves consistently regardless of which filters
   * the upstream report supports.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: ConversionRaw[] = [];
    for (const slice of slices) {
      const rows = await this.pageThrough<ConversionRaw>(
        'listTransactions',
        '/conversions/range',
        {
          start_date: formatDate(slice.start),
          end_date: formatDate(slice.end),
          limit: 100,
        },
      );
      allRaw.push(...rows);
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

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
  // getEarningsSummary — derived from listTransactions
  // -------------------------------------------------------------------------

  /**
   * Aggregate conversions into an earnings summary. Derived from
   * `listTransactions` (not a separate report endpoint) so the user can
   * recompute the same numbers from the conversions they see — the Awin
   * rationale applies verbatim. `limit` is intentionally dropped so a summary
   * never silently undercounts (principle 4.1).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({ ...query, from, to, limit: undefined });

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
          programmeName: t.programmeName || `Involve Asia offer ${key}`,
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
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks — unsupported
  // -------------------------------------------------------------------------

  /**
   * Involve Asia does not expose click-level data via its public publisher API.
   * We throw `NotImplementedError` rather than returning `[]` so "no API" is not
   * mistaken for "no clicks" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Involve Asia does not expose click-level data via the public publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — API round-trip
  // -------------------------------------------------------------------------

  /**
   * Generate an Involve Asia affiliate link.
   *
   * Unlike Awin's deterministic deep-link, Involve Asia mints tracking links
   * server-side (the link embeds account + offer attribution that is not
   * client-derivable), so we call `POST /offers/links` with the offer id and
   * destination URL and read the returned link. Inputs are validated first so a
   * caller error surfaces as a config_error envelope rather than an upstream
   * 400.
   *
   * Note: Involve Asia documents a monthly cap on generated links (1,000/month
   * on standard accounts). Exceeding it surfaces as the upstream error verbatim.
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
          message: 'Involve Asia tracking links require the offer (programme) id.',
          hint: 'Pass `programmeId`. Use affiliate_involve_asia_list_programmes to find the offer id.',
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

    const raw = await involveAsiaRequest<{
      status?: string;
      message?: string;
      data?: { tracking_link?: string; link?: string; url?: string };
    }>({
      operation: 'generateTrackingLink',
      path: '/offers/links',
      form: { offer_id: input.programmeId, url: input.destinationUrl },
      resilience: RESILIENCE.default,
    });

    const trackingUrl = raw.data?.tracking_link ?? raw.data?.link ?? raw.data?.url;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          networkErrorBody: JSON.stringify(raw),
          message: 'Involve Asia link endpoint returned no tracking link.',
          hint: 'Confirm the offer id is valid and your monthly link quota is not exhausted.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: raw,
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

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        operations[name] = { supported: true, latencyMs: Date.now() - start, sampleSize };
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
      note: 'Involve Asia does not expose click-level data via the public publisher API',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Mints a link via POST /offers/links; requires a valid offer id, not probed automatically.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Selects an offer from the offer listing; requires a known offer id, not probed automatically.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: page through a paged Involve Asia endpoint
  // -------------------------------------------------------------------------

  /**
   * Follow `data.nextPage` until the endpoint stops returning one, collecting
   * every row. A defensive page cap stops a misbehaving `nextPage` (one that
   * never settles to null) from looping unboundedly.
   */
  private async pageThrough<Row>(
    operation: string,
    path: string,
    baseForm: Record<string, string | number | undefined>,
  ): Promise<Row[]> {
    const rows: Row[] = [];
    let page = 1;
    const MAX_PAGES = 1000;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const envelope = await involveAsiaRequest<PagedEnvelope<Row>>({
        operation,
        path,
        form: { ...baseForm, page },
        resilience: RESILIENCE[operation as keyof typeof RESILIENCE] ?? RESILIENCE.default,
      });
      const pageRows = envelope.data?.data;
      if (Array.isArray(pageRows)) rows.push(...pageRows);
      const next = envelope.data?.nextPage;
      if (next === undefined || next === null || Number(next) <= page) break;
      page = Number(next);
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const involveAsiaAdapter = new InvolveAsiaAdapter();
registerAdapter(involveAsiaAdapter);

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

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Involve Asia caps a single
 * conversion-report request at ~31 days; we chunk so callers can request wider
 * windows naturally. Returns at least one slice.
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

/** Format a Date as `YYYY-MM-DD` for the conversion report's date params. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Internal test helpers — exported under `_` so they do not appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  parseAmount,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatDate,
};

void log;
