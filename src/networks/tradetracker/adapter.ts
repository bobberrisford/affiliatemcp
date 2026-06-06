/**
 * TradeTracker adapter — publisher side, single-brand.
 *
 * TradeTracker is an NL/EU affiliate network whose affiliate API is SOAP-only
 * (`https://ws.tradetracker.com/soap/affiliate`, WSDL at `?wsdl`). This adapter
 * follows the Awin publisher pattern (`src/networks/awin/adapter.ts` — the
 * canonical reference) but speaks SOAP: `client.ts` builds request envelopes by
 * hand and parses XML responses with a minimal built-in parser, mirroring
 * `src/networks/cake/client.ts`. No XML dependency is added.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — getCampaigns(affiliateSiteID): merchant campaigns.
 *   getProgramme        — getCampaigns + client-side id match (no single-get).
 *   listTransactions    — getConversionTransactions(affiliateSiteID, options).
 *   getEarningsSummary  — aggregation derived from listTransactions.
 *   listClicks          — getClickTransactions(affiliateSiteID, options).
 *   generateTrackingLink— deterministic tc.tradetracker.net click URL.
 *   verifyAuth          — authenticate + getAffiliateSites.
 *
 * Two admin ops (`listPublishers`, `listPublisherSectors`) are scaffolded for
 * v0.2 and throw `NotImplementedError` at v0.1.
 *
 * --- Cardinal rules (see Awin's header for the full reasoning) --------------
 *
 *   1. NEVER call `fetch` directly. Use the client + `withSession` from
 *      `auth.ts`, which applies the resilience layer and the SOAP session.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw parsed response on `rawNetworkData` for every object.
 *   4. NORMALISE status enums to the canonical set. TradeTracker conversion
 *      statuses are `pending | accepted | rejected` → see `mapTransactionStatus`.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme", not "program").
 *
 * --- Amount-unit assumption -------------------------------------------------
 *
 * TradeTracker reports `commission` and `orderAmount` as decimal floats in the
 * campaign currency. We treat them as MAJOR units (e.g. euros, not cents); this
 * has not been confirmed against a live account and is recorded as a known
 * limitation in `network.json`.
 */

import {
  tradeTrackerRequest,
  findAll,
  childText,
  child,
  escapeXml,
  type TtElement,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  withSession,
  requireSiteId,
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
  type CommissionRateStructured,
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

const log = createLogger('tradetracker.adapter');

const SLUG = 'tradetracker';
const NAME = 'TradeTracker';

/**
 * The deterministic TradeTracker click-redirect host. The documented affiliate
 * click URL is `https://tc.tradetracker.net/?c=<campaign>&m=<material>&a=<affiliate>&r=<reference>&u=<url>`.
 */
const TRACKING_HOST = 'https://tc.tradetracker.net/';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://ws.tradetracker.com',
  authModel: 'custom',
  docsUrl: 'https://affiliate.tradetracker.com/webService/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: implemented from public API docs, not yet validated against
  // a live TradeTracker account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'The TradeTracker affiliate API is SOAP-only: requests and responses are hand-built XML envelopes parsed without an XML dependency, and authentication opens a server session whose cookie is cached and re-established on expiry.',
    'Monetary fields (commission, orderAmount) are assumed to be major currency units (e.g. euros, not cents) in the campaign currency; this has not been confirmed against a live account.',
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

/**
 * The transaction/click reports can be slow for active sites over a wide
 * window, and a SOAP round-trip is heavier than a REST call. Give the reporting
 * ops a longer timeout and one extra retry, mirroring Awin's reasoning.
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
// Date formatting
// ---------------------------------------------------------------------------

/**
 * TradeTracker's `registrationDateFrom` / `registrationDateTo` filters expect a
 * `YYYY-MM-DD HH:MM:SS` string (no timezone suffix). We format from a Date in
 * UTC so the value is reproducible regardless of the host timezone.
 */
export function formatTradeTrackerDate(d: Date): string {
  const iso = d.toISOString(); // 2026-01-02T03:04:05.678Z
  return iso.slice(0, 19).replace('T', ' ');
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. TradeTracker does not document
 * a hard window cap on the SOAP transaction report, but very wide windows time
 * out, so we chunk into 31-day slices like Awin to keep each call bounded.
 * Returns at least one slice; a `from >= to` yields one zero-width slice.
 */
export function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
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

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  // TradeTracker dates are `YYYY-MM-DD HH:MM:SS`; treat as UTC for parsing.
  const normalised = d.includes('T') ? d : `${d.replace(' ', 'T')}Z`;
  const ts = Date.parse(normalised);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toNumber(v?: string): number {
  if (v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Status normalisation: TradeTracker conversion `transactionStatus` → canonical.
 *
 * TradeTracker uses `pending | accepted | rejected`:
 *   pending   → 'pending'  (not yet assessed)
 *   accepted  → 'approved' (approved commission; "accepted" is TradeTracker's word)
 *   rejected  → 'reversed' (the sale did not pay out — same user-facing intent
 *               as Awin's "declined" → "reversed")
 *
 * A separate boolean `paidOut` indicates the commission has been included in a
 * payment; when true we map to 'paid' (it overrides the status string), matching
 * Awin's `paidToPublisher` handling. Anything unrecognised maps to 'other' so
 * we never invent a status the user did not see on TradeTracker's side.
 */
export function mapTransactionStatus(status?: string, paidOut?: string): TransactionStatus {
  if (paidOut === 'true' || paidOut === '1') return 'paid';
  switch ((status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'accepted':
      return 'approved';
    case 'rejected':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: TradeTracker campaign assignment status → canonical
 * ProgrammeStatus.
 *
 * TradeTracker's `assignmentStatus` (under campaign `info`) takes values such as
 * `accepted | onhold | pending | signedup | notsignedup | rejected`. We collapse:
 *   accepted / signedup        → 'joined'
 *   pending / onhold           → 'pending'
 *   rejected                   → 'declined'
 *   notsignedup                → 'available'
 *   anything else              → 'unknown'
 *
 * `getCampaigns` can be filtered server-side by assignment status, but we map
 * defensively because TradeTracker adds states over time; 'unknown' keeps us
 * honest rather than miscategorising.
 */
export function mapProgrammeStatus(assignmentStatus?: string): ProgrammeStatus {
  switch ((assignmentStatus ?? '').toLowerCase()) {
    case 'accepted':
    case 'signedup':
    case 'active':
      return 'joined';
    case 'pending':
    case 'onhold':
      return 'pending';
    case 'rejected':
    case 'declined':
      return 'declined';
    case 'notsignedup':
    case 'available':
      return 'available';
    default:
      return 'unknown';
  }
}

/**
 * Map a canonical ProgrammeStatus filter to TradeTracker's getCampaigns
 * assignment-status argument. TradeTracker accepts a single assignment status;
 * we default to 'accepted' (joined) because that is the most common question.
 * An empty value asks for all campaigns the affiliate can see.
 */
export function pickAssignmentStatus(statuses?: ProgrammeStatus[]): string {
  if (!statuses || statuses.length === 0) return 'accepted';
  if (statuses.includes('joined')) return 'accepted';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('available')) return 'notsignedup';
  return 'accepted';
}

// ---------------------------------------------------------------------------
// Transformers (TradeTracker XML element → canonical domain types)
// ---------------------------------------------------------------------------

/**
 * Build a structured commission rate from a campaign's `commission` block.
 * TradeTracker exposes several commission components (per-lead, per-sale fixed,
 * per-sale variable percentage, etc.); we surface the most descriptive single
 * value and leave the verbatim block on `rawNetworkData`.
 */
function toCommissionRate(commissionEl?: TtElement): string | CommissionRateStructured | undefined {
  if (!commissionEl) return undefined;
  const saleVariable = childText(commissionEl, 'saleCommissionVariable');
  const saleFixed = childText(commissionEl, 'saleCommissionFixed');
  const lead = childText(commissionEl, 'leadCommission');
  const click = childText(commissionEl, 'clickCommission');

  if (saleVariable !== undefined && toNumber(saleVariable) > 0) {
    return { type: 'percent', value: toNumber(saleVariable), description: `${saleVariable}% per sale` };
  }
  if (saleFixed !== undefined && toNumber(saleFixed) > 0) {
    return { type: 'flat', value: toNumber(saleFixed), description: `${saleFixed} per sale` };
  }
  if (lead !== undefined && toNumber(lead) > 0) {
    return { type: 'flat', value: toNumber(lead), description: `${lead} per lead` };
  }
  if (click !== undefined && toNumber(click) > 0) {
    return { type: 'flat', value: toNumber(click), description: `${click} per click` };
  }
  return undefined;
}

export function toProgramme(el: TtElement): Programme {
  const id = childText(el, 'ID') ?? childText(el, 'id') ?? '';
  const name = childText(el, 'name') ?? `TradeTracker campaign ${id}`;
  const url = childText(el, 'URL') ?? childText(el, 'url');
  const info = child(el, 'info');

  const assignmentStatus = info ? childText(info, 'assignmentStatus') : undefined;
  const commissionEl = info ? child(info, 'commission') : undefined;
  const categoryEl = info ? child(info, 'category') : undefined;
  const categoryName = categoryEl ? childText(categoryEl, 'name') : undefined;

  const programme: Programme = {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(assignmentStatus),
    rawNetworkData: el,
  };
  const commissionRate = toCommissionRate(commissionEl);
  if (commissionRate !== undefined) programme.commissionRate = commissionRate;
  if (categoryName) programme.categories = [categoryName];
  if (url) programme.advertiserUrl = url;
  return programme;
}

export function toTransaction(el: TtElement, now: Date = new Date()): Transaction {
  const id = childText(el, 'ID') ?? childText(el, 'id') ?? '';
  const status = mapTransactionStatus(
    childText(el, 'transactionStatus'),
    childText(el, 'paidOut'),
  );
  const campaign = child(el, 'campaign');
  const programmeId = campaign ? childText(campaign, 'ID') ?? childText(campaign, 'id') ?? '' : '';
  const programmeName = campaign ? childText(campaign, 'name') ?? '' : '';

  const commission = toNumber(childText(el, 'commission'));
  const orderAmount = toNumber(childText(el, 'orderAmount'));
  const currency = childText(el, 'currency') ?? 'EUR';

  const registrationDate = childText(el, 'registrationDate');
  const assessmentDate = childText(el, 'assessmentDate');
  const clickDate = childText(el, 'originatingClickDate');

  const converted = nullableIso(registrationDate) ?? new Date(0).toISOString();

  const transaction: Transaction = {
    id,
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount: orderAmount,
    currency,
    commission,
    dateConverted: converted,
    ageDays: computeAgeDays(assessmentDate ?? registrationDate, now),
    rawNetworkData: el,
  };

  const clicked = nullableIso(clickDate);
  if (clicked) transaction.dateClicked = clicked;
  // TradeTracker's assessmentDate is the point a transaction was accepted or
  // rejected — the closest analogue to Awin's validationDate ("approved").
  const approved = nullableIso(assessmentDate);
  if (approved && (status === 'approved' || status === 'paid')) {
    transaction.dateApproved = approved;
  }
  // PRD §15.10 — surface a rejection reason for reversed transactions.
  if (status === 'reversed') {
    const reason = childText(el, 'rejectionReason') ?? childText(el, 'description');
    if (reason) transaction.reversalReason = reason;
  }
  return transaction;
}

/**
 * Compute the age (in days) of a transaction. We anchor on the assessment date
 * (when TradeTracker accepted/rejected the commission) when present, else the
 * registration date — the same "how long has this been settled-or-waiting"
 * intent as Awin's `computeAgeDays`.
 */
export function computeAgeDays(anchor?: string, now: Date = new Date()): number {
  const iso = nullableIso(anchor);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function toClick(el: TtElement, fallbackProgrammeId?: string): Click {
  const id = childText(el, 'ID') ?? childText(el, 'id') ?? '';
  const campaign = child(el, 'campaign');
  const programmeId = campaign
    ? childText(campaign, 'ID') ?? childText(campaign, 'id') ?? fallbackProgrammeId
    : fallbackProgrammeId;
  const registrationDate = childText(el, 'registrationDate');
  const referer = childText(el, 'refererUrl');

  const click: Click = {
    id,
    network: SLUG,
    timestamp: nullableIso(registrationDate) ?? new Date(0).toISOString(),
    rawNetworkData: el,
  };
  if (programmeId) click.programmeId = programmeId;
  if (referer) click.referrer = referer;
  return click;
}

// ---------------------------------------------------------------------------
// SOAP body builders
// ---------------------------------------------------------------------------

/**
 * Build the `<options>` block shared by getConversionTransactions /
 * getClickTransactions. Only the fields we use are emitted; TradeTracker treats
 * absent options as "no filter".
 */
function buildTransactionOptions(opts: {
  from?: Date;
  to?: Date;
  status?: string;
}): string {
  const parts: string[] = [];
  if (opts.from) {
    parts.push(`<registrationDateFrom>${escapeXml(formatTradeTrackerDate(opts.from))}</registrationDateFrom>`);
  }
  if (opts.to) {
    parts.push(`<registrationDateTo>${escapeXml(formatTradeTrackerDate(opts.to))}</registrationDateTo>`);
  }
  if (opts.status) {
    parts.push(`<transactionStatus>${escapeXml(opts.status)}</transactionStatus>`);
  }
  if (parts.length === 0) return '';
  return `<options>${parts.join('')}</options>`;
}

/**
 * Map a canonical TransactionStatus filter to TradeTracker's options
 * `transactionStatus`. TradeTracker accepts one status; if the caller passes a
 * single canonical status that maps cleanly we send it, otherwise we omit the
 * server-side filter and rely on the client-side filter in `listTransactions`.
 */
function pickTransactionStatusFilter(
  statuses?: TransactionStatus[],
): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'paid':
      return 'accepted';
    case 'reversed':
      return 'rejected';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class TradeTrackerAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List TradeTracker campaigns (programmes) for the configured affiliate site.
   *
   * SOAP: `getCampaigns(affiliateSiteID, assignmentStatus)`. We default to
   * `accepted` (joined) because the typical question is "which merchants do I
   * work with?". Callers asking for available campaigns pass `status:
   * 'available'`. Search / category / limit filters are applied client-side
   * because the SOAP method filters only by assignment status.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const siteId = requireSiteId('listProgrammes');
    const statusFilter = toStatusList(query?.status);
    const assignmentStatus = pickAssignmentStatus(statusFilter);

    const bodyXml =
      `<affiliateSiteID>${escapeXml(siteId)}</affiliateSiteID>` +
      `<options><assignmentStatus>${escapeXml(assignmentStatus)}</assignmentStatus></options>`;

    const { root } = await withSession('listProgrammes', (cookie) =>
      tradeTrackerRequest({
        operation: 'listProgrammes',
        method: 'getCampaigns',
        bodyXml,
        cookie,
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      }),
    );

    let programmes = findAll(root, 'campaign').map(toProgramme);

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
   * Fetch a single campaign by ID.
   *
   * TradeTracker's SOAP surface has no "get one campaign" method, so we list
   * campaigns (without an assignment-status filter, so available and joined
   * both match) and pick the matching ID client-side. An unknown ID surfaces
   * as a network_api_error envelope rather than a fabricated stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `TradeTracker campaign IDs are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_tradetracker_list_programmes) to find the correct id.',
        }),
      );
    }

    const siteId = requireSiteId('getProgramme');
    const bodyXml =
      `<affiliateSiteID>${escapeXml(siteId)}</affiliateSiteID>` +
      `<options></options>`;

    const { root } = await withSession('getProgramme', (cookie) =>
      tradeTrackerRequest({
        operation: 'getProgramme',
        method: 'getCampaigns',
        bodyXml,
        cookie,
        resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
      }),
    );

    const match = findAll(root, 'campaign')
      .map(toProgramme)
      .find((p) => p.id === programmeId);

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `TradeTracker returned no campaign with ID "${programmeId}" for this affiliate site.`,
          hint: 'The campaign may not be visible to this site, or the ID is wrong. List programmes to confirm.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversion transactions across a date window.
   *
   * SOAP: `getConversionTransactions(affiliateSiteID, options)` where options
   * carry `registrationDateFrom` / `registrationDateTo` (format
   * `YYYY-MM-DD HH:MM:SS`) and an optional `transactionStatus`. We default to a
   * 30-day window and chunk wider windows into 31-day slices so a single call
   * stays bounded (TradeTracker times out on very wide windows).
   *
   * PRD §15.9 (unpaid-age filter) and §15.10 (reversed visibility) are honoured
   * the same way as Awin: age filters apply after status filtering, reversed
   * transactions surface a `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const siteId = requireSiteId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const statusList = toTransactionStatusList(query?.status);
    const serverStatus = pickTransactionStatusFilter(statusList);

    const slices = chunkDateRange(from, to, 31);
    const allRows: TtElement[] = [];
    for (const slice of slices) {
      const options = buildTransactionOptions({
        from: slice.start,
        to: slice.end,
        status: serverStatus,
      });
      const bodyXml = `<affiliateSiteID>${escapeXml(siteId)}</affiliateSiteID>${options}`;
      const { root } = await withSession('listTransactions', (cookie) =>
        tradeTrackerRequest({
          operation: 'listTransactions',
          method: 'getConversionTransactions',
          bodyXml,
          cookie,
          resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
        }),
      );
      allRows.push(...findAll(root, 'conversionTransaction'));
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
    if (statusList && statusList.length > 0) {
      const set = new Set(statusList);
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
   * Aggregate transactions into an earnings summary, derived from
   * listTransactions for the same reasons as Awin: the per-transaction record
   * is the canonical, auditable source and carries the `ageDays` needed for
   * `oldestUnpaidAgeDays`. We deliberately ignore `query.limit` so a summary
   * never silently undercounts.
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
          programmeName: t.programmeName || `TradeTracker campaign ${key}`,
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
   * List click transactions for the configured affiliate site.
   *
   * SOAP: `getClickTransactions(affiliateSiteID, options)` with the same
   * `registrationDateFrom` / `registrationDateTo` filter as conversions.
   * TradeTracker DOES expose click-level data to affiliates (unlike Awin), so
   * this is implemented rather than throwing NotImplementedError. We default to
   * a 30-day window and chunk wider windows into 31-day slices.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const siteId = requireSiteId('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);
    const allRows: TtElement[] = [];
    for (const slice of slices) {
      const options = buildTransactionOptions({ from: slice.start, to: slice.end });
      const bodyXml = `<affiliateSiteID>${escapeXml(siteId)}</affiliateSiteID>${options}`;
      const { root } = await withSession('listClicks', (cookie) =>
        tradeTrackerRequest({
          operation: 'listClicks',
          method: 'getClickTransactions',
          bodyXml,
          cookie,
          resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
        }),
      );
      allRows.push(...findAll(root, 'clickTransaction'));
    }

    let clicks = allRows.map((r) => toClick(r, query?.programmeId));
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
   * Construct a TradeTracker deep-link.
   *
   * The documented affiliate click URL is deterministic:
   *
   *   https://tc.tradetracker.net/?c=<campaignID>&m=<materialID>&a=<affiliateSiteID>&r=<reference>&u=<destinationUrl>
   *
   * `c` is the campaign (programme) id, `a` is the affiliate site id (from
   * credentials), `u` is the URL-encoded destination. `m` (material) and `r`
   * (reference) are optional; we emit empty values to keep the documented
   * parameter shape and leave room for callers to add a sub-id later.
   *
   * Deterministic construction (no API round-trip) for the same reason as Awin:
   * the scheme is documented and stable, so a SOAP call would add latency and a
   * failure mode for no benefit.
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
          message: 'TradeTracker tracking links require the campaign (programme) ID.',
          hint: 'Pass `programmeId`. Use affiliate_tradetracker_list_programmes to discover the campaign ID.',
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

    // Require the affiliate site id so a half-configured environment fails at
    // link-generation time, not at first click.
    const siteId = requireSiteId('generateTrackingLink');

    const trackingUrl =
      `${TRACKING_HOST}` +
      `?c=${encodeURIComponent(input.programmeId)}` +
      `&m=` +
      `&a=${encodeURIComponent(siteId)}` +
      `&r=` +
      `&u=${encodeURIComponent(input.destinationUrl)}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'tc.tradetracker.net deterministic construction',
        c: input.programmeId,
        a: siteId,
        u: input.destinationUrl,
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
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin's adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const tradetrackerAdapter = new TradeTrackerAdapter();
registerAdapter(tradetrackerAdapter);

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

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  pickAssignmentStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toClick,
  chunkDateRange,
  formatTradeTrackerDate,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
