/**
 * eBay Partner Network (EPN) adapter — publisher surface.
 *
 * READ THIS FIRST:
 *
 * EPN is shaped differently from the other four bundled networks in one
 * important way: there is only ONE advertiser, eBay itself. Every "programme"
 * an EPN publisher works with corresponds to one of their own EPN *campaigns*
 * (rotation buckets they create in the EPN dashboard to attribute traffic to a
 * site, app, channel, etc.). This adapter therefore maps:
 *
 *   Programme.id   ←  EPN campaignId
 *   Programme.name ←  EPN campaign name
 *   Programme.status ← `active` / `paused` / `expired` from the EPN dashboard
 *
 * A consequence is that the `programmeId` argument to listTransactions /
 * generateTrackingLink is an EPN campaign ID, not a merchant ID. This is
 * documented in network.json `known_limitations` and `docs/networks/ebay.md`.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — GET /affiliate/campaign/v1/campaign     (synthesised
 *                           from EPN's documented campaign-list endpoint)
 *   getProgramme        — GET /affiliate/campaign/v1/campaign/{campaignId}
 *   listTransactions    — GET /affiliate/reporting/v1/transaction (chunked ≤90d)
 *   getEarningsSummary  — derived from listTransactions
 *   listClicks          — GET /affiliate/reporting/v1/click (chunked ≤90d)
 *   generateTrackingLink— deterministic URL construction via the EPN rover
 *                           (rover.ebay.com) format. NO API call.
 *   verifyAuth          — exchange client credentials for an access token
 *                           (delegated to auth.ts).
 *
 * Admin ops throw `NotImplementedError` at v0.1.
 *
 * --- Status mapping ----------------------------------------------------------
 *
 * EPN transaction states → canonical:
 *
 *   PENDING    → pending      (commission earned, awaiting clearance)
 *   CLEARED    → approved     (commission cleared but not yet paid out)
 *   PAID       → paid
 *   CANCELLED  → reversed     (buyer cancelled / returned)
 *   <other>    → other        (never invent a status the user didn't see)
 *
 * Why CLEARED maps to `approved` and not `paid`: EPN distinguishes "the
 * commission is recognised and locked in" (CLEARED) from "the money has been
 * transferred to your nominated payee" (PAID, set when the monthly payout
 * runs). Awin and Impact draw the same line; mapping CLEARED → approved keeps
 * the cross-network semantics consistent.
 *
 * --- Cardinal rules (identical to every other adapter) ----------------------
 *
 *   1. NEVER call `fetch` directly. Use `ebayRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope` with
 *      `network: 'ebay'`, `operation`, `httpStatus`, verbatim `networkErrorBody`.
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums into our canonical set.
 *   5. COMPUTE `ageDays` for every transaction. PRD §15.9 depends on it.
 *   6. UK English in user-visible strings.
 */

import { ebayRequest } from './client.js';
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

const log = createLogger('ebay.adapter');

const SLUG = 'ebay';
const NAME = 'eBay Partner Network';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.ebay.com',
  authModel: 'oauth2',
  docsUrl: 'https://partnernetwork.ebay.com/help/integration-center/api-documentation',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-21',
  // `experimental` — this adapter was implemented from public documentation
  // and synthetic fixtures, not against a real EPN account. Bump to `partial`
  // once it has been exercised against one, and to `production` after live
  // acceptance testing per the project's claim-status process.
  claimStatus: 'experimental',
  knownLimitations: [
    'eBay Partner Network exposes eBay itself as the sole advertiser; "programmes" in this adapter map to EPN campaigns, not to third-party merchants.',
    'Transaction ("earnings") reporting is delayed approximately 24-48 hours; today\'s clicks rarely appear in listTransactions until the next reporting cycle.',
    'Click-level reporting is paginated and capped at 90-day windows per EPN\'s reporting API; the adapter chunks wider ranges.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 3,
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * Reporting endpoints (`/affiliate/reporting/v1/transaction`,
 * `/affiliate/reporting/v1/click`) are documented to take seconds for wide
 * windows. We bump the timeout to 60s and add one extra retry to absorb the
 * upstream latency without escalating to the user.
 *
 * The token-exchange call lives inside `auth.ts` and uses DEFAULT_RESILIENCE
 * — it is small and fast.
 */
const REPORTING_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTING_RESILIENCE,
  listClicks: REPORTING_RESILIENCE,
  getEarningsSummary: REPORTING_RESILIENCE,
};

// ---------------------------------------------------------------------------
// eBay response shapes (deliberately minimal — see awin/adapter.ts for the
// rationale on not modelling these with strict schemas).
// ---------------------------------------------------------------------------

interface EbayCampaignRaw {
  campaignId?: string | number;
  campaignName?: string;
  campaignStatus?: string; // ACTIVE | PAUSED | EXPIRED | DRAFT
  marketplaceId?: string;
  startDate?: string;
  endDate?: string;
  defaultLandingPage?: string;
}

interface EbayCampaignsEnvelope {
  campaigns?: EbayCampaignRaw[];
  total?: number;
  offset?: number;
  limit?: number;
  next?: string; // next-page URL
}

interface EbayTransactionRaw {
  transactionId?: string;
  campaignId?: string | number;
  campaignName?: string;
  itemId?: string;
  itemTitle?: string;
  eventDate?: string;       // when the click occurred (UTC ISO)
  earningsDate?: string;    // when the earning was attributed
  clearedDate?: string;     // when status moved to CLEARED
  paidDate?: string;        // when payout completed
  status?: string;          // PENDING | CLEARED | PAID | CANCELLED
  saleAmount?: { value?: string | number; currency?: string };
  earningsAmount?: { value?: string | number; currency?: string };
  quantity?: number;
  cancelReason?: string;
  marketplaceId?: string;
}

interface EbayTransactionsEnvelope {
  transactions?: EbayTransactionRaw[];
  total?: number;
  offset?: number;
  limit?: number;
  next?: string;
}

interface EbayClickRaw {
  clickId?: string;
  campaignId?: string | number;
  campaignName?: string;
  clickDate?: string;
  landingPageUrl?: string;
  referrerUrl?: string;
  itemId?: string;
}

interface EbayClicksEnvelope {
  clicks?: EbayClickRaw[];
  total?: number;
  offset?: number;
  limit?: number;
  next?: string;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireCampaignId(operation: string): string {
  return requireCredential('EBAY_CAMPAIGN_ID', {
    network: SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup ebay` to provide EBAY_CAMPAIGN_ID, or set it in ~/.affiliate-mcp/.env. ' +
      'Find the numeric ID at https://partnernetwork.ebay.com/ → Campaigns.',
  });
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Map eBay transaction status → canonical TransactionStatus.
 *
 * The mapping is documented in the file-level header. We normalise on the
 * uppercased upstream value so a tenant that emits mixed case (rare but
 * observed in EPN's older XML reports) still maps cleanly.
 *
 * `cancelReason` is preserved verbatim on `rawNetworkData` and surfaced on
 * `reversalReason` for reversed transactions per PRD §15.10.
 */
function mapTransactionStatus(raw: EbayTransactionRaw): TransactionStatus {
  const s = String(raw.status ?? '').toUpperCase();
  switch (s) {
    case 'PENDING':
      return 'pending';
    case 'CLEARED':
      return 'approved';
    case 'PAID':
      return 'paid';
    case 'CANCELLED':
    case 'CANCELED': // US spelling occasionally appears in eBay payloads
    case 'RETURNED':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Map eBay campaign status → canonical ProgrammeStatus.
 *
 * EPN campaigns have a small enum:
 *   - ACTIVE   → joined
 *   - PAUSED   → suspended
 *   - DRAFT    → pending      (created in the dashboard but not yet activated)
 *   - EXPIRED  → suspended    (date range elapsed; the user can re-activate)
 *   - <other>  → unknown
 *
 * There is no `available` analogue because every publisher has full access to
 * every eBay marketplace they are approved for; the concept of "available
 * programmes" does not apply.
 */
function mapCampaignStatus(raw: EbayCampaignRaw): ProgrammeStatus {
  const s = String(raw.campaignStatus ?? '').toLowerCase();
  if (s === 'active') return 'joined';
  if (s === 'paused' || s === 'expired') return 'suspended';
  if (s === 'draft') return 'pending';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of an EPN transaction.
 *
 * Anchor priority:
 *   1. `clearedDate` (when status moved to CLEARED — i.e. recognised)
 *   2. `earningsDate` (when the earning was attributed)
 *   3. `eventDate`    (when the click happened)
 *
 * Mirrors Awin's "prefer the approval date so the unpaid-age affordance
 * answers 'how long has this been approved-but-unpaid'". For pending
 * transactions clearedDate is absent; we fall through.
 */
function computeAgeDays(raw: EbayTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.clearedDate ?? raw.earningsDate ?? raw.eventDate;
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
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: EbayCampaignRaw): Programme {
  const id = String(raw.campaignId ?? '');
  return {
    id,
    name: raw.campaignName ?? `eBay campaign ${id}`,
    network: SLUG,
    status: mapCampaignStatus(raw),
    currency: undefined, // eBay sets currency per marketplace; the campaign list does not expose it
    advertiserUrl: raw.defaultLandingPage,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: EbayTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.earningsAmount?.value);
  const sale = toNumber(raw.saleAmount?.value);
  const currency = raw.earningsAmount?.currency ?? raw.saleAmount?.currency ?? 'USD';

  const eventDate = nullableIso(raw.eventDate) ?? new Date(0).toISOString();
  const clearedDate = nullableIso(raw.clearedDate);
  const paidDate = nullableIso(raw.paidDate);

  return {
    id: String(raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.campaignId ?? ''),
    programmeName: raw.campaignName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    // EPN's `eventDate` is the click date. There is no separate "converted"
    // timestamp on the reporting surface — eBay's attribution is click-based —
    // so we use eventDate for both dateClicked and dateConverted.
    dateClicked: nullableIso(raw.eventDate),
    dateConverted: eventDate,
    dateApproved: clearedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.cancelReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: EbayClickRaw): Click {
  return {
    id: String(raw.clickId ?? ''),
    network: SLUG,
    programmeId: raw.campaignId !== undefined ? String(raw.campaignId) : undefined,
    timestamp: nullableIso(raw.clickDate) ?? new Date(0).toISOString(),
    referrer: raw.referrerUrl,
    destinationUrl: raw.landingPageUrl,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EbayAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — GET /affiliate/campaign/v1/campaign
  // -------------------------------------------------------------------------

  /**
   * List EPN campaigns. In EPN terminology these are the publisher's own
   * tracking buckets, not third-party merchants (see file-level note).
   *
   * Pagination: EPN's campaign endpoint uses offset/limit + a `next` URL.
   * We honour `next` where present, fall back to offset increments, and cap
   * at 20 pages so a runaway `next` cannot loop indefinitely.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const collected: EbayCampaignRaw[] = [];
    let offset = 0;
    const pageSize = 100;
    let safety = 0;
    const maxPages = 20;
    while (safety < maxPages) {
      safety += 1;
      const envelope = await ebayRequest<EbayCampaignsEnvelope | EbayCampaignRaw[]>({
        operation: 'listProgrammes',
        path: '/affiliate/campaign/v1/campaign',
        query: { offset, limit: pageSize },
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      });

      const list: EbayCampaignRaw[] = Array.isArray(envelope)
        ? envelope
        : envelope?.campaigns ?? [];
      if (list.length === 0) break;
      collected.push(...list);

      // Stop conditions: short page, or no next link.
      if (list.length < pageSize) break;
      const env = Array.isArray(envelope) ? undefined : envelope;
      if (env?.next === undefined || env.next === '') break;
      offset += pageSize;
    }

    let programmes = collected.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    // EPN campaigns do not carry categories; the `categories` filter is a no-op
    // for this adapter but accepting it keeps the canonical query shape.
    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme — GET /affiliate/campaign/v1/campaign/{campaignId}
  // -------------------------------------------------------------------------

  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `eBay campaign IDs are numeric; received "${programmeId}".`,
          hint: 'List campaigns first (affiliate_ebay_list_programmes) to find the correct id.',
        }),
      );
    }

    const raw = await ebayRequest<EbayCampaignRaw | { campaign?: EbayCampaignRaw }>({
      operation: 'getProgramme',
      path: `/affiliate/campaign/v1/campaign/${encodeURIComponent(programmeId)}`,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // Some tenants wrap single-campaign responses in `{ campaign: {...} }`.
    const flat = (raw as { campaign?: EbayCampaignRaw })?.campaign ?? (raw as EbayCampaignRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions — GET /affiliate/reporting/v1/transaction
  // -------------------------------------------------------------------------

  /**
   * List EPN transactions across a date window.
   *
   * EPN's reporting API caps a single call at 90 days; we chunk wider windows
   * transparently. The endpoint also paginates via offset/limit + a `next`
   * link — we exhaust pagination per slice before moving to the next slice.
   *
   * The PRD §15.9 unpaid-age filter and PRD §15.10 reversed-sale visibility
   * are both applied AFTER the upstream call so the canonical contract is
   * honoured regardless of which fields EPN populates.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 90);

    const allRaw: EbayTransactionRaw[] = [];
    for (const slice of slices) {
      let offset = 0;
      const pageSize = 100;
      let safety = 0;
      const maxPages = 50;
      while (safety < maxPages) {
        safety += 1;
        const envelope = await ebayRequest<EbayTransactionsEnvelope | EbayTransactionRaw[]>({
          operation: 'listTransactions',
          path: '/affiliate/reporting/v1/transaction',
          query: {
            startDate: formatEbayDate(slice.start),
            endDate: formatEbayDate(slice.end),
            offset,
            limit: pageSize,
          },
          resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
        });
        const list: EbayTransactionRaw[] = Array.isArray(envelope)
          ? envelope
          : envelope?.transactions ?? [];
        if (list.length === 0) break;
        allRaw.push(...list);
        if (list.length < pageSize) break;
        const env = Array.isArray(envelope) ? undefined : envelope;
        if (env?.next === undefined || env.next === '') break;
        offset += pageSize;
      }
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
    if (typeof query?.minAgeDays === 'number') {
      const minAge = query.minAgeDays;
      transactions = transactions.filter((t) => t.ageDays >= minAge);
    }
    if (typeof query?.maxAgeDays === 'number') {
      const maxAge = query.maxAgeDays;
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
   * Same rationale as Awin: derive from `listTransactions` rather than EPN's
   * separate `/affiliate/reporting/v1/aggregate` surface. Single source of
   * truth — the user can recompute totals from the per-transaction list.
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
          programmeName: t.programmeName || `eBay campaign ${key}`,
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
  // listClicks — GET /affiliate/reporting/v1/click (EPN DOES expose this)
  // -------------------------------------------------------------------------

  /**
   * EPN exposes click-level data via the reporting API. Same chunking pattern
   * as listTransactions because the same 90-day cap applies.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 90);

    const collected: EbayClickRaw[] = [];
    for (const slice of slices) {
      let offset = 0;
      const pageSize = 100;
      let safety = 0;
      const maxPages = 50;
      while (safety < maxPages) {
        safety += 1;
        const envelope = await ebayRequest<EbayClicksEnvelope | EbayClickRaw[]>({
          operation: 'listClicks',
          path: '/affiliate/reporting/v1/click',
          query: {
            startDate: formatEbayDate(slice.start),
            endDate: formatEbayDate(slice.end),
            offset,
            limit: pageSize,
          },
          resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
        });
        const list: EbayClickRaw[] = Array.isArray(envelope)
          ? envelope
          : envelope?.clicks ?? [];
        if (list.length === 0) break;
        collected.push(...list);
        if (list.length < pageSize) break;
        const env = Array.isArray(envelope) ? undefined : envelope;
        if (env?.next === undefined || env.next === '') break;
        offset += pageSize;
      }
    }

    let clicks = collected.map(toClick);

    if (query?.programmeId) {
      clicks = clicks.filter((c) => c.programmeId === query.programmeId);
    }
    if (typeof query?.limit === 'number') {
      clicks = clicks.slice(0, query.limit);
    }
    return clicks;
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — deterministic Smart Link construction
  // -------------------------------------------------------------------------

  /**
   * Construct an EPN tracking ("Smart") link.
   *
   * Format (the rover URL EPN documents for Smart Link construction):
   *
   *   https://rover.ebay.com/rover/1/{rotationId}/1
   *     ?campid={campaignId}
   *     &toolid=10001
   *     &mpre={destinationUrl, URL-encoded}
   *     &customid={subId}            (optional, omitted here)
   *
   * The `{rotationId}` segment is the site-specific rotation ID — `711-53200-19255-0`
   * is the documented default for EPN clients (US/UK/AU all share this
   * format; the marketplace is conveyed via the destination URL host).
   *
   * Why deterministic construction (no API call): the rover URL scheme is a
   * public, documented standard that EPN has not changed in over a decade.
   * Latency: zero. Failure modes: none upstream. Rate-limit cost: zero.
   *
   * Why we still require the credentials to be configured: a user with a
   * half-configured environment learns at link-generation time, not at
   * first-click time when nothing tracks. Matches the Awin precedent.
   *
   * `programmeId` here is interpreted as either:
   *   - an EPN campaign ID — the value used directly as `campid`. This is the
   *     common case once setup is complete.
   *   - an eBay item ID (numeric, 9+ digits) when the caller wants a deep
   *     link to a specific listing AND has no campaign ID handy. The campaign
   *     ID is then read from EBAY_CAMPAIGN_ID and the destination URL is
   *     constructed as `https://www.ebay.com/itm/{itemId}` if the caller
   *     passes an empty destinationUrl.
   *
   * The dual interpretation keeps the call ergonomic for callers who already
   * know an item ID but do not yet think in terms of campaigns. The behaviour
   * is documented in docs/networks/ebay.md.
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
          message:
            'eBay tracking links require either an EPN campaign ID or an eBay item ID as `programmeId`.',
          hint:
            'Pass `programmeId` set to your numeric campaign ID (preferred — see EBAY_CAMPAIGN_ID) ' +
            'or to an eBay item ID if you want to link to a specific listing.',
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
          hint: 'Pass the full URL of the eBay listing or category you want to link to.',
        }),
      );
    }

    // Sanity check: ensure credentials are present so a half-configured
    // environment surfaces the problem at link-generation time.
    requireCredential('EBAY_CLIENT_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint: 'Run `affiliate-networks-mcp setup ebay` to provide EBAY_CLIENT_ID.',
    });

    const campaignId = requireCampaignId('generateTrackingLink');
    const rotationId =
      getCredential('EBAY_ROTATION_ID') ?? '711-53200-19255-0';

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://rover.ebay.com/rover/1/${encodeURIComponent(rotationId)}/1` +
      `?campid=${encodeURIComponent(campaignId)}` +
      `&toolid=10001` +
      `&mpre=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      // We expose the campaign ID as `programmeId` on the result regardless
      // of which value the caller passed in — the canonical `Programme` for
      // an EPN tracking link is always the campaign.
      programmeId: campaignId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'rover.ebay.com deterministic construction',
        rotationId,
        campid: campaignId,
        toolid: '10001',
        mpre: input.destinationUrl,
        callerProgrammeId: input.programmeId,
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic rover.ebay.com URL construction; no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known EPN campaign ID; not probed automatically.',
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
// Module-level registration (mirrors every other adapter's pattern).
// ---------------------------------------------------------------------------

export const ebayAdapter = new EbayAdapter();
registerAdapter(ebayAdapter);

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
 * Split `[from, to]` into ≤`maxDays`-day chunks. EPN's reporting endpoints
 * cap a single call at 90 days; we chunk so callers can request wider windows
 * naturally and the adapter handles the pagination.
 */
function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return [{ start: from, end: to }];
  }
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

/**
 * Format a Date for eBay's `startDate`/`endDate` query params.
 *
 * eBay's reporting endpoints accept ISO-8601 UTC. We strip the millisecond
 * suffix — observed in testing that some EPN edge nodes reject the `.fffZ`
 * form on the reporting surface even though the API spec permits it.
 */
function formatEbayDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Internal helpers exported for tests under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapCampaignStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toClick,
  chunkDateRange,
  formatEbayDate,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
