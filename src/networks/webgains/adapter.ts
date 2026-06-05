/**
 * Webgains adapter — publisher-side implementation ("Smart Platform API").
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and `src/networks/skimlinks/adapter.ts`. The load-bearing decisions:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction.
 *   - UK English; "programme" not "program".
 *
 * --- Webgains API map ----------------------------------------------------------
 *
 * Auth: OAuth2 "Personal Access Token", passed as `Authorization: Bearer {token}`.
 *   The publisher generates the token self-serve in the Smart Publisher Platform.
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *
 * Base URL: BLOCKED(verify) — see client.ts. Taken as https://platform.webgains.io.
 *
 * Endpoints (existence verified from the docs index; exact paths BLOCKED(verify)):
 *   GET /publishers/{publisherId}                  — identity (verifyAuth).
 *   GET /publishers/{publisherId}/programs         — joined programmes.
 *   GET /publishers/{publisherId}/transactions     — transaction report.
 *       Docs index states a maximum date range of 1 year per report call.
 *   Source: https://docs.webgains.dev/docs/platform-api-1/5a04fe3173176-get-programs
 *           https://docs.webgains.dev/docs/platform-api-1/4e131c6a36cca-get-transaction-report
 *           https://docs.webgains.dev/docs/platform-api-1/4fa03e3e0149a-get-publisher
 *
 * Deeplink format (verified, deterministic — no API call required):
 *   https://track.webgains.com/click.html?wgcampaignid={campaignId}&wgprogramid={programmeId}
 *     [&clickref={subId}]&wgtarget={encodedDestination}
 *   `wgcampaignid` (the publisher campaign/Site ID) and `wgprogramid` (the
 *   programme ID) are both mandatory for tracking; `wgtarget` is the destination.
 *   Source: https://knowledgehub.webgains.com/home/tracking-link-parameters
 *           https://knowledgehub.webgains.com/home/how-do-i-create-a-tracking-link-for-a-program
 *
 * Multi-currency: Webgains is UK-headquartered but reports per programme in the
 * programme's currency. The adapter reads currency PER ROW, never assuming GBP.
 *   Source: https://knowledgehub.webgains.com/home/server-to-server-tracking
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `webgainsRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction.
 *   6. Read credentials via `requireCredential` from shared/config — NEVER process.env
 *      (except in tests).
 *   7. UK English. "programme", not "program".
 */

import { webgainsRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requirePublisherId,
} from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('webgains.adapter');

const SLUG = 'webgains';
const NAME = 'Webgains';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // BLOCKED(verify): doc host returned HTTP 403; base URL is the Smart Publisher
  // Platform host pending live confirmation. See client.ts.
  baseUrl: 'https://platform.webgains.io',
  authModel: 'bearer',
  docsUrl: 'https://docs.webgains.dev/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The exact REST base URL could not be confirmed: the Webgains documentation host (docs.webgains.dev) and the interactive console (platform.webgains.io/docs) were not retrievable from the build environment. The base URL is taken as https://platform.webgains.io and the endpoint paths (/publishers/{id}, /publishers/{id}/programs, /publishers/{id}/transactions) are assumed; both require live-account confirmation.',
    'Webgains transaction field names (e.g. transaction id, programme id, sale value, commission, currency, status, change/validation dates) are read defensively across several plausible names; the exact response schema was not confirmable against the doc host.',
    'listClicks is not exposed via the public Webgains publisher Smart Platform API (reporting is transaction-level, not click-level); the operation throws NotImplementedError.',
    'generateTrackingLink requires WEBGAINS_CAMPAIGN_ID (the publisher campaign/Site ID used as wgcampaignid). The deeplink is constructed deterministically as https://track.webgains.com/click.html?wgcampaignid=...&wgprogramid=...&wgtarget=...',
    'The Get Transaction Report endpoint documents a maximum date range of 1 year per call; the adapter chunks longer windows into one-year segments.',
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

// Maximum date window per Get Transaction Report call (docs index: 1 year).
// We chunk longer windows rather than pushing the cap onto callers (mirrors
// Awin's 31-day chunking).
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Webgains raw response shapes
// ---------------------------------------------------------------------------
//
// Deliberately permissive: field names vary across Webgains API generations
// (Legacy / 2023 / V3) and could not be confirmed verbatim against the doc host.
// Every field is optional and several plausible names are read; the original is
// preserved on `rawNetworkData`.

interface WebgainsTransactionRaw {
  id?: string | number;
  transactionId?: string | number;
  programId?: string | number;
  programmeId?: string | number;
  programName?: string;
  programmeName?: string;
  status?: string;
  // Sale / order value.
  value?: number | string;
  saleValue?: number | string;
  orderValue?: number | string;
  // Commission earned by the publisher.
  commission?: number | string;
  commissionValue?: number | string;
  currency?: string;
  // Dates (ISO 8601). Names vary by generation; read defensively.
  clickDate?: string;
  clickTime?: string;
  date?: string;
  transactionDate?: string;
  eventDate?: string;
  changeDate?: string;
  validationDate?: string;
  approvedDate?: string;
  paymentDate?: string;
  paidDate?: string;
  reason?: string;
  changeReason?: string;
}

interface WebgainsTransactionReportResponse {
  transactions?: WebgainsTransactionRaw[];
  data?: WebgainsTransactionRaw[];
  results?: WebgainsTransactionRaw[];
  // Pagination shape BLOCKED(verify): not confirmable against the doc host.
  total?: number;
}

interface WebgainsProgrammeRaw {
  id?: string | number;
  programId?: string | number;
  programmeId?: string | number;
  name?: string;
  programName?: string;
  programmeName?: string;
  status?: string;
  membershipStatus?: string;
  currency?: string;
  commission?: string;
  commissionRate?: string;
  category?: string;
  categories?: string[];
  url?: string;
  advertiserUrl?: string;
  website?: string;
}

interface WebgainsProgrammesResponse {
  programs?: WebgainsProgrammeRaw[];
  programmes?: WebgainsProgrammeRaw[];
  data?: WebgainsProgrammeRaw[];
  results?: WebgainsProgrammeRaw[];
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Webgains commission status to the canonical TransactionStatus.
 *
 * Webgains publisher commission statuses (verified from the knowledge hub):
 *   open / in recall / pending → 'pending'  (within the recall/validation window)
 *   confirmed / approved       → 'approved' (validated, not yet paid out)
 *   paid                       → 'paid'     (included in a publisher payment)
 *   cancelled / declined /
 *     rejected / reversed      → 'reversed' (the sale did not pay out)
 *   delayed                    → 'other'    (on hold pending advertiser clearance;
 *                                            semantically neither approved nor reversed)
 *   anything else              → 'other'
 *
 * Why 'cancelled' → 'reversed': from the publisher's perspective a cancelled
 * commission means the sale did not pay out, which is what every other network
 * calls a reversal. Why 'delayed' → 'other': it is explicitly a hold state, not
 * an approval or a reversal; collapsing it to either would mislead. The verbatim
 * status is always preserved in `rawNetworkData`.
 *   Source: https://knowledgehub.webgains.com/home/commission-statuses-for-transactions
 */
function mapTransactionStatus(raw: WebgainsTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'open' || s === 'in recall' || s === 'inrecall' || s === 'recall' || s === 'pending') {
    return 'pending';
  }
  if (s === 'confirmed' || s === 'approved' || s === 'validated') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'cancelled' || s === 'canceled' || s === 'declined' || s === 'rejected' || s === 'reversed') {
    return 'reversed';
  }
  if (s === 'delayed' || s === 'onhold' || s === 'on hold') return 'other';
  return 'other';
}

/**
 * Map a Webgains programme membership status to the canonical ProgrammeStatus.
 *
 *   active / accepted / joined → 'joined'
 *   pending / applied          → 'pending'
 *   declined / rejected        → 'declined'
 *   available / open / notjoined → 'available'
 *   suspended / paused / closed → 'suspended'
 *   anything else              → 'unknown'
 *   Source: https://knowledgehub.webgains.com/home/what-do-the-different-program-statuses-mean
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'accepted' || s === 'joined' || s === 'approved') return 'joined';
  if (s === 'pending' || s === 'applied' || s === 'awaiting') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'open' || s === 'notjoined' || s === 'not joined') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'closed') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Webgains transaction at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority (mirrors Awin's validationDate-then-transactionDate logic):
 *   validationDate / changeDate / approvedDate (how long has this been in its
 *   current validated state?) → falls back to the conversion date
 *   (transactionDate / eventDate / date) → then the click date.
 */
function computeAgeDays(raw: WebgainsTransactionRaw, now: Date = new Date()): number {
  const anchor =
    raw.validationDate ??
    raw.changeDate ??
    raw.approvedDate ??
    raw.transactionDate ??
    raw.eventDate ??
    raw.date ??
    raw.clickDate ??
    raw.clickTime;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / DAY_MS));
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function toTransaction(raw: WebgainsTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission ?? raw.commissionValue);
  const sale = toAmount(raw.value ?? raw.saleValue ?? raw.orderValue);
  // Read currency per row — Webgains is multi-currency. No GBP assumption beyond
  // a last-resort fallback when the row genuinely omits a currency.
  const currency = (raw.currency ?? 'GBP').toUpperCase();

  const conversionDate =
    nullableIso(raw.transactionDate ?? raw.eventDate ?? raw.date) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.clickDate ?? raw.clickTime);
  const approvedDate = nullableIso(raw.validationDate ?? raw.changeDate ?? raw.approvedDate);
  const paidDate = nullableIso(raw.paymentDate ?? raw.paidDate);

  return {
    id: String(raw.transactionId ?? raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.programId ?? raw.programmeId ?? ''),
    programmeName:
      raw.programName ?? raw.programmeName ?? `Webgains programme ${raw.programId ?? raw.programmeId ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: conversionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.changeReason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: WebgainsProgrammeRaw): Programme {
  const id = String(raw.programId ?? raw.programmeId ?? raw.id ?? '');
  const categories = raw.categories ?? (raw.category ? [raw.category] : undefined);
  const programme: Programme = {
    id,
    name: raw.programName ?? raw.programmeName ?? raw.name ?? `Webgains programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus({ status: raw.status ?? raw.membershipStatus }),
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  if (raw.commission ?? raw.commissionRate) {
    programme.commissionRate = String(raw.commission ?? raw.commissionRate);
  }
  if (categories) programme.categories = categories;
  const advertiserUrl = raw.advertiserUrl ?? raw.url ?? raw.website;
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  return programme;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Split a [from, to] window into <= MAX_WINDOW_DAYS segments. The Get Transaction
 * Report endpoint documents a 1-year maximum per call; we chunk rather than push
 * the cap onto callers (mirrors Awin's chunkDateRange).
 */
function chunkDateRange(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = from;
  while (cursor < to) {
    const end = new Date(Math.min(cursor.getTime() + MAX_WINDOW_DAYS * DAY_MS, to.getTime()));
    chunks.push({ from: cursor, to: end });
    cursor = new Date(end.getTime() + DAY_MS);
  }
  if (chunks.length === 0) chunks.push({ from, to });
  return chunks;
}

function extractTransactions(resp: WebgainsTransactionReportResponse): WebgainsTransactionRaw[] {
  const arr = resp.transactions ?? resp.data ?? resp.results;
  return Array.isArray(arr) ? arr : [];
}

function extractProgrammes(resp: WebgainsProgrammesResponse): WebgainsProgrammeRaw[] {
  const arr = resp.programs ?? resp.programmes ?? resp.data ?? resp.results;
  return Array.isArray(arr) ? arr : [];
}

function toProgrammeStatusList(
  v?: ProgrammeStatus | ProgrammeStatus[],
): ProgrammeStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class WebgainsAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the programmes the publisher is a member of (the Get Programs endpoint).
   * Optional client-side filters on status, search term, and categories.
   *
   * BLOCKED(verify): path taken as `/publishers/{publisherId}/programs`; the
   * response container key is read defensively (programs/programmes/data/results).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireApiKey('listProgrammes');
    const publisherId = requirePublisherId('listProgrammes');

    const resp = await webgainsRequest<WebgainsProgrammesResponse>({
      operation: 'listProgrammes',
      path: `/publishers/${publisherId}/programs`,
      token,
      query: query?.cursor ? { page: query.cursor } : undefined,
      resilience: RESILIENCE.default,
    });

    let programmes = extractProgrammes(resp).map(toProgramme);

    const statusFilter = toProgrammeStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
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

    log.debug({ count: programmes.length, publisherId }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single programme by ID. The Webgains Get Programs response is the
   * source of truth for membership; we filter it client-side rather than relying
   * on a single-programme endpoint whose path could not be confirmed.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the numeric Webgains programme ID.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Webgains programme ${programmeId} was not found among the publisher's programmes.`,
          hint: 'Confirm the programme ID and that the publisher is a member of it.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Webgains transactions across a date window with optional status / age /
   * programme filters.
   *
   * The Get Transaction Report endpoint documents a maximum window of 1 year per
   * call, so we chunk longer windows (mirrors Awin). Status filtering is applied
   * client-side on the normalised canonical status (the upstream status strings
   * vary by API generation and could not be confirmed verbatim).
   *
   * PRD §15.9 (unpaid-age): `query.minAgeDays`/`maxAgeDays` filter on computed
   * `ageDays`. PRD §15.10 (reversed-sale visibility): cancelled commissions are
   * normalised to 'reversed' and any change reason surfaces in `reversalReason`.
   *
   * BLOCKED(verify): path taken as `/publishers/{publisherId}/transactions`;
   * date param names taken as `dateFrom`/`dateTo` (ISO `YYYY-MM-DD`). The exact
   * names and pagination scheme were not confirmable against the doc host.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireApiKey('listTransactions');
    const publisherId = requirePublisherId('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * DAY_MS);

    const chunks = chunkDateRange(from, to);
    const raw: WebgainsTransactionRaw[] = [];

    for (const chunk of chunks) {
      const params: Record<string, string | number | undefined> = {
        dateFrom: isoDate(chunk.from),
        dateTo: isoDate(chunk.to),
      };
      if (query?.programmeId) {
        params['programId'] = query.programmeId;
      }

      const resp = await webgainsRequest<WebgainsTransactionReportResponse>({
        operation: 'listTransactions',
        path: `/publishers/${publisherId}/transactions`,
        token,
        query: params,
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      raw.push(...extractTransactions(resp));
    }

    let transactions = raw.map((r) => toTransaction(r, now));

    // Client-side canonical status filter.
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9.
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

    log.debug({ count: transactions.length, publisherId }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (one call, one source of truth) — the same
   * reasoning as Awin/Skimlinks. Do NOT pass `query.limit` through: a limited
   * summary would undercount (principle 4.1).
   *
   * Multi-currency caveat: Webgains reports per programme in the programme's
   * currency. The summary's `currency` is the FIRST transaction's currency; the
   * per-programme rows each carry their own currency. A mixed-currency account
   * will therefore show a `totalEarnings` that sums across currencies — the
   * caller must inspect `byProgramme[].currency` to disambiguate.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * DAY_MS).toISOString();
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
      currency: 'GBP',
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
          programmeName: t.programmeName || `Webgains programme ${key}`,
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
      currency: firstCurrency ?? 'GBP',
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
   * Webgains does not expose click-level data via the public publisher Smart
   * Platform API; publisher reporting is transaction-level.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Webgains does not expose click-level data via the public publisher Smart Platform API; ' +
        'publisher reporting is transaction-level. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Webgains deeplink (deterministic, no API call required).
   *
   * Format (verified from the Webgains knowledge hub):
   *   https://track.webgains.com/click.html?wgcampaignid={campaignId}
   *     &wgprogramid={programmeId}&wgtarget={encodedDestination}
   *
   * `wgcampaignid` (the publisher campaign/Site ID) and `wgprogramid` (the
   * programme the link points at) are BOTH mandatory for tracking; `wgtarget`
   * carries the destination URL. We require WEBGAINS_CAMPAIGN_ID because the
   * campaign ID is not derivable from the destination URL.
   *   Source: https://knowledgehub.webgains.com/home/tracking-link-parameters
   *           https://knowledgehub.webgains.com/home/how-do-i-create-a-tracking-link-for-a-program
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
          hint: 'Pass the full URL of the merchant page you want to link to.',
        }),
      );
    }
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'programmeId is required.',
          hint: 'Pass the numeric Webgains programme ID; it becomes the wgprogramid parameter.',
        }),
      );
    }

    const campaignId = requireCredential('WEBGAINS_CAMPAIGN_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint:
        'Set WEBGAINS_CAMPAIGN_ID in ~/.affiliate-mcp/.env. This is your publisher ' +
        'campaign (Site) ID, used as the mandatory wgcampaignid tracking parameter.',
    });

    const encodedDestination = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://track.webgains.com/click.html?wgcampaignid=${encodeURIComponent(campaignId)}` +
      `&wgprogramid=${encodeURIComponent(input.programmeId)}` +
      `&wgtarget=${encodedDestination}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'track.webgains.com/click.html deterministic construction',
        wgcampaignid: campaignId,
        wgprogramid: input.programmeId,
        wgtarget: input.destinationUrl,
        note: 'wgcampaignid and wgprogramid are both mandatory for Webgains tracking.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials via the Get Publisher endpoint.
   *
   * On success: { ok: true, identity }. On failure: { ok: false, reason }.
   * Never throws — verifyAuth is called by error handlers.
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
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

  /**
   * Probe each operation with a minimal call. listClicks is known-unsupported and
   * is recorded without probing.
   */
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

    // Known-unsupported — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Webgains does not expose click-level data via the public publisher Smart Platform API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    // getProgramme depends on listProgrammes; mark supported with the same caveat.
    operations['getProgramme'] = {
      supported: operations['listProgrammes']?.supported ?? false,
      note: 'Derived from the Get Programs response (filtered client-side by programme ID).',
    };

    // generateTrackingLink is deterministic — record as supported without a probe.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic track.webgains.com deeplink construction; no live probe needed.',
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
// Registration
// ---------------------------------------------------------------------------

export const webgainsAdapter = new WebgainsAdapter();
registerAdapter(webgainsAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toAmount,
  chunkDateRange,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
