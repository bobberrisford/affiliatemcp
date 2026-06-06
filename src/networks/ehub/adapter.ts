/**
 * eHUB adapter — publisher side, single-brand.
 *
 * eHUB (https://ehub.cz) is a CZ/CEE affiliate network. This adapter integrates
 * the publisher side of eHUB's REST API v3. It is patterned directly on the
 * Awin reference (`src/networks/awin/adapter.ts`); read that file first for the
 * full reasoning behind the structure, status normalisation, and the
 * `rawNetworkData` discipline.
 *
 * --- Cardinal rules (see Awin's header) ------------------------------------
 *   1. Never call `fetch` directly. Use `ehubRequest` from `./client.ts`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve the raw response in `rawNetworkData`.
 *   4. Normalise status enums; prefer 'unknown'/'other' over a wrong guess.
 *   5. Compute `ageDays` for every transaction.
 *   6. UK English; the user-visible noun is "programme".
 *
 * --- eHUB API v3 map (verify against the docs) -----------------------------
 *
 *   Docs:  https://ehub.docs.apiary.io/  and  https://ehubv3.docs.apiary.io/
 *   Base:  https://api.ehub.cz/v3
 *   Auth:  `apiKey` query parameter (custom; not a header at v3).
 *
 *   GET /campaigns
 *     → programmes/campaigns the publisher can work with. Envelope:
 *       `{ code, campaigns: [...] }`. Pagination via `page` + `perPage`
 *       (max 100). Used by listProgrammes/getProgramme and by verifyAuth.
 *   GET /transactions
 *     ?status=pending|approved|declined &type=lead|sale|impression
 *     &dateFrom=YYYY-MM-DD &dateTo=YYYY-MM-DD &perPage=100 &page=N
 *     → transactions. Envelope: `{ code, transactions: [...] }`. Amounts
 *       (`totalCost`, `commission`) are decimal numbers in the campaign
 *       currency (CZK by default for eHUB merchants). Confirmed against the
 *       public `transactions-approver` sample and the v3 publisher docs.
 *   GET /clicks
 *     ?dateFrom &dateTo &perPage &page
 *     → click-level rows. Envelope: `{ code, clicks: [...] }`.
 *   GET /coupons
 *     → discount coupons (JSON export). Not part of the canonical seven ops.
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * eHUB exposes monetary fields (`totalCost`, `commission`) as decimal MAJOR
 * units (e.g. 199.00 CZK), not minor units (haléř/cents). This matches the
 * order-value semantics described in eHUB's publisher docs. If a live account
 * shows amounts off by 100x, this assumption is the place to revisit. Recorded
 * in `network.json` known_limitations.
 */

import { ehubRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, EHUB_SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('ehub.adapter');

const SLUG = EHUB_SLUG;
const NAME = 'eHUB';

/** eHUB merchant default currency. eHUB is a CZ/CEE network; order values are
 *  recorded in CZK. Used only as a fallback when a row omits its currency. */
const DEFAULT_CURRENCY = 'CZK';

/** eHUB caps a single list page at 100 rows (`perPage`). */
const MAX_PER_PAGE = 100;

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.ehub.cz/v3',
  // `custom`: eHUB authenticates via an `apiKey` query parameter, not a
  // standard Authorization header.
  authModel: 'custom',
  docsUrl: 'https://ehub.docs.apiary.io/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: implemented from public API docs, not yet validated against
  // a live eHUB account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'Monetary amounts (totalCost, commission) are assumed to be major currency units (e.g. CZK), not minor units; revisit if live data is off by 100x.',
    'generateTrackingLink treats the supplied programmeId as the eHUB creative/banner id (a_bid) and requires EHUB_PUBLISHER_ID (a_aid).',
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

/**
 * listTransactions can page through many rows for an active publisher, so it
 * gets a longer timeout and one extra retry — the same reasoning as Awin.
 */
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
// eHUB response shapes (deliberately minimal; never trusted)
// ---------------------------------------------------------------------------

interface EhubCampaignRaw {
  id?: number | string;
  name?: string;
  // eHUB exposes the publisher's relationship/approval state under varying
  // keys across the docs; we read the common ones defensively.
  status?: string;
  state?: string;
  approved?: boolean;
  currency?: string;
  category?: string;
  categories?: string[];
  url?: string;
  webUrl?: string;
  // Commission can be a percentage and/or a fixed amount depending on the
  // campaign's commission model.
  commission?: string | number;
  provision?: string | number;
}

interface EhubTransactionRaw {
  id?: number | string;
  campaignId?: number | string;
  campaignName?: string;
  orderId?: string;
  // pending | approved | declined | pre-approved (and possibly others).
  status?: string;
  // sale | lead | impression.
  type?: string;
  // Order value and publisher commission, decimal major units.
  totalCost?: number | string;
  commission?: number | string;
  currency?: string;
  // eHUB timestamps. Field names vary; we read the common ones.
  dateInsert?: string;
  dateApproved?: string;
  datePaid?: string;
  clickDate?: string;
  // Reason populated when a transaction is declined.
  declineReason?: string;
  reason?: string;
  canChangeStatus?: boolean;
}

interface EhubClickRaw {
  id?: number | string;
  campaignId?: number | string;
  // eHUB click timestamps and referrer/destination keys vary; read common ones.
  date?: string;
  dateInsert?: string;
  referer?: string;
  referrer?: string;
  url?: string;
  destination?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: eHUB → canonical TransactionStatus.
 *
 * eHUB documents these transaction statuses (publisher side):
 *   pending      → 'pending'  (not yet decided)
 *   pre-approved → 'pending'  (provisionally accepted but not yet invoiced;
 *                              the money is not yet payable, so 'pending' is the
 *                              honest canonical bucket)
 *   approved     → 'approved' (approved and invoiced; payout requestable)
 *   declined     → 'reversed' (advertiser cancelled/returned; no payout — every
 *                              other network in this repo calls this 'reversed')
 *
 * eHUB exposes a paid date but not a distinct "paid" status string on the
 * transaction; we derive 'paid' from a populated `datePaid`. Anything we do not
 * recognise maps to 'other' — we never invent a status the user did not see.
 */
function mapTransactionStatus(raw: EhubTransactionRaw): TransactionStatus {
  if (raw.datePaid && String(raw.datePaid).trim() !== '') return 'paid';
  const s = (raw.status ?? '').toString().toLowerCase().replace(/[\s_]+/g, '-');
  switch (s) {
    case 'pending':
    case 'pre-approved':
    case 'preapproved':
      return 'pending';
    case 'approved':
    case 'accepted':
      return 'approved';
    case 'declined':
    case 'rejected':
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: eHUB campaign relationship → canonical ProgrammeStatus.
 *
 * eHUB's approval model: a publisher is approved, pending, or rejected for a
 * campaign; campaigns the publisher has not joined are 'available'. The exact
 * key varies, so we read `status`/`state` plus the boolean `approved` flag and
 * collapse to our enum. Unknown values map to 'unknown' rather than guessing.
 */
function mapProgrammeStatus(raw: EhubCampaignRaw): ProgrammeStatus {
  if (raw.approved === true) return 'joined';
  const s = (raw.status ?? raw.state ?? '').toString().toLowerCase().replace(/[\s_]+/g, '-');
  if (s === 'approved' || s === 'active' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'waiting' || s === 'pre-approved') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'notjoined' || s === 'not-joined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/** Coerce eHUB's numeric-or-string amount fields to a number; default 0. */
function toAmount(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // eHUB may format with a comma decimal separator in some locales.
    const n = Number(v.replace(',', '.').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Compute the age (in days) of a transaction. We anchor on the approval date
 * then the conversion (insert) date — the same precedence as Awin's
 * validationDate-then-transactionDate, so the unpaid-age affordance (PRD §15.9)
 * behaves consistently across networks.
 */
function computeAgeDays(raw: EhubTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.dateApproved ?? raw.dateInsert;
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

function toDateOnly(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transformers (eHUB raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: EhubCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  const commission = raw.commission ?? raw.provision;
  return {
    id,
    name: raw.name ?? `eHUB campaign ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate:
      commission !== undefined
        ? { type: 'unknown', description: String(commission) }
        : undefined,
    categories: raw.categories ?? (raw.category ? [raw.category] : []),
    advertiserUrl: raw.url ?? raw.webUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: EhubTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission);
  const sale = toAmount(raw.totalCost);
  const currency = raw.currency ?? DEFAULT_CURRENCY;

  const dateConverted = nullableIso(raw.dateInsert) ?? new Date(0).toISOString();

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaignId ?? ''),
    programmeName: raw.campaignName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: nullableIso(raw.clickDate),
    dateConverted,
    dateApproved: nullableIso(raw.dateApproved),
    datePaid: nullableIso(raw.datePaid),
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — reversed transactions surface a reason where eHUB provides
    // one. The key varies, so read both.
    reversalReason:
      status === 'reversed' ? raw.declineReason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: EhubClickRaw): Click {
  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: raw.campaignId !== undefined ? String(raw.campaignId) : undefined,
    timestamp: nullableIso(raw.date ?? raw.dateInsert) ?? new Date(0).toISOString(),
    referrer: raw.referer ?? raw.referrer,
    destinationUrl: raw.url ?? raw.destination,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EhubAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List eHUB campaigns (programmes) the publisher can work with.
   *
   * eHUB's `GET /campaigns` returns an envelope `{ code, campaigns: [...] }`.
   * The endpoint does not document a free-text search filter, so search/status/
   * category/limit filters are applied client-side — the same pattern as Awin.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = this.requireApiKey('listProgrammes');

    const response = await ehubRequest<{ campaigns?: EhubCampaignRaw[] } | EhubCampaignRaw[]>({
      operation: 'listProgrammes',
      path: '/campaigns',
      apiKey,
      query: { perPage: MAX_PER_PAGE },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = Array.isArray(response) ? response : response.campaigns ?? [];
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
   * Fetch a single campaign by id.
   *
   * eHUB exposes campaign detail at `GET /campaigns/{id}`. The response is a
   * single object, optionally wrapped in a `campaign` key; we unwrap defensively.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'An eHUB campaign id is required.',
          hint: 'List campaigns first (affiliate_ehub_list_programmes) to find the correct id.',
        }),
      );
    }

    const apiKey = this.requireApiKey('getProgramme');

    const raw = await ehubRequest<EhubCampaignRaw | { campaign?: EhubCampaignRaw }>({
      operation: 'getProgramme',
      path: `/campaigns/${encodeURIComponent(programmeId)}`,
      apiKey,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const flat = (raw as { campaign?: EhubCampaignRaw })?.campaign ?? (raw as EhubCampaignRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions across a date window with optional status / age /
   * programme filters.
   *
   * eHUB endpoint: `GET /transactions?status=&type=&dateFrom=&dateTo=&perPage=&page=`.
   * Response envelope: `{ code, transactions: [...] }`. Dates are `YYYY-MM-DD`.
   *
   * Pagination: eHUB caps a page at 100 rows (`perPage`). We page through with
   * `page` until a short page is returned, so a caller asking for a wide window
   * gets the full set rather than the first 100. This is the eHUB analogue of
   * Awin's date chunking — eHUB does not document a max window, so we page on
   * count rather than slicing dates.
   *
   * Status/type are pushed server-side where the caller's filter maps cleanly
   * to a single eHUB value; otherwise we fetch unfiltered and filter in-process.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = this.requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const statusFilter = toTransactionStatusList(query?.status);
    // Only push status server-side when the caller asked for exactly one
    // canonical status that maps to a single eHUB status string.
    const onlyStatus =
      statusFilter && statusFilter.length === 1 ? statusFilter[0] : undefined;
    const serverStatus = onlyStatus ? canonicalToEhubStatus(onlyStatus) : undefined;

    const allRaw: EhubTransactionRaw[] = [];
    let page = 1;
    // Hard cap on pages to avoid an unbounded loop if the API never short-pages.
    const MAX_PAGES = 200;
    for (; page <= MAX_PAGES; page += 1) {
      const response = await ehubRequest<
        { transactions?: EhubTransactionRaw[] } | EhubTransactionRaw[]
      >({
        operation: 'listTransactions',
        path: '/transactions',
        apiKey,
        query: {
          dateFrom: toDateOnly(from),
          dateTo: toDateOnly(to),
          status: serverStatus,
          perPage: MAX_PER_PAGE,
          page,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const rows = Array.isArray(response) ? response : response.transactions ?? [];
      allRaw.push(...rows);
      if (rows.length < MAX_PER_PAGE) break;
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Status filter (client-side; also covers multi-status queries that were
    // not pushed server-side).
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9 — applied after status filtering.
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
   * Aggregate transactions into an earnings summary. Derived from
   * `listTransactions` (not a separate report endpoint) so the user can
   * reproduce the numbers — the same reasoning as Awin's getEarningsSummary.
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
      currency: DEFAULT_CURRENCY,
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
          programmeName: t.programmeName || `eHUB campaign ${key}`,
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
      currency: firstCurrency ?? DEFAULT_CURRENCY,
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
   * List click-level rows.
   *
   * eHUB DOES expose click data (its statistics split into Transactions,
   * Clicks, and Reports), so this is a real implementation rather than a
   * NotImplementedError stub. Endpoint: `GET /clicks?dateFrom=&dateTo=&perPage=
   * &page=`, envelope `{ code, clicks: [...] }`.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const apiKey = this.requireApiKey('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const allRaw: EhubClickRaw[] = [];
    let page = 1;
    const MAX_PAGES = 200;
    for (; page <= MAX_PAGES; page += 1) {
      const response = await ehubRequest<{ clicks?: EhubClickRaw[] } | EhubClickRaw[]>({
        operation: 'listClicks',
        path: '/clicks',
        apiKey,
        query: {
          dateFrom: toDateOnly(from),
          dateTo: toDateOnly(to),
          perPage: MAX_PER_PAGE,
          page,
        },
        resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
      });
      const rows = Array.isArray(response) ? response : response.clicks ?? [];
      allRaw.push(...rows);
      if (rows.length < MAX_PER_PAGE) break;
    }

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
   * Construct an eHUB tracking (deep) link deterministically.
   *
   * eHUB's documented click URL format is:
   *
   *   https://ehub.cz/system/scripts/click.php
   *     ?a_aid={publisherId}    (the publisher's a_aid, from EHUB_PUBLISHER_ID)
   *     &a_bid={creativeId}     (a creative/banner id within a campaign)
   *     &desturl={destinationUrl, URL-encoded}   (deeplink target, optional)
   *
   * Why deterministic construction (no API call): the scheme is documented and
   * stable; an API round-trip would add latency and a failure mode for no
   * benefit — the same reasoning as Awin's cread.php construction.
   *
   * NOTE on `programmeId`: eHUB's link parameter is `a_bid`, a creative/banner
   * id rather than the campaign id itself. We treat the caller-supplied
   * `programmeId` as that `a_bid` value and document the mapping in
   * `known_limitations`. The publisher's `a_aid` is read from EHUB_PUBLISHER_ID.
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
          message: 'eHUB tracking links require a creative/banner id (a_bid).',
          hint:
            'Pass `programmeId` set to the eHUB creative (a_bid) you want to link with. ' +
            'Find creatives in the eHUB dashboard for the campaign.',
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

    const publisherId = requireCredential('EHUB_PUBLISHER_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint:
        'Set EHUB_PUBLISHER_ID to your eHUB a_aid (shown in your profile and in your tracking links). ' +
        'Run `affiliate-networks-mcp setup ehub` to configure it.',
    });

    // Require the API key to be configured so a half-configured environment is
    // caught at link-generation time, not first-click time.
    this.requireApiKey('generateTrackingLink');

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://ehub.cz/system/scripts/click.php` +
      `?a_aid=${encodeURIComponent(publisherId)}` +
      `&a_bid=${encodeURIComponent(input.programmeId)}` +
      `&desturl=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'ehub.cz/system/scripts/click.php deterministic construction',
        a_aid: publisherId,
        a_bid: input.programmeId,
        desturl: input.destinationUrl,
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

    const probe = async (name: string, fn: () => Promise<unknown>, note?: string): Promise<void> => {
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction; no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known campaign id; not probed automatically.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Credential helper
  // -------------------------------------------------------------------------

  private requireApiKey(operation: string): string {
    return requireCredential('EHUB_API_KEY', {
      network: SLUG,
      operation,
      hint: 'Generate an API key in the eHUB dashboard under your profile / API settings.',
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin for the aggregator-import rationale)
// ---------------------------------------------------------------------------

export const ehubAdapter = new EhubAdapter();
registerAdapter(ehubAdapter);

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
 * Map a single canonical TransactionStatus to the eHUB status string we can
 * push server-side. Returns undefined when the canonical status has no clean
 * 1:1 eHUB equivalent (e.g. 'paid' is derived from a date, not a status; and
 * 'pending' covers both eHUB 'pending' and 'pre-approved', so we filter those
 * client-side rather than push a single value that would drop the other).
 */
function canonicalToEhubStatus(s: TransactionStatus): string | undefined {
  switch (s) {
    case 'approved':
      return 'approved';
    case 'reversed':
      return 'declined';
    default:
      return undefined;
  }
}

// Internal test helpers — exported under `_internals` so they stay off the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toAmount,
  toTransaction,
  toProgramme,
  toClick,
  canonicalToEhubStatus,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
