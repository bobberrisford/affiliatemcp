/**
 * Awin adapter — the canonical reference implementation for `affiliate-mcp`.
 *
 * READ ME FIRST (future Claude Code agents adding CJ, Impact, Rakuten, etc.):
 *
 * This file is the pattern source. Future network adapters are expected to
 * read it without other context and reproduce its structure. The non-obvious
 * decisions are documented inline with "why" comments — those are the
 * load-bearing parts. The code mechanics (URL building, JSON shaping) are
 * easy to copy; the reasoning behind them is what keeps quality consistent.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — discovery: "what merchants can I work with?"
 *   getProgramme        — drill-down on a single merchant
 *   listTransactions    — the workhorse: earnings, status, ageing
 *   getEarningsSummary  — aggregation built on top of listTransactions
 *   listClicks          — traffic-side debugging (Awin: NOT exposed via API)
 *   generateTrackingLink— deep-link construction
 *   verifyAuth          — auth check + identity discovery
 *
 * Two admin ops (`listPublishers`, `listPublisherSectors`) are scaffolded for
 * v0.2 and throw `NotImplementedError` at v0.1.
 *
 * --- Cardinal rules ---------------------------------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `awinRequest` from `./client.ts`. The
 *      resilience layer (timeout, retry, circuit breaker) only applies if you
 *      go through the client.
 *   2. EVERY failure must round-trip through a `NetworkErrorEnvelope` carrying
 *      `network`, `operation`, `httpStatus`, and the verbatim `networkErrorBody`.
 *      Never collapse a failure to "an error occurred" (PRD principle 4.1).
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *      Debugging is impossible if we throw away what Awin actually sent.
 *   4. NORMALISE status enums into our canonical set (`pending|approved|
 *      reversed|paid|other`). Document the mapping. See `mapTransactionStatus`.
 *   5. COMPUTE `ageDays` for every transaction. PRD §15.9 — the "the £42 from
 *      January is still pending after 95 days" affordance depends on it.
 *   6. Use UK English in every user-visible string. The user-visible noun is
 *      "programme" not "program".
 *
 * --- Awin API map (verify against https://help.awin.com/apidocs/introduction-1) ---
 *
 *   GET  /accounts?type=publisher
 *     → list of publisher accounts; used by verifyAuth and to derive AWIN_PUBLISHER_ID.
 *   GET  /publishers/{publisherId}/programmes
 *     → joined / pending / available programmes. Supports `relationship` filter.
 *   GET  /publishers/{publisherId}/programmedetails?advertiserId=...
 *     → single programme detail.
 *   GET  /publishers/{publisherId}/transactions/
 *     ?startDate=ISO &endDate=ISO &dateType=transaction &timezone=Europe/London
 *     → transactions; max 31 days per call.
 *   GET  /publishers/{publisherId}/reports/aggregated?...
 *     → server-side aggregated earnings. We DON'T use this — see
 *     `getEarningsSummary` below for why.
 *
 * --- Why this file is so heavily commented ---------------------------------
 *
 * Per PRD §15.30, this adapter is the reference implementation. Future agents
 * writing CJ/Impact/Rakuten/etc. will read this file as their pattern. The
 * code shows the *what*; the comments must capture the *why* — especially
 * around status normalisation, deterministic link construction, the unpaid-age
 * filter, and the `derivedValues` pattern. Aim for a future contributor able
 * to write a new adapter without asking questions.
 */

import { awinRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requirePublisherId, requireToken } from './endpoints/shared.js';
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

const log = createLogger('awin.adapter');

const SLUG = 'awin';
const NAME = 'Awin';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.awin.com',
  authModel: 'bearer',
  docsUrl: 'https://help.awin.com/apidocs/introduction-1',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-21',
  // `partial` rather than `production`: listClicks is structurally unsupported
  // by Awin and the adapter has not been validated against a real account at
  // commit time. Bump to `production` after Chunk 8 acceptance testing.
  claimStatus: 'partial',
  knownLimitations: [
    'Click-level data is not exposed via the public Awin publisher API; listClicks is unsupported.',
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
 * Per-operation resilience.
 *
 * Most ops use the default (30s timeout, 2 retries, `[429, 502, 503, 504]`
 * retryable, 5-failure → 60s circuit cooldown — see `src/shared/resilience.ts`).
 *
 * Why listTransactions gets 60s: Awin's transactions endpoint is slow when the
 * 31-day window has many records and the upstream report engine is warm-loading.
 * 30s is enough for a small publisher but reliably times out for active ones.
 * Bumping retries to 3 (instead of 2) on top of the longer timeout means a
 * transient gateway 502 during heavy hours still resolves rather than failing
 * the whole call.
 *
 * Why we don't lower the timeout for fast ops (`/accounts`): the default is
 * already comfortable; making it shorter only saves time when the network is
 * already broken, where the resilience layer's own timeout would catch it.
 */
const TRANSACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: TRANSACTIONS_RESILIENCE,
  // `getEarningsSummary` is derived from listTransactions, so its resilience
  // is effectively that of the transactions call too — but we declare a
  // mapping here for clarity in case a future version uses the dedicated
  // /reports/aggregated endpoint.
  getEarningsSummary: TRANSACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Awin response shapes (deliberately minimal)
// ---------------------------------------------------------------------------
//
// Why we don't model these with strict Zod schemas:
//   - Awin's surface drifts (field renames, new optional fields). Hard schemas
//     break first; transformers that defensively read keys keep working.
//   - We never trust these shapes — every transformer treats every field as
//     possibly absent and preserves the original under `rawNetworkData`.
//   - When Awin returns something we don't recognise, the user sees the raw
//     payload in the envelope/`rawNetworkData`, which is more honest than a
//     "schema mismatch" error.
// ---------------------------------------------------------------------------

interface AwinProgrammeRaw {
  id?: number;
  advertiserId?: number;
  name?: string;
  status?: string;
  primaryRegion?: { name?: string; countryCode?: string; currencyCode?: string };
  currencyCode?: string;
  displayUrl?: string;
  clickThroughUrl?: string;
  logoUrl?: string;
  // Awin programme listings include commission summary as a free-text string;
  // structured commission data lives under /programmedetails.
  commissionRange?: { min?: number; max?: number; type?: string };
  sectors?: Array<{ name?: string }>;
  validDomains?: string[];
  relationship?: string; // joined | notjoined | pending — from query
}

interface AwinTransactionRaw {
  id?: number;
  url?: string;
  advertiserId?: number;
  publisherId?: number;
  commissionSharingPublisherId?: number;
  campaign?: string;
  siteName?: string;
  commissionStatus?: 'pending' | 'approved' | 'declined' | string;
  saleAmount?: { amount?: number; currency?: string };
  commissionAmount?: { amount?: number; currency?: string };
  // Awin uses ISO 8601 with the publisher timezone offset.
  clickDate?: string;
  transactionDate?: string;
  validationDate?: string;
  paidToPublisher?: boolean;
  paymentId?: number;
  // Reversal context — Awin populates `declineReason` when commissionStatus
  // is `declined`. Field name varies across tenants; we read both.
  declineReason?: string;
  reasonForDecline?: string;
  advertiserName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Awin → canonical.
 *
 * Awin uses 'declined' for reversed/cancelled commissions; we normalise to
 * 'reversed' because the user-facing intent is the same — the sale didn't
 * pay out. Keep the raw value in `rawNetworkData` so debugging is not impeded.
 *
 * Why 'paid' is not directly available: Awin marks transactions with
 * `paidToPublisher: true` once they're included in a payment. We derive 'paid'
 * from that flag rather than from the commissionStatus string, because Awin's
 * status string can stay 'approved' even after payment has been issued.
 *
 * Any unknown commissionStatus value maps to 'other' — by design we never
 * invent a status the user didn't see on Awin's side.
 */
function mapTransactionStatus(raw: AwinTransactionRaw): TransactionStatus {
  if (raw.paidToPublisher === true) return 'paid';
  switch (raw.commissionStatus) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'declined':
      // Awin's "declined" is our "reversed". The user did not get paid; the
      // word "reversed" is what every other network calls this state.
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Awin programme relationship → canonical ProgrammeStatus.
 *
 * Awin's `relationship` query parameter takes `joined|notjoined|pending`, but
 * the response may include `accessStatus` (for joined ones) values like
 * `active|paused|notjoined`. We collapse to our enum:
 *
 *   joined / active        → 'joined'
 *   pending                → 'pending'
 *   declined / refused     → 'declined'
 *   notjoined              → 'available'
 *   paused / suspended     → 'suspended'
 *   anything else          → 'unknown'
 *
 * Why we don't try to be exhaustive: Awin adds new states from time to time
 * (e.g. 'inactive' appeared around 2023). 'unknown' keeps us honest rather
 * than miscategorising.
 */
function mapProgrammeStatus(raw: AwinProgrammeRaw): ProgrammeStatus {
  const s = (raw.status ?? raw.relationship ?? '').toLowerCase();
  if (s === 'joined' || s === 'active') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'declined' || s === 'refused' || s === 'rejected') return 'declined';
  if (s === 'notjoined' || s === 'available') return 'available';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  return 'unknown';
}

/**
 * Compute the age (in days) of a transaction at the moment this adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this number.
 *
 * Why we prefer validationDate then transactionDate: validationDate is the
 * point Awin "approved" the commission (typically days/weeks after the
 * conversion). For the unpaid-age affordance we want "how long has this been
 * approved-but-not-paid", which is validationDate-relative. For a pending
 * transaction validationDate may be absent, so we fall back to the conversion
 * date.
 */
function computeAgeDays(raw: AwinTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.validationDate ?? raw.transactionDate;
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

// ---------------------------------------------------------------------------
// Transformers (Awin raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: AwinProgrammeRaw): Programme {
  // Awin uses `id`/`advertiserId` interchangeably depending on the endpoint.
  // We prefer `id` (set in /programmes) and fall back to `advertiserId`
  // (set in /programmedetails).
  const id = String(raw.id ?? raw.advertiserId ?? '');
  return {
    id,
    name: raw.name ?? `Awin programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currencyCode ?? raw.primaryRegion?.currencyCode,
    // Awin's structured commission data lives behind /programmedetails. For
    // the list view we surface the textual range so the caller has something.
    commissionRate: raw.commissionRange
      ? {
          type: 'unknown',
          description:
            raw.commissionRange.min !== undefined && raw.commissionRange.max !== undefined
              ? `${raw.commissionRange.min}–${raw.commissionRange.max} ${raw.commissionRange.type ?? ''}`.trim()
              : raw.commissionRange.type,
        }
      : undefined,
    categories: (raw.sectors ?? [])
      .map((s) => s.name)
      .filter((n): n is string => typeof n === 'string'),
    advertiserUrl: raw.displayUrl ?? raw.clickThroughUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AwinTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = raw.commissionAmount?.amount ?? 0;
  const sale = raw.saleAmount?.amount ?? 0;
  const currency = raw.commissionAmount?.currency ?? raw.saleAmount?.currency ?? 'GBP';

  const transactionDate = nullableIso(raw.transactionDate) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.clickDate);
  const validationDate = nullableIso(raw.validationDate);

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiserId ?? ''),
    programmeName: raw.advertiserName ?? raw.campaign ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    dateApproved: validationDate,
    // Awin doesn't expose a paid-date field directly on the transaction. The
    // `paymentId` indicates the transaction is in a payment batch but the
    // batch date is on a separate /payments endpoint. Leave undefined rather
    // than fabricating.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — reversed transactions must surface a reason where Awin
    // provides one. The field name varies across Awin tenants ("declineReason"
    // in newer responses, "reasonForDecline" in legacy). Read both.
    reversalReason:
      status === 'reversed'
        ? raw.declineReason ?? raw.reasonForDecline ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class AwinAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Awin programmes the publisher has joined (or could join).
   *
   * Default: `relationship=joined` — the typical user question is "what
   * partners do I work with?", not "what's the entire Awin catalogue?". The
   * catalogue is enormous and would time out without pagination. Callers who
   * want available programmes pass `status: 'available'`.
   *
   * Awin's `/programmes` endpoint:
   *   - GET /publishers/{publisherId}/programmes?relationship=joined&countryCode=GB
   *   - Returns an array; no envelope.
   *   - Filtering by `status` server-side is preferred over post-filter so we
   *     don't fetch the entire catalogue.
   *
   * Why we transform a free-text `search` into a client-side substring filter
   * rather than passing it to Awin: the Awin /programmes endpoint doesn't
   * support a search parameter (verified against Awin docs 2025-Q4). A server
   * round-trip per character would be wrong; we filter the result set in-process.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const publisherId = requirePublisherId('listProgrammes');
    const token = requireToken('listProgrammes');

    const statusFilter = toStatusList(query?.status);
    const relationship = pickAwinRelationship(statusFilter);

    const raw = await awinRequest<AwinProgrammeRaw[]>({
      operation: 'listProgrammes',
      path: `/publishers/${publisherId}/programmes`,
      token,
      query: { relationship },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (Array.isArray(raw) ? raw : []).map(toProgramme);

    // Client-side filters: search substring, status set, categories.
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
   * Fetch a single programme by advertiser ID.
   *
   * Awin's `/programmedetails` endpoint takes `advertiserId` as a query param
   * (not a path segment, despite the singular noun). The response is a single
   * object — no array wrapper.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      // Validation error — surface as a config_error envelope so the user
      // sees actionable detail instead of an upstream 400.
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Awin advertiser IDs are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_awin_list_programmes) to find the correct id.',
        }),
      );
    }

    const publisherId = requirePublisherId('getProgramme');
    const token = requireToken('getProgramme');

    const raw = await awinRequest<AwinProgrammeRaw | { programmeInfo?: AwinProgrammeRaw }>({
      operation: 'getProgramme',
      path: `/publishers/${publisherId}/programmedetails`,
      token,
      query: { advertiserId: programmeId },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // Awin wraps the response in `programmeInfo` in some tenants; unwrap if so.
    const flat =
      (raw as { programmeInfo?: AwinProgrammeRaw })?.programmeInfo ?? (raw as AwinProgrammeRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions across a date window with optional status / age / programme filters.
   *
   * Awin endpoint:
   *   GET /publishers/{publisherId}/transactions/
   *     ?startDate=YYYY-MM-DDTHH:mm:ss
   *     &endDate=YYYY-MM-DDTHH:mm:ss
   *     &dateType=transaction
   *     &timezone=Europe/London
   *
   * Awin caps a single call at 31 days. Callers can request a wider window
   * via `query.from`/`query.to` — we chunk into 31-day slices automatically so
   * the user doesn't hit the cap by accident. A 90-day window therefore makes
   * 3 sequential calls; the resilience layer applies per-call.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` returns ONLY transactions whose computed `ageDays` is
   * >= the threshold. This is the principal affordance: a user asking "what
   * commissions are older than 180 days and still unpaid?" gets exactly that.
   *
   * We compute `ageDays` against `validationDate ?? transactionDate` (see
   * `computeAgeDays`). The filter is applied AFTER status filtering so a query
   * like `{ status: 'approved', minAgeDays: 180 }` is meaningful.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Reversed transactions (`commissionStatus: declined` upstream) are returned
   * unless the caller explicitly excludes them via `status`. The transformer
   * populates `reversalReason` from Awin's `declineReason` field so the user
   * sees why.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const publisherId = requirePublisherId('listTransactions');
    const token = requireToken('listTransactions');

    // Default window: last 30 days. Awin's 31-day cap means "no dates" must
    // resolve to something concrete or the API rejects the call.
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Chunk into ≤31-day slices.
    const slices = chunkDateRange(from, to, 31);

    const allRaw: AwinTransactionRaw[] = [];
    for (const slice of slices) {
      const chunk = await awinRequest<AwinTransactionRaw[]>({
        operation: 'listTransactions',
        path: `/publishers/${publisherId}/transactions/`,
        token,
        query: {
          startDate: formatAwinDate(slice.start),
          endDate: formatAwinDate(slice.end),
          dateType: 'transaction',
          // Why Europe/London: it's Awin's default reporting timezone and
          // matches what the dashboard shows. A user comparing API output
          // to the dashboard sees the same numbers. If we ever expose a
          // configurable timezone we MUST default to this one.
          timezone: 'Europe/London',
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      if (Array.isArray(chunk)) allRaw.push(...chunk);
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter — client-side because Awin's /transactions endpoint
    // doesn't support filtering by advertiser in a single call.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Status filter.
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

    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Why we derive from `listTransactions` rather than calling Awin's
   * `/reports/aggregated`:
   *   - The /reports/aggregated endpoint returns totals but NOT the per-
   *     transaction `ageDays`, so we still need /transactions to surface
   *     `oldestUnpaidAgeDays`. Two calls for the same data is wasteful.
   *   - The /reports endpoint's status buckets differ from the per-transaction
   *     status; trusting it would mean two sources of truth. Deriving from
   *     transactions keeps the calculation auditable — the user can
   *     `listTransactions` and recompute the same numbers.
   *   - Reports endpoints across networks (CJ, Impact) have a habit of going
   *     stale during settlement cycles; transactions are the canonical record.
   *
   * If a future requirement demands faster summaries for huge datasets we can
   * add a `/reports/aggregated` path as an optimisation while keeping this as
   * the source of truth.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Pull the underlying transactions (ignoring `limit` — a limit on a
    // summary would silently undercount, which violates principle 4.1).
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
      // Currency is "first observed". Awin transactions are typically
      // single-currency per publisher but we don't enforce that here; the
      // raw transactions retain their per-row currency.
      currency: 'GBP',
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      // Totals: count commission, not sale amount — the user's earnings, not
      // the merchant's gross.
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
          programmeName: t.programmeName || `Awin advertiser ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid age. Unpaid here means status in
      // {pending, approved} (approved-but-not-yet-paid is the principle 4.1
      // "the £42 from January is still pending after 95 days" case).
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
   * Awin does not expose click-level data via its public publisher API.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "Awin returned no clicks" and "Awin doesn't
   * expose clicks" is the difference between an actionable user observation
   * and a wild goose chase (PRD principle 4.1).
   *
   * If Awin adds click data to the API later, this becomes a real
   * implementation and we drop the `Click-level data is not exposed` line
   * from `META.knownLimitations`.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Awin does not expose click-level data via the public publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct an Awin deep-link.
   *
   * Format (the canonical Awin tracking URL):
   *
   *   https://www.awin1.com/cread.php
   *     ?awinmid={advertiserId}
   *     &awinaffid={publisherId}
   *     &clickref={subId}   (optional, omitted here)
   *     &ued={destinationUrl, URL-encoded}
   *
   * Why deterministic construction rather than an API call: Awin's deep-link
   * scheme is documented and stable. Calling an API would add latency and a
   * failure mode for no benefit — every property of the resulting URL is
   * already known to us at the moment of the call.
   *
   * If a future network requires an API round-trip to generate a link (Impact's
   * /Mediapartners/{accountSid}/Programs/{programId}/TrackingLinks does), that
   * adapter wraps its call through the resilience layer the same way every
   * other network call does. Deterministic construction is the optimisation,
   * not the rule.
   *
   * `programmeId` is required by Awin's deep-link format (it's the `awinmid`).
   * If the caller didn't supply one, we cannot construct the URL — we throw a
   * config_error envelope with an actionable hint rather than silently
   * defaulting to a "guessed" advertiser.
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
          message: 'Awin tracking links require the advertiser (programme) ID.',
          hint:
            'Pass `programmeId`. Use affiliate_awin_list_programmes to discover the ID for the merchant ' +
            'whose page you want to link to.',
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

    const publisherId = requirePublisherId('generateTrackingLink');

    // We don't call Awin here — see file-level comment for the rationale.
    // We DO require the token to be configured (sanity check) so users with
    // a half-configured environment learn at link-generation time, not at
    // first-click time.
    requireToken('generateTrackingLink');

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://www.awin1.com/cread.php` +
      `?awinmid=${encodeURIComponent(input.programmeId)}` +
      `&awinaffid=${encodeURIComponent(publisherId)}` +
      `&ued=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      // rawNetworkData carries the construction context so the user can see
      // exactly how the URL was assembled. There is no upstream API response
      // to attach.
      rawNetworkData: {
        format: 'awin1.com/cread.php deterministic construction',
        awinmid: input.programmeId,
        awinaffid: publisherId,
        ued: input.destinationUrl,
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth` which encapsulates the credential read,
   * /accounts call, and `derivedValues` extraction. The adapter surface
   * returns the contract type `{ ok: true, identity? } | { ok: false, reason }`;
   * the additional `derivedValues` field travels on the underlying type so the
   * wizard can pick it up while still respecting the public contract.
   */
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

  /**
   * Probe each operation with a minimal call to record live capability data.
   *
   * Design notes:
   *   - We probe with the smallest possible query (limit: 1, narrow date window
   *     for transactions) to keep total wall-clock time low.
   *   - `listClicks` is recorded as `supported: false` without probing — Awin
   *     doesn't have the endpoint, so calling it is pure waste.
   *   - Each probe is wrapped in try/catch; a single failing op does NOT block
   *     the others. The result captures the failure as `supported: false` with
   *     a `note` containing the message.
   *   - Latency is measured around the call so capabilitiesCheck output is
   *     useful for the diagnostic CLI ("is Awin slow today?").
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

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    // listClicks: known-unsupported. Record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Awin does not expose click-level data via the public publisher API',
    };

    // generateTrackingLink + getProgramme are deterministic enough that a probe
    // would either always succeed (link) or require a real advertiser id
    // (getProgramme). Record as supported-without-probe to keep the diagnostic
    // fast; the user can call them directly to confirm.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction; no live probe.',
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
}

// ---------------------------------------------------------------------------
// Module-level registration
// ---------------------------------------------------------------------------
//
// We register at module load via a side effect. Future contributors:
//
//   - If you don't import this file, the adapter is invisible to the server.
//     The expected import chain is:
//        server.ts → tools/generate.ts → registry.ts → (this file via
//        src/networks/index.ts aggregator).
//
//   - The aggregator (`src/networks/index.ts`) is the single place where
//     adapter modules get imported for their side effects. Adding a new
//     network means: write the folder, then add one line to the aggregator.
//
// We chose the aggregator pattern over per-adapter "import in server.ts" because:
//   1. It keeps `src/server.ts` agnostic of which networks exist.
//   2. It gives a single visible place to enable/disable a network.
//   3. Tests can import the aggregator to register all adapters at once, or
//      import a single adapter file to register one in isolation.
//
// Caveat: importing this module twice in the same process would attempt a
// double-register and `registry.registerAdapter` throws. The ES module cache
// prevents that in practice, but tests that clear the registry must also
// invoke `registerAdapter(new AwinAdapter())` explicitly.
// ---------------------------------------------------------------------------

export const awinAdapter = new AwinAdapter();
registerAdapter(awinAdapter);

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
 * Map our canonical ProgrammeStatus to Awin's `relationship` query param.
 *
 * Awin only exposes 'joined' / 'notjoined' / 'pending' on this endpoint. The
 * 'declined' and 'suspended' states are surfaced post-fetch from the response
 * body rather than as a server-side filter. We default to 'joined' because
 * that's by far the most common user question.
 */
function pickAwinRelationship(statuses?: ProgrammeStatus[]): string {
  if (!statuses || statuses.length === 0) return 'joined';
  if (statuses.includes('joined')) return 'joined';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('available')) return 'notjoined';
  return 'joined';
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Awin caps a single
 * /transactions call at 31 days; we chunk so callers can request wider windows
 * naturally and the adapter handles the pagination.
 *
 * Returns at least one slice; if `from > to` we still return one (zero-width)
 * slice so the call shape stays predictable.
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

/**
 * Format a Date for Awin's `startDate`/`endDate` query params.
 *
 * Awin accepts ISO-8601 to the second. We strip milliseconds and the trailing
 * `Z` because in our testing Awin sometimes rejects the millisecond suffix
 * (server-side parser quirk circa 2024) and the timezone is supplied
 * separately via the `timezone` param.
 */
function formatAwinDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatAwinDate,
  pickAwinRelationship,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
