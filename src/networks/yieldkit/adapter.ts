/**
 * Yieldkit adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts`. That file is
 * the canonical reference; read it for the deep reasoning behind the structure.
 * The load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- What Yieldkit is ----------------------------------------------------------
 *
 * Yieldkit is a link-monetisation network (it owns Digidip). Publishers do not
 * "join" individual programmes in the Awin sense; instead they access a large
 * catalogue of advertiser offers and mint tracking links/deeplinks against any
 * destination URL. The adapter maps that catalogue onto the `Programme` type so
 * the cross-network discovery affordance still works.
 *
 * --- Yieldkit API map (verify against the docs below) --------------------------
 *
 * Auth: `api_key` + `api_secret` query parameters on every call, plus
 * `format=json`. Handled by `client.ts`.
 *   Source: https://yieldkit.com/knowledge/commission-terms/
 *           https://public.yieldkit.com/  (Account → API access)
 *
 * Advertiser API (base https://api.yieldkit.com):
 *   GET /v2/advertiser
 *     → catalogue of advertiser offers with tracking links + metadata.
 *     Response shape (defensive — fields treated as possibly absent):
 *       { advertisers: [{ id, name, status, category, currency, url,
 *                         tracking|tracking_url|deeplink, commission|payout }] }
 *   Source: https://yieldkit.com/knowledge/advertiser-api/
 *           https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/advertiser-api/index.html
 *
 * Reporting API v3 (base https://api.yieldkit.com):
 *   GET /v3/report/commission
 *     ?valid_from=YYYY-MM-DD&valid_to=YYYY-MM-DD&page=N&page_size=N
 *     → commissions. Status values OPEN | CONFIRMED | REJECTED | DELAYED.
 *       Amount in `commission`; sale in `amount`; `currency`; `yk_tag` echoes
 *       the publisher click_id; click/sale/modified dates.
 *       Pagination via a `next` URL at the top of each page.
 *   GET /v3/report/click
 *     ?valid_from=YYYY-MM-DD&valid_to=YYYY-MM-DD&page=N&page_size=N
 *     → click-level rows.
 *   Source: https://yieldkit.com/knowledge/reporting-api-v3/
 *           https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/reporting-api/index.html
 *
 * Redirect/Link API (base https://r.srvtrck.com):
 *   GET /v1/redirect?url=<destination>&api_key=<key>&type=url&source=<site>&yk_tag=<click_id>
 *     → a monetised redirect/deeplink for any destination URL. Deterministic;
 *       no API round-trip needed to construct it.
 *   Source: https://yieldkit.com/knowledge/redirect-api/
 *
 * --- Amount-unit assumption ----------------------------------------------------
 *
 * Yieldkit reports commission and sale amounts as decimal values in the row
 * `currency` (the docs show `commission`/`currency` examples in EUR with a
 * decimal value, e.g. "12.50"). We therefore treat amounts as MAJOR currency
 * units (euros, not cents) and parse them as floats. If a live account shows
 * minor units this is the one assumption to revisit. The verbatim payload is
 * preserved on `rawNetworkData` so the user can always reconcile.
 */

import {
  yieldkitRequest,
  YIELDKIT_REDIRECT_BASE_URL,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requireApiSecret,
  ADVERTISER_PATH,
  YIELDKIT_SLUG,
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

const log = createLogger('yieldkit.adapter');

const SLUG = YIELDKIT_SLUG;
const NAME = 'Yieldkit';

const EXPERIMENTAL_LIMITATION =
  'Adapter is experimental: the API shapes were mapped from public documentation ' +
  'and have not been validated against a live Yieldkit publisher account.';

const AMOUNT_UNIT_LIMITATION =
  'Commission and sale amounts are assumed to be in major currency units (e.g. euros, ' +
  'not cents); revisit this assumption if a live account reports minor units.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.yieldkit.com',
  // Custom scheme: api_key + api_secret query parameters (not a bearer token).
  authModel: 'custom',
  docsUrl: 'https://public.yieldkit.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [EXPERIMENTAL_LIMITATION, AMOUNT_UNIT_LIMITATION],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * The commission report can be slow and paginated, so it gets a longer timeout
 * and an extra retry — mirroring Awin's treatment of its transactions endpoint.
 */
const REPORT_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORT_RESILIENCE,
  getEarningsSummary: REPORT_RESILIENCE,
  listClicks: REPORT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Yieldkit response shapes (deliberately minimal; every field is optional —
// see client.ts for why we don't model these with strict schemas).
// ---------------------------------------------------------------------------

interface YieldkitAdvertiserRaw {
  id?: number | string;
  advertiser_id?: number | string;
  name?: string;
  status?: string;
  category?: string;
  categories?: string[];
  currency?: string;
  url?: string;
  homepage?: string;
  // Tracking link to the advertiser's site; field name varies across endpoints.
  tracking?: string;
  tracking_url?: string;
  deeplink?: string;
  // Commission summary; Yieldkit exposes this as a free-text/structured value.
  commission?: string | number;
  payout?: string | number;
}

interface YieldkitAdvertisersEnvelope {
  advertisers?: YieldkitAdvertiserRaw[];
  offers?: YieldkitAdvertiserRaw[];
  data?: YieldkitAdvertiserRaw[];
}

interface YieldkitCommissionRaw {
  id?: number | string;
  commission_id?: number | string;
  advertiser_id?: number | string;
  advertiser?: string;
  advertiser_name?: string;
  status?: string;
  // Sale amount and commission amount. Decimal strings/numbers in `currency`.
  amount?: string | number;
  commission?: string | number;
  currency?: string;
  // Yieldkit echoes the publisher click_id as `yk_tag`.
  yk_tag?: string;
  // Dates. Field names vary; we read several defensively.
  click_date?: string;
  click_time?: string;
  sales_date?: string;
  sale_date?: string;
  transaction_date?: string;
  modified_date?: string;
  confirmed_date?: string;
  reason?: string;
  rejection_reason?: string;
}

interface YieldkitClickRaw {
  id?: number | string;
  click_id?: number | string;
  advertiser_id?: number | string;
  click_date?: string;
  click_time?: string;
  date?: string;
  referrer?: string;
  source?: string;
  url?: string;
  target?: string;
  yk_tag?: string;
}

interface YieldkitReportEnvelope<T> {
  next?: string;
  commissions?: T[];
  clicks?: T[];
  data?: T[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Yieldkit commission status → canonical.
 *
 * Yieldkit reports OPEN | CONFIRMED | REJECTED | DELAYED
 * (https://yieldkit.com/knowledge/commission-terms/):
 *
 *   OPEN / DELAYED  → 'pending'  (not yet confirmed; DELAYED is an open sale
 *                                 awaiting a longer validation window)
 *   CONFIRMED       → 'approved' (validated; will be paid out)
 *   REJECTED        → 'reversed' (the sale did not pay out)
 *   anything else   → 'other'
 *
 * Yieldkit does not expose a distinct "paid" state on the commission row, so we
 * never synthesise 'paid' — by design we never invent a status the user did not
 * see on Yieldkit's side. The raw value is preserved on `rawNetworkData`.
 */
function mapTransactionStatus(raw: YieldkitCommissionRaw): TransactionStatus {
  switch ((raw.status ?? '').toUpperCase()) {
    case 'OPEN':
    case 'DELAYED':
      return 'pending';
    case 'CONFIRMED':
      return 'approved';
    case 'REJECTED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Yieldkit advertiser/offer status → canonical.
 *
 * Yieldkit's catalogue is link-monetisation: a publisher can mint links for any
 * listed advertiser, so an active offer is best mapped to 'joined' (the
 * publisher can transact with it now). We collapse:
 *
 *   active / live / online   → 'joined'
 *   pending                  → 'pending'
 *   rejected / declined      → 'declined'
 *   paused / suspended / offline → 'suspended'
 *   inactive / closed        → 'available'  (listed but not currently transactable)
 *   missing / anything else  → 'joined'     (catalogue offers are transactable by default)
 */
function mapProgrammeStatus(raw: YieldkitAdvertiserRaw): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === '') return 'joined';
  if (s === 'active' || s === 'live' || s === 'online') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'refused') return 'declined';
  if (s === 'paused' || s === 'suspended' || s === 'offline') return 'suspended';
  if (s === 'inactive' || s === 'closed') return 'available';
  return 'joined';
}

/**
 * Compute the age (in days) of a commission at the moment this adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * We anchor on the confirmed/modified date (when Yieldkit last moved the sale)
 * then fall back to the sale date, then the click date. For an OPEN commission
 * a confirmed date is absent, so the sale date carries the age.
 */
function computeAgeDays(raw: YieldkitCommissionRaw, now: Date = new Date()): number {
  const anchor =
    raw.confirmed_date ??
    raw.modified_date ??
    raw.sales_date ??
    raw.sale_date ??
    raw.transaction_date ??
    raw.click_date ??
    raw.click_time;
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

/**
 * Parse a Yieldkit amount into a number in MAJOR currency units. Yieldkit
 * reports decimal strings or numbers; see the file-level amount-unit note.
 */
function toAmount(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Transformers (Yieldkit raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: YieldkitAdvertiserRaw): Programme {
  const id = String(raw.id ?? raw.advertiser_id ?? '');
  const categories =
    raw.categories ?? (typeof raw.category === 'string' ? [raw.category] : undefined);
  return {
    id,
    name: raw.name ?? `Yieldkit advertiser ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    // Yieldkit's commission summary is free-text/structured; surface it as a
    // description so the caller has something without us guessing a percent.
    commissionRate:
      raw.commission !== undefined || raw.payout !== undefined
        ? {
            type: 'unknown',
            description: String(raw.commission ?? raw.payout),
          }
        : undefined,
    categories: (categories ?? []).filter((c): c is string => typeof c === 'string'),
    advertiserUrl: raw.url ?? raw.homepage,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: YieldkitCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission);
  const sale = toAmount(raw.amount);
  const currency = raw.currency ?? 'EUR';

  const saleDate =
    nullableIso(raw.sales_date) ??
    nullableIso(raw.sale_date) ??
    nullableIso(raw.transaction_date) ??
    new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date) ?? nullableIso(raw.click_time);
  const approvedDate = nullableIso(raw.confirmed_date) ?? nullableIso(raw.modified_date);

  return {
    id: String(raw.id ?? raw.commission_id ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiser_id ?? ''),
    programmeName: raw.advertiser_name ?? raw.advertiser ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: saleDate,
    dateApproved: status === 'approved' ? approvedDate : undefined,
    // Yieldkit does not expose a distinct paid-date on the commission row.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — reversed commissions surface a reason where Yieldkit gives one.
    reversalReason:
      status === 'reversed' ? raw.rejection_reason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: YieldkitClickRaw): Click {
  const ts =
    nullableIso(raw.click_date) ??
    nullableIso(raw.click_time) ??
    nullableIso(raw.date) ??
    new Date(0).toISOString();
  return {
    id: String(raw.id ?? raw.click_id ?? ''),
    network: SLUG,
    programmeId: raw.advertiser_id !== undefined ? String(raw.advertiser_id) : undefined,
    timestamp: ts,
    referrer: raw.referrer ?? raw.source,
    destinationUrl: raw.url ?? raw.target,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class YieldkitAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Yieldkit advertiser offers as programmes.
   *
   * Yieldkit is link-monetisation: there is no "joined" relationship to filter
   * on the way Awin has. We fetch the advertiser catalogue and apply the
   * caller's filters (search, status, categories, limit) client-side, since the
   * Advertiser API's server-side filtering is not relied upon here.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    const apiSecret = requireApiSecret('listProgrammes');

    const raw = await yieldkitRequest<YieldkitAdvertisersEnvelope | YieldkitAdvertiserRaw[]>({
      operation: 'listProgrammes',
      path: ADVERTISER_PATH,
      apiKey,
      apiSecret,
      query: { limit: query?.limit },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = extractAdvertisers(raw);
    let programmes = rows.map(toProgramme);

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
   * Fetch a single advertiser/offer by id.
   *
   * The Advertiser API does not expose a per-advertiser endpoint we can rely
   * on, so we fetch the catalogue and select the matching id client-side. An
   * unknown id surfaces as a network_api_error envelope rather than a stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A Yieldkit advertiser id is required.',
          hint: 'List advertisers first (affiliate_yieldkit_list_programmes) to find the id.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');
    const apiSecret = requireApiSecret('getProgramme');

    const raw = await yieldkitRequest<YieldkitAdvertisersEnvelope | YieldkitAdvertiserRaw[]>({
      operation: 'getProgramme',
      path: ADVERTISER_PATH,
      apiKey,
      apiSecret,
      query: { advertiser_id: programmeId },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const rows = extractAdvertisers(raw);
    const match = rows.find(
      (r) => String(r.id ?? r.advertiser_id ?? '') === programmeId,
    );
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Yieldkit returned no advertiser matching id "${programmeId}".`,
          hint: 'Confirm the id via affiliate_yieldkit_list_programmes.',
        }),
      );
    }
    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commissions across a date window.
   *
   * Yieldkit's Reporting API v3 commission endpoint takes `valid_from` /
   * `valid_to` (date-only) and paginates: each page carries a `next` URL until
   * the data is exhausted. We follow `next` up to a sane page cap so a wide
   * window is handled transparently (analogous to Awin's date chunking, but
   * Yieldkit paginates rather than capping the window).
   *
   * Filters (programme, status, age) are applied client-side after the rows are
   * normalised, so `{ status: 'approved', minAgeDays: 180 }` is meaningful
   * (PRD §15.9). Reversed commissions are returned with `reversalReason`
   * populated where Yieldkit provides one (PRD §15.10).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');
    const apiSecret = requireApiSecret('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const allRaw = await this.fetchAllPages<YieldkitCommissionRaw>(
      'listTransactions',
      '/v3/report/commission',
      apiKey,
      apiSecret,
      {
        valid_from: toDateOnly(from),
        valid_to: toDateOnly(to),
      },
      RESILIENCE.listTransactions ?? RESILIENCE.default,
      (env) => env.commissions ?? env.data ?? [],
    );

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
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate commissions into an earnings summary, derived from
   * listTransactions so the user can reproduce the numbers themselves (see
   * Awin's getEarningsSummary for the full rationale).
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
      currency: 'EUR',
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
          programmeName: t.programmeName || `Yieldkit advertiser ${key}`,
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
   * List click-level rows from the Reporting API v3 click endpoint.
   *
   * Unlike Awin (which does not expose clicks), Yieldkit's Reporting API has a
   * dedicated click report, so this is a real implementation. It paginates the
   * same way the commission report does (`next` URL per page).
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const apiKey = requireApiKey('listClicks');
    const apiSecret = requireApiSecret('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const allRaw = await this.fetchAllPages<YieldkitClickRaw>(
      'listClicks',
      '/v3/report/click',
      apiKey,
      apiSecret,
      {
        valid_from: toDateOnly(from),
        valid_to: toDateOnly(to),
      },
      RESILIENCE.listClicks ?? RESILIENCE.default,
      (env) => env.clicks ?? env.data ?? [],
    );

    let clicks = allRaw.map(toClick);

    if (query?.programmeId) {
      clicks = clicks.filter((c) => c.programmeId === query.programmeId);
    }
    if (typeof query?.limit === 'number') {
      clicks = clicks.slice(0, query.limit);
    }

    return clicks;
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Yieldkit monetised redirect/deeplink.
   *
   * Format (documented; deterministic, no API round-trip needed):
   *   https://r.srvtrck.com/v1/redirect
   *     ?url={destinationUrl, URL-encoded}
   *     &api_key={apiKey}
   *     &type=url
   *   Source: https://yieldkit.com/knowledge/redirect-api/
   *
   * Yieldkit monetises by destination URL, not by advertiser id: the redirect
   * service resolves the destination to the best-performing advertiser at click
   * time. `programmeId` is therefore NOT part of the link and is optional on
   * this call — we accept it for the shared contract and echo it back, but a
   * missing programmeId is not an error here (it would be for Awin).
   *
   * We require the credentials to be configured (sanity check) so a user with a
   * half-configured environment learns at link-generation time, not first click.
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
          hint: 'Pass the full URL of the merchant page you want to monetise.',
        }),
      );
    }

    const apiKey = requireApiKey('generateTrackingLink');
    // Confirm the secret is configured too, even though the redirect link only
    // embeds the key — so a half-configured environment fails here, not later.
    requireApiSecret('generateTrackingLink');

    const url = new URL('/v1/redirect', YIELDKIT_REDIRECT_BASE_URL);
    url.searchParams.set('url', input.destinationUrl);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('type', 'url');

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl: url.toString(),
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'r.srvtrck.com/v1/redirect deterministic construction',
        type: 'url',
        url: input.destinationUrl,
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
        operations[name] = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize,
        };
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic redirect URL construction; no live probe.',
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

  // -------------------------------------------------------------------------
  // Internal: paginated report fetch
  // -------------------------------------------------------------------------

  /**
   * Follow Yieldkit's Reporting API v3 pagination. Each page carries a `next`
   * URL; we follow it until it is absent or a page cap is reached. The cap
   * (50 pages) bounds wall-clock time for an over-broad window — the resilience
   * layer still applies per page.
   */
  private async fetchAllPages<T>(
    operation: string,
    path: string,
    apiKey: string,
    apiSecret: string,
    query: Record<string, string | number | undefined>,
    resilience: ResilienceConfig,
    extract: (env: YieldkitReportEnvelope<T>) => T[],
  ): Promise<T[]> {
    const out: T[] = [];
    const MAX_PAGES = 50;
    let page = 1;

    while (page <= MAX_PAGES) {
      const env = await yieldkitRequest<YieldkitReportEnvelope<T> | T[]>({
        operation,
        path,
        apiKey,
        apiSecret,
        query: { ...query, page },
        resilience,
      });

      if (Array.isArray(env)) {
        out.push(...env);
        break;
      }

      const rows = extract(env);
      out.push(...rows);

      // Pagination stops when there is no `next` URL or the page came back empty.
      if (!env.next || rows.length === 0) break;
      page += 1;
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin's adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const yieldkitAdapter = new YieldkitAdapter();
registerAdapter(yieldkitAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function extractAdvertisers(
  raw: YieldkitAdvertisersEnvelope | YieldkitAdvertiserRaw[],
): YieldkitAdvertiserRaw[] {
  if (Array.isArray(raw)) return raw;
  return raw.advertisers ?? raw.offers ?? raw.data ?? [];
}

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

/** Format a Date as a `YYYY-MM-DD` date-only string for the Reporting API. */
function toDateOnly(d: Date): string {
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toClick,
  toAmount,
  toDateOnly,
  extractAdvertisers,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
