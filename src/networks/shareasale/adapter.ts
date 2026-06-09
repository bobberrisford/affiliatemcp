/**
 * ShareASale adapter — publisher side, single-brand, US network.
 *
 * Pattern source: `src/networks/awin/adapter.ts` (read its header first). Two
 * structural notes:
 *   - Auth: ShareASale signs every request with an HMAC-SHA256 digest carried
 *     in `x-ShareASale-Authentication` (plus an `x-ShareASale-Date` header)
 *     rather than a bearer token. The signing lives in `client.ts`; this
 *     adapter only declares operations and transforms responses.
 *   - Standalone: ShareASale is Awin-owned but runs on a SEPARATE account and
 *     a SEPARATE API. This adapter is built standalone and does NOT reuse the
 *     Awin adapter.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — merchant relationships (merchantStatus report)
 *   getProgramme        — single merchant drill-down (client-side from the list)
 *   listTransactions    — commission activity (activity report); date-filtered,
 *                         chunked across wide windows
 *   getEarningsSummary  — client-side aggregation over listTransactions
 *   listClicks          — NotImplementedError (not exposed by the public API)
 *   generateTrackingLink— deterministic shareasale.com/r.cfm deep link
 *   verifyAuth          — cheap signed call (merchantStatus)
 *
 * --- Honesty note (PRD principle 4.1) ---------------------------------------
 *
 * This adapter is EXPERIMENTAL. The affiliate endpoint shapes are inferred from
 * public API documentation (account.shareasale.com/a-apimanager.cfm and the
 * third-party references listed in docs/networks/shareasale.md). Field names,
 * the amount unit, and the response envelopes have NOT been confirmed against a
 * live account. Every transformer reads fields defensively and preserves the
 * verbatim payload on `rawNetworkData` so the user always sees what ShareASale
 * actually returned.
 *
 * --- Cardinal rules (same as Awin) ------------------------------------------
 *   1. NEVER call `fetch` directly — go through `shareasaleRequest`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response in `rawNetworkData`.
 *   4. NORMALISE status enums; prefer 'other'/'unknown' over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction.
 *   6. UK English; the noun is "programme".
 */

import { shareasaleRequest, SHAREASALE_SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireCredentials,
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

const log = createLogger('shareasale.adapter');

const SLUG = SHAREASALE_SLUG;
const NAME = 'ShareASale';

/**
 * Default currency. ShareASale is a US network and amounts are reported in USD.
 * We do NOT invent a currency: where a row carries one we use it, otherwise we
 * fall back to USD and document the assumption in META.
 */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.shareasale.com',
  // `custom`: ShareASale signs each request with an HMAC-SHA256 digest
  // (x-ShareASale-Authentication) rather than a bearer token. See client.ts.
  authModel: 'custom',
  docsUrl: 'https://account.shareasale.com/a-apimanager.cfm',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: not validated against a live account; shapes inferred from
  // public API documentation.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'Commission amounts are assumed to be major-currency units (USD) as returned by the API; the unit is not authoritatively documented and is preserved verbatim on rawNetworkData.',
    'Requests are HMAC-SHA256 signed (x-ShareASale-Authentication) over a token:date:action:secret string; a clock skewed from GMT will produce signature failures.',
    'ShareASale is Awin-owned but runs on a separate account and a separate API; this adapter is standalone and does not reuse the Awin adapter.',
    'Click-level data is not exposed via the public affiliate API; listClicks is unsupported.',
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
 * The activity report can be slow when a wide date window spans many records
 * and the report engine is warm-loading. We give listTransactions a longer
 * timeout and one extra retry, mirroring Awin's reasoning.
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
// ShareASale response shapes (deliberately minimal — every field optional)
// ---------------------------------------------------------------------------
//
// ShareASale's affiliate API returns either a top-level array of rows or a
// `{ result: [...] }`-style envelope depending on the action and version. We
// model only the keys we read; transformers tolerate missing keys and keep the
// verbatim object on rawNetworkData. Field names are inferred and unverified.
// ---------------------------------------------------------------------------

interface ShareasaleEnvelope<T> {
  result?: T;
  data?: T;
  records?: T;
  total?: number;
}

interface ShareasaleMerchantRaw {
  merchantId?: number | string;
  merchantid?: number | string;
  organization?: string;
  merchantName?: string;
  name?: string;
  status?: string;
  relationship?: string;
  category?: string;
  categories?: string[];
  commission?: string | number;
  currency?: string;
  url?: string;
  domain?: string;
}

interface ShareasaleActivityRaw {
  transID?: number | string;
  transId?: number | string;
  transactionId?: number | string;
  merchantId?: number | string;
  merchantid?: number | string;
  merchantOrganization?: string;
  merchant?: string;
  // ShareASale activity rows carry a transaction state; the labels are not
  // authoritatively documented. We read the common variants defensively.
  transactionStatus?: string;
  status?: string;
  voided?: string | boolean;
  paid?: string | boolean;
  // Monetary fields. `commission` is the affiliate payout; `transAmount` /
  // `saleAmount` is the order value. Both read as string or number.
  commission?: string | number;
  transAmount?: string | number;
  saleAmount?: string | number;
  currency?: string;
  // Date fields, names inferred. `transDate` is the conversion/order date.
  transDate?: string;
  date?: string;
  dateClicked?: string;
  clickDate?: string;
  lockDate?: string;
  voidDate?: string;
  paidDate?: string;
  comment?: string;
  voidReason?: string;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Activity status: ShareASale → canonical.
 *
 * ShareASale represents a commission state across a few fields rather than one
 * canonical enum: a `voided`/`paid` flag plus a textual status. We derive the
 * canonical status, preferring explicit flags, and fall back to 'other' so we
 * never invent a status the user did not see:
 *
 *   voided / reversed / declined / returned   → 'reversed'
 *   paid                                       → 'paid'
 *   locked / approved / accepted               → 'approved'
 *   pending / new / unlocked                    → 'pending'
 *   anything else                              → 'other'
 *
 * The raw value is always kept on rawNetworkData.
 */
function mapActivityStatus(raw: ShareasaleActivityRaw): TransactionStatus {
  if (isTrueFlag(raw.voided)) return 'reversed';
  if (isTrueFlag(raw.paid)) return 'paid';

  const s = String(raw.transactionStatus ?? raw.status ?? '').toLowerCase().trim();
  if (s === 'voided' || s === 'void' || s === 'reversed' || s === 'declined' || s === 'returned') {
    return 'reversed';
  }
  if (s === 'paid') return 'paid';
  if (s === 'locked' || s === 'approved' || s === 'accepted') return 'approved';
  if (s === 'pending' || s === 'new' || s === 'unlocked') return 'pending';
  return 'other';
}

/**
 * Merchant relationship: ShareASale → canonical ProgrammeStatus.
 *
 * The merchantStatus report lists the affiliate's relationship with each
 * merchant. ShareASale relationship labels are not authoritatively documented;
 * we map the recognised values and fall back to 'unknown':
 *
 *   approved / active / joined                 → 'joined'
 *   pending / applied / in review              → 'pending'
 *   declined / rejected / denied               → 'declined'
 *   removed / not joined / available           → 'available'
 *   suspended / paused / closed                → 'suspended'
 *   anything else                              → 'unknown'
 */
function mapMerchantStatus(raw: ShareasaleMerchantRaw): ProgrammeStatus {
  const s = String(raw.status ?? raw.relationship ?? '').toLowerCase().trim();
  if (s === 'approved' || s === 'active' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'applied' || s === 'in review' || s === 'in-review') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'denied') return 'declined';
  if (s === 'removed' || s === 'not joined' || s === 'notjoined' || s === 'available') {
    return 'available';
  }
  if (s === 'suspended' || s === 'paused' || s === 'closed') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTrueFlag(v: string | boolean | undefined): boolean {
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  }
  return false;
}

function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // Strip currency symbols and thousands separators; ShareASale amounts are
    // typically plain decimals but we tolerate "$1,234.56" defensively.
    const cleaned = v.replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Age (in days) of a transaction at response time. We anchor on the conversion
 * date; a paid date, when present, is older context and not the anchor we want
 * for the unpaid-age affordance (PRD §15.9).
 */
function computeAgeDays(raw: ShareasaleActivityRaw, now: Date = new Date()): number {
  const anchor = raw.transDate ?? raw.date ?? raw.lockDate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Format a Date as `MM/DD/YYYY` for ShareASale's `dateStart`/`dateEnd`
 * filters. ShareASale is a US network and the documented date filter format is
 * US month/day/year.
 */
function toShareasaleDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ShareasaleMerchantRaw): Programme {
  const id = String(raw.merchantId ?? raw.merchantid ?? '');
  const categories =
    raw.categories && raw.categories.length > 0
      ? raw.categories
      : raw.category
        ? [raw.category]
        : [];
  return {
    id,
    name: raw.organization ?? raw.merchantName ?? raw.name ?? `ShareASale merchant ${id}`,
    network: SLUG,
    status: mapMerchantStatus(raw),
    currency: raw.currency ?? DEFAULT_CURRENCY,
    commissionRate:
      raw.commission !== undefined
        ? { type: 'unknown', description: String(raw.commission) }
        : undefined,
    categories,
    advertiserUrl: raw.url ?? raw.domain,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ShareasaleActivityRaw, now: Date = new Date()): Transaction {
  const status = mapActivityStatus(raw);
  const commission = toNumber(raw.commission);
  const amount = toNumber(raw.transAmount ?? raw.saleAmount);
  const currency = raw.currency ?? DEFAULT_CURRENCY;
  const converted = nullableIso(raw.transDate ?? raw.date);

  return {
    id: String(raw.transID ?? raw.transId ?? raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.merchantId ?? raw.merchantid ?? ''),
    programmeName: raw.merchantOrganization ?? raw.merchant ?? '',
    status,
    amount,
    currency,
    commission,
    dateClicked: nullableIso(raw.dateClicked ?? raw.clickDate),
    dateConverted: converted ?? new Date(0).toISOString(),
    dateApproved: nullableIso(raw.lockDate),
    datePaid: nullableIso(raw.paidDate),
    ageDays: computeAgeDays(raw, now),
    // ShareASale exposes a void reason / comment on reversed rows; surface it
    // where present (PRD §15.10).
    reversalReason:
      status === 'reversed' ? raw.voidReason ?? raw.comment ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class ShareasaleAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the affiliate's merchant relationships (programmes).
   *
   * ShareASale endpoint: action=merchantStatus — returns the merchants the
   * affiliate has a relationship with and the join state. No server-side
   * search/status/category filter is documented, so all filtering is
   * client-side (matching Awin's approach).
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const credentials = requireCredentials('listProgrammes');

    const raw = await shareasaleRequest<
      ShareasaleEnvelope<ShareasaleMerchantRaw[]> | ShareasaleMerchantRaw[]
    >({
      operation: 'listProgrammes',
      action: 'merchantStatus',
      credentials,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const list = unwrapList<ShareasaleMerchantRaw>(raw);
    let programmes = list.map(toProgramme);

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
   * Fetch a single merchant by id.
   *
   * ShareASale's merchantStatus report does not document a single-merchant
   * variant, so we derive the one programme from the merchant list (the same
   * source as listProgrammes). If the id is not present we throw a
   * network_api_error envelope rather than fabricating a stub (PRD §4.1).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A ShareASale merchant id is required.',
          hint: 'List programmes first (affiliate_shareasale_list_programmes) to find the id.',
        }),
      );
    }

    const all = await this.listProgrammes();
    const match = all.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No ShareASale merchant found with id "${programmeId}".`,
          hint: 'Use affiliate_shareasale_list_programmes to discover valid merchant ids.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commission activity across a date window with optional status / age /
   * programme filters.
   *
   * ShareASale endpoint: action=activity with `dateStart`/`dateEnd`
   * (`MM/DD/YYYY`). ShareASale reports are commonly capped at roughly a month
   * per call, so we chunk wide windows into ≤31-day slices the same way Awin
   * does. If a different cap surfaces in live testing, adjust the slice size.
   *
   * Default window: last 30 days when the caller supplies none.
   *
   * §15.9 unpaid-age filter and §15.10 reversed-sale visibility behave exactly
   * as in the Awin reference.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const credentials = requireCredentials('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: ShareasaleActivityRaw[] = [];
    for (const slice of slices) {
      const chunk = await shareasaleRequest<
        ShareasaleEnvelope<ShareasaleActivityRaw[]> | ShareasaleActivityRaw[]
      >({
        operation: 'listTransactions',
        action: 'activity',
        credentials,
        query: {
          dateStart: toShareasaleDate(slice.start),
          dateEnd: toShareasaleDate(slice.end),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...unwrapList<ShareasaleActivityRaw>(chunk));
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
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate commission activity into an earnings summary, derived client-side
   * from listTransactions (same reasoning as Awin: one auditable source of
   * truth, the user can recompute it by calling listTransactions themselves).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Drop `limit` — a limited summary would silently undercount (principle 4.1).
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
          programmeName: t.programmeName || `ShareASale merchant ${key}`,
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
   * ShareASale does not expose click-level data via its public affiliate API.
   * We throw `NotImplementedError` rather than returning an empty array so the
   * caller can tell "no clicks" from "no endpoint" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'ShareASale does not expose click-level data via the public affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a ShareASale deep link.
   *
   * Format (the documented ShareASale custom-link / deep-link scheme):
   *
   *   https://shareasale.com/r.cfm
   *     ?b={bannerId}             (link/banner id — ShareASale requires one)
   *     &u={affiliateId}
   *     &m={merchantId}
   *     &urllink={destinationUrl} (target page, URL-encoded)
   *
   * Why deterministic construction rather than an API call: ShareASale's
   * r.cfm deep-link scheme is documented and stable, so every property of the
   * resulting URL is known at call time (matching Awin's reasoning).
   *
   * The `b` (banner/link id) parameter is structurally required by r.cfm.
   * ShareASale's custom-link generator uses a designated text-link banner id;
   * we default to `0`, which ShareASale resolves to the merchant's default
   * text link, and let the caller override it via the
   * `SHAREASALE_DEFAULT_BANNER_ID` env var if their account needs a specific
   * one. `programmeId` is the merchant id (`m`) and is required.
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
          message: 'ShareASale tracking links require the merchant (programme) id.',
          hint:
            'Pass `programmeId`. Use affiliate_shareasale_list_programmes to discover the merchant id ' +
            'for the programme whose page you want to link to.',
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

    // Require credentials so a half-configured environment fails here rather
    // than at first click. We only need the affiliate id for the link itself.
    const credentials = requireCredentials('generateTrackingLink');
    const bannerId = process.env['SHAREASALE_DEFAULT_BANNER_ID']?.trim() || '0';

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://shareasale.com/r.cfm` +
      `?b=${encodeURIComponent(bannerId)}` +
      `&u=${encodeURIComponent(credentials.affiliateId)}` +
      `&m=${encodeURIComponent(input.programmeId)}` +
      `&urllink=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'shareasale.com/r.cfm deterministic construction',
        b: bannerId,
        u: credentials.affiliateId,
        m: input.programmeId,
        urllink: input.destinationUrl,
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
    await probe('verifyAuth', () => this.verifyAuth());

    operations['getProgramme'] = {
      supported: true,
      note: 'Derived from the merchant-status list; requires a known merchant id, not probed automatically.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic r.cfm URL construction; no live probe.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'ShareASale does not expose click-level data via the public affiliate API',
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
// Module-level registration (see Awin's adapter for the aggregator rationale)
// ---------------------------------------------------------------------------

export const shareasaleAdapter = new ShareasaleAdapter();
registerAdapter(shareasaleAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a ShareASale envelope (`{ result | data | records: [...] }`) or a bare
 * array into a plain array. Tolerates a missing/non-array payload by returning [].
 */
function unwrapList<T>(raw: ShareasaleEnvelope<T[]> | T[]): T[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.result)) return raw.result;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.records)) return raw.records;
  return [];
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

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks (mirrors Awin's helper).
 * Returns at least one slice; if `from >= to` we return one (zero-width) slice
 * so the call shape stays predictable.
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

// Internal test helpers — exported under `_internals` so they stay off the
// public adapter surface.
export const _internals = {
  mapActivityStatus,
  mapMerchantStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toShareasaleDate,
  toNumber,
  chunkDateRange,
  isTrueFlag,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
