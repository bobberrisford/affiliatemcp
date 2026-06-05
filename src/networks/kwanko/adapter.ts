/**
 * Kwanko adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` and mirrors
 * `src/networks/skimlinks/adapter.ts`. The Awin file is the canonical reference;
 * read it for the deep reasoning behind the structure. The load-bearing
 * decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Kwanko API map ------------------------------------------------------------
 *
 * Base URL: https://api.kwanko.com  (Bearer token in the Authorization header)
 *   Source: dltHub Kwanko source config (base_url, bearer auth, resources
 *           "conversions" + "statistics"); https://developers.kwanko.com/.
 *
 *   GET /publisher/campaigns                 → list campaigns (programmes)
 *   GET /publisher/campaigns/{campaignId}    → single campaign info
 *   GET /publisher/conversions               → conversions (leads/sales/downloads)
 *       ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *   GET /publisher/statistics                → aggregate stats (clicks, etc.)
 *
 * BLOCKED(verify): developers.kwanko.com is not machine-readable (403 to
 * automated fetch), so the exact path segments, query-parameter names, and JSON
 * field names above are taken from public API summaries. The adapter reads every
 * field defensively and preserves the verbatim payload in `rawNetworkData`. A
 * live-account test is required before promoting beyond `experimental`.
 *
 * --- Operation coverage --------------------------------------------------------
 *
 *   listProgrammes / getProgramme   → /publisher/campaigns
 *   listTransactions / getEarningsSummary → /publisher/conversions
 *   listClicks            → NotImplementedError (only aggregate clicks in stats)
 *   generateTrackingLink  → NotImplementedError (links are issued per campaign +
 *                           site from the dashboard; not constructible from the
 *                           token alone)
 *   verifyAuth            → minimal authenticated campaigns call
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `kwankoRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` — NEVER process.env (except in tests).
 *   7. UK English. "programme", not "program".
 */

import { kwankoRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireToken } from './auth.js';
import { setupSteps } from './setup.js';
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

const log = createLogger('kwanko.adapter');

const SLUG = 'kwanko';
const NAME = 'Kwanko';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.kwanko.com',
  authModel: 'bearer',
  docsUrl: 'https://developers.kwanko.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Exact endpoint paths, query-parameter names, and JSON field names are taken from public summaries of the Kwanko Web Service API (https://developers.kwanko.com/); the developer reference is not machine-readable, so field mapping is defensive and must be confirmed against a live response.',
    'listClicks is not exposed at click level: the Kwanko publisher API reports clicks only as an aggregate in the statistics endpoint, so the operation throws NotImplementedError rather than returning fabricated rows.',
    'generateTrackingLink is not implemented: Kwanko tracking links are issued per campaign and per site from the dashboard and cannot be constructed deterministically from the API token alone; the operation throws NotImplementedError.',
    'The API token is self-issued in the Kwanko platform (Features and API); it may optionally be IP-restricted in platform settings, which can cause auth failures from a different host.',
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
// Kwanko raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: the Kwanko developer reference is not machine-
// readable, so field names are not certain. Treating every field as possibly
// absent and preserving the original under `rawNetworkData` keeps the adapter
// robust to the real wire shape. BLOCKED(verify) against a live response.

interface KwankoConversionRaw {
  // Identifier — Kwanko summaries call these "conversions" (leads/sales/downloads).
  id?: string | number;
  conversion_id?: string | number;
  // Campaign association.
  campaign_id?: string | number;
  campaign_name?: string;
  // Status of the conversion: validated / pending / refused (varies).
  status?: string;
  state?: string;
  // Monetary fields.
  amount?: number | string; // gross sale / order amount
  commission?: number | string; // publisher commission
  currency?: string;
  // Dates (ISO 8601 expected; read defensively).
  click_date?: string;
  conversion_date?: string;
  date?: string;
  validation_date?: string;
  payment_date?: string;
  // Set when refused / cancelled.
  reason?: string;
  refusal_reason?: string;
}

interface KwankoConversionsResponse {
  // Different summaries describe the collection key as `data`, `conversions`,
  // or `items`; we read all three defensively.
  data?: KwankoConversionRaw[];
  conversions?: KwankoConversionRaw[];
  items?: KwankoConversionRaw[];
}

interface KwankoCampaignRaw {
  id?: string | number;
  campaign_id?: string | number;
  name?: string;
  title?: string;
  status?: string;
  state?: string;
  currency?: string;
  commission?: string; // human-readable commission description
  commission_rate?: string;
  categories?: string[];
  category?: string;
  url?: string;
  site_url?: string;
}

interface KwankoCampaignsResponse {
  data?: KwankoCampaignRaw[];
  campaigns?: KwankoCampaignRaw[];
  items?: KwankoCampaignRaw[];
}

interface KwankoCampaignResponse {
  data?: KwankoCampaignRaw;
  campaign?: KwankoCampaignRaw;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Kwanko conversion status string to the canonical TransactionStatus.
 *
 * Kwanko status → canonical (statuses confirmed semantically from public docs;
 * exact strings BLOCKED(verify) against a live response):
 *   waiting / pending / open     → 'pending'  (awaiting validation)
 *   validated / confirmed / open → 'approved' (validated, not yet paid)
 *   paid / settled               → 'paid'     (included in a payment)
 *   refused / cancelled / rejected → 'reversed' (did not pay out)
 *   anything else                → 'other'
 *
 * Why 'refused' → 'reversed': from the publisher's perspective a refused
 * conversion did not pay out — semantically a reversal, which is what every
 * other network calls this state. The verbatim status is preserved in
 * `rawNetworkData`.
 */
function mapTransactionStatus(raw: KwankoConversionRaw): TransactionStatus {
  const s = (raw.status ?? raw.state ?? '').toLowerCase().trim();
  if (s === 'pending' || s === 'waiting' || s === 'open' || s === 'wait') return 'pending';
  if (s === 'validated' || s === 'confirmed' || s === 'approved' || s === 'valid') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'refused' || s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'reversed')
    return 'reversed';
  return 'other';
}

/**
 * Map a Kwanko campaign relationship to the canonical ProgrammeStatus.
 *
 * Kwanko publisher campaigns are returned as those the publisher can promote or
 * has joined. We default to 'unknown' for any value we cannot confidently map.
 *
 *   active / open / running     → 'joined'
 *   pending / waiting           → 'pending'
 *   refused / declined          → 'declined'
 *   available / not_joined      → 'available'
 *   suspended / paused / closed → 'suspended'
 *   anything else               → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string; state?: string }): ProgrammeStatus {
  const s = (raw.status ?? raw.state ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'open' || s === 'running' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'waiting') return 'pending';
  if (s === 'refused' || s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'not_joined' || s === 'notjoined') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'closed') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Kwanko conversion at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: validation_date (how long has this been validated-but-not-
 * paid?) falls back to conversion_date, then the click date. For pending
 * conversions, the conversion date is the earliest meaningful anchor.
 */
function computeAgeDays(raw: KwankoConversionRaw, now: Date = new Date()): number {
  const anchor =
    raw.validation_date ?? raw.conversion_date ?? raw.date ?? raw.click_date;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
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

function toTransaction(raw: KwankoConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission);
  const sale = toAmount(raw.amount);
  const currency = (raw.currency ?? 'EUR').toUpperCase();

  const convertedRaw = raw.conversion_date ?? raw.date;
  const transactionDate = nullableIso(convertedRaw) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.click_date);
  const approvedDate = nullableIso(raw.validation_date);
  const paidDate = nullableIso(raw.payment_date);

  return {
    id: String(raw.id ?? raw.conversion_id ?? ''),
    network: SLUG,
    programmeId: String(raw.campaign_id ?? ''),
    programmeName: raw.campaign_name ?? `Kwanko campaign ${raw.campaign_id ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.refusal_reason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: KwankoCampaignRaw): Programme {
  const status = mapProgrammeStatus(raw);
  const categories = raw.categories ?? (raw.category ? [raw.category] : undefined);
  const commissionRate = raw.commission_rate ?? raw.commission;

  const programme: Programme = {
    id: String(raw.id ?? raw.campaign_id ?? ''),
    name: raw.name ?? raw.title ?? `Kwanko campaign ${raw.id ?? raw.campaign_id ?? ''}`,
    network: SLUG,
    status,
    rawNetworkData: raw,
  };
  if (raw.currency) programme.currency = raw.currency.toUpperCase();
  if (commissionRate) programme.commissionRate = commissionRate;
  if (categories) programme.categories = categories;
  const advertiserUrl = raw.url ?? raw.site_url;
  if (advertiserUrl) programme.advertiserUrl = advertiserUrl;
  return programme;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class KwankoAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the publisher's Kwanko campaigns (programmes).
   *
   *   GET /publisher/campaigns
   *
   * BLOCKED(verify): the collection key (`data` / `campaigns` / `items`) and the
   * filter parameter names are taken from public summaries; we read all known
   * collection keys defensively and filter client-side after normalisation so
   * the result is correct regardless of which key the live API uses.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');

    const params: Record<string, string | number | undefined> = {};
    if (typeof query?.limit === 'number') params['per_page'] = query.limit;
    if (query?.search) params['search'] = query.search;

    const response = await kwankoRequest<KwankoCampaignsResponse>({
      operation: 'listProgrammes',
      path: '/publisher/campaigns',
      token,
      query: params,
      resilience: RESILIENCE.default,
    });

    const rawCampaigns = pickCampaignArray(response);
    let programmes = rawCampaigns.map((c) => toProgramme(c));

    // Client-side status filter — applied on the canonical status after mapping.
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

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single Kwanko campaign by id.
   *
   *   GET /publisher/campaigns/{campaignId}
   *
   * BLOCKED(verify): the single-resource wrapper key (`data` / `campaign`) is
   * read defensively.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const token = requireToken('getProgramme');

    const response = await kwankoRequest<KwankoCampaignResponse>({
      operation: 'getProgramme',
      path: `/publisher/campaigns/${encodeURIComponent(programmeId)}`,
      token,
      resilience: RESILIENCE.default,
    });

    const raw = response.data ?? response.campaign ?? (response as KwankoCampaignRaw);
    return toProgramme(raw);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Kwanko conversions across a date window with optional status / age /
   * programme filters.
   *
   *   GET /publisher/conversions
   *     ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
   *
   * We default to a 30-day window when none is specified. No documented maximum
   * window was found in the public summaries (BLOCKED(verify): confirm with a
   * live account). Status, age, and programme filtering are applied client-side
   * on the normalised canonical status so the result is correct regardless of
   * the upstream status vocabulary.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` / `query.maxAgeDays` filter on the computed `ageDays`.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Refused conversions are normalised to 'reversed' and their refusal reason
   * surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      start_date: from.toISOString().slice(0, 10),
      end_date: to.toISOString().slice(0, 10),
    };
    if (query?.programmeId) {
      params['campaign_id'] = query.programmeId;
    }

    const response = await kwankoRequest<KwankoConversionsResponse>({
      operation: 'listTransactions',
      path: '/publisher/conversions',
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawConversions = pickConversionArray(response);
    let transactions = rawConversions.map((r) => toTransaction(r, now));

    // Programme filter — also applied client-side in case the upstream filter
    // param name differs from our guess.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Status filter on the normalised canonical status.
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate conversions into an earnings summary.
   *
   * We derive from `listTransactions` for the same reason as Awin: a dedicated
   * report endpoint would be a second source of truth for the same data, and we
   * still need the per-transaction `ageDays` to compute `oldestUnpaidAgeDays`.
   * One call, one source.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (principle 4.1).
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
          programmeName: t.programmeName || `Kwanko campaign ${key}`,
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
   * Kwanko does not expose click-level data via the publisher API — clicks are
   * reported only as an aggregate count in the statistics endpoint.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed at row
   * level by the API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Kwanko does not expose click-level data via the publisher API; clicks are only ' +
        'available as an aggregate in the statistics endpoint.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Kwanko tracking links are issued per campaign AND per site from the
   * dashboard (the tracked-link / clickserv URL embeds site and campaign
   * identifiers that are not derivable from the API token). There is no
   * documented deterministic public URL construction, so we throw
   * NotImplementedError rather than emit a link that would not track.
   *
   * If a future API version exposes a link-generation endpoint or the necessary
   * site/campaign tracking identifiers, replace this throw with the construction.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Kwanko tracking links are issued per campaign and per site from the dashboard and ' +
        'cannot be constructed deterministically from the API token alone. Generate the ' +
        'tracked link in the Kwanko platform instead.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by making a minimal authenticated campaigns call.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure: returns { ok: false, reason: '...' }. Never throws.
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
   * Probe each operation with a minimal call.
   *
   * listClicks and generateTrackingLink are known-unsupported and are recorded
   * without probing to avoid wasting network calls.
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

    // Known-unsupported ops — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Kwanko exposes clicks only as an aggregate in the statistics endpoint, not at row level.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Kwanko tracking links are issued per campaign and per site from the dashboard; not constructible from the API token.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

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

export const kwankoAdapter = new KwankoAdapter();
registerAdapter(kwankoAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function pickConversionArray(response: KwankoConversionsResponse): KwankoConversionRaw[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.conversions)) return response.conversions;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function pickCampaignArray(response: KwankoCampaignsResponse): KwankoCampaignRaw[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.campaigns)) return response.campaigns;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toProgrammeStatusList(
  v?: ProgrammeStatus | ProgrammeStatus[],
): ProgrammeStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

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
  pickConversionArray,
  pickCampaignArray,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
