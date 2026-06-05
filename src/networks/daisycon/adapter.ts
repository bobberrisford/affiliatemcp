/**
 * Daisycon adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` and the
 * OAuth2 reference `src/networks/skimlinks/adapter.ts`. Read those for the deep
 * reasoning behind the structure. The load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction; `now` is injected for determinism.
 *   - UK English; "programme" not "program".
 *
 * --- Daisycon API map ----------------------------------------------------------
 *
 * OAuth2 token endpoint (refresh_token grant — see client.ts / auth.ts):
 *   POST https://login.daisycon.com/oauth/access-token
 *     grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...
 *   → { access_token, token_type, expires_in }
 *
 * Services API (base: https://services.daisycon.com):
 *   GET /publishers/{publisherId}/transactions
 *     ?page=N&per_page=N&date_modified_start=YYYY-MM-DD[&date_modified_end=YYYY-MM-DD]
 *     [&currency_code=ISO4217][&status=open|approved|disapproved|paid|pending]
 *     [&program_id=N]
 *   Total row count in the `x-total-count` response header.
 *   Source: https://github.com/whitelabeled/daisycon-api-client
 *           https://strackr.com/docs/daisycon
 *
 *   GET /publishers/{publisherId}/programs
 *     ?page=N&per_page=N
 *   BLOCKED(verify): the exact programmes path/params are confirmed only via
 *   secondary sources; verify against a live account before promoting claim_status.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `daisyconRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope` (network +
 *      operation + httpStatus + verbatim networkErrorBody). Never swallow errors.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus` and `mapProgrammeStatus`.
 *      Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` from shared/config — NEVER process.env
 *      (except in tests).
 *   7. UK English. "programme", not "program".
 */

import { daisyconRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken } from './auth.js';
import { setupSteps } from './setup.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('daisycon.adapter');

const SLUG = 'daisycon';
const NAME = 'Daisycon';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://services.daisycon.com',
  authModel: 'oauth2',
  docsUrl: 'https://developers.daisycon.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Daisycon uses OAuth2 with an interactive authorization_code + PKCE consent; the adapter then uses the refresh_token grant for non-interactive token exchange. The user must complete the one-time authorisation to obtain DAISYCON_REFRESH_TOKEN. Whether Daisycon also offers a pure client_credentials grant for first-party accounts is unconfirmed.',
    'listClicks is not exposed via the public Daisycon publisher API; the operation throws NotImplementedError.',
    'generateTrackingLink throws NotImplementedError: a Daisycon tracking (click) URL is issued per programme/media binding by Daisycon and is not deterministically constructible from credentials alone; the click URL must be read from the programme/media data, which the public docs do not document a stable shape for.',
    'OAuth2 access tokens are short-lived; the adapter caches the token in memory and re-fetches on expiry. The refresh token itself may rotate or expire and then requires re-authorisation.',
    'The exact /publishers/{id}/programs path and the maximum per_page page size are confirmed only via secondary sources; live account verification required.',
    'Transactions are multi-currency: the currency is read per row from the upstream payload, not assumed.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 15,
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

// Daisycon's documented client uses per_page=200; we follow that.
const PER_PAGE = 200;
// Safety cap on pages fetched in a single call so a misbehaving upstream
// total-count header cannot loop us indefinitely.
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Daisycon raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Daisycon's field set varies across resources and
// account types. Treating every field as possibly absent and preserving the
// original under `rawNetworkData` keeps the adapter robust to upstream drift.

interface DaisyconTransactionRaw {
  // Field names from the Daisycon publisher transactions resource, corroborated
  // by the whitelabeled/daisycon-api-client client and Strackr's parameter docs.
  // Live verification against a real account is required before bumping claim_status.
  id?: string | number;
  transaction_id?: string | number;
  program_id?: string | number;
  affiliatemarketing_id?: string | number;
  program_name?: string;
  advertiser_name?: string;
  status?: string; // open | approved | disapproved | paid | pending (varies)
  currency_code?: string;
  amount?: number | string; // gross order/sale value
  amount_open?: number | string;
  commission?: number | string; // publisher commission
  fee?: number | string; // synonym for commission seen in some responses
  date_click?: string; // ISO 8601
  date?: string; // conversion date (ISO 8601)
  date_transaction?: string; // conversion date (alt name)
  date_modified?: string; // ISO 8601
  date_paid?: string; // ISO 8601
  disapproved_reason?: string;
  reason?: string;
}

interface DaisyconProgrammeRaw {
  id?: string | number;
  program_id?: string | number;
  name?: string;
  status?: string; // active | pending | declined | available | ...
  media_subscription_status?: string;
  currency_code?: string;
  commission?: unknown;
  commissions?: unknown;
  categories?: Array<{ name?: string }> | string[];
  category?: string;
  url?: string;
  website?: string;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Daisycon transaction status string to the canonical TransactionStatus.
 *
 * Daisycon status → canonical:
 *   open / pending        → 'pending'   (awaiting validation)
 *   approved              → 'approved'  (validated, not yet paid out)
 *   paid                  → 'paid'      (included in a publisher payment)
 *   disapproved / declined→ 'reversed'  (commission was rejected/reversed)
 *   anything else         → 'other'
 *
 * Why 'disapproved' → 'reversed': from the publisher's perspective a disapproved
 * transaction means the sale did not pay out — semantically a reversal, which is
 * what every other network calls this state. The verbatim status is preserved in
 * `rawNetworkData`.
 */
function mapTransactionStatus(raw: DaisyconTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'open' || s === 'pending') return 'pending';
  if (s === 'approved') return 'approved';
  if (s === 'paid') return 'paid';
  if (s === 'disapproved' || s === 'declined' || s === 'rejected' || s === 'reversed') {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map a Daisycon programme/subscription status to the canonical ProgrammeStatus.
 *
 *   active / subscribed / accepted → 'joined'
 *   pending / in_review            → 'pending'
 *   declined / rejected            → 'declined'
 *   available / not_subscribed     → 'available'
 *   suspended / paused / inactive  → 'suspended'
 *   anything else                  → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string; media_subscription_status?: string }): ProgrammeStatus {
  const s = (raw.media_subscription_status ?? raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'subscribed' || s === 'accepted' || s === 'joined') return 'joined';
  if (s === 'pending' || s === 'in_review' || s === 'on_hold') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'not_subscribed' || s === 'open') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'inactive') return 'suspended';
  return 'unknown';
}

/**
 * Map a single canonical TransactionStatus to the Daisycon `status` query value.
 * Returns undefined when the set requires client-side filtering (multiple
 * statuses, or a status with no upstream equivalent).
 */
function mapCanonicalToDaisyconStatus(statuses?: TransactionStatus[]): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':  return 'open';
    case 'approved': return 'approved';
    case 'reversed': return 'disapproved';
    case 'paid':     return 'paid';
    default:         return undefined;
  }
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Daisycon transaction at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: conversion date (date / date_transaction), falling back to
 * date_modified, then date_click.
 */
function computeAgeDays(raw: DaisyconTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.date ?? raw.date_transaction ?? raw.date_modified ?? raw.date_click;
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

function toTransaction(raw: DaisyconTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission ?? raw.fee);
  const sale = toAmount(raw.amount ?? raw.amount_open);
  // Multi-currency: read per row, never assume a default beyond a last resort.
  const currency = (raw.currency_code ?? 'EUR').toUpperCase();

  const programmeId = String(raw.program_id ?? raw.affiliatemarketing_id ?? '');
  const conversionDate =
    nullableIso(raw.date ?? raw.date_transaction) ?? new Date(0).toISOString();

  return {
    id: String(raw.id ?? raw.transaction_id ?? ''),
    network: SLUG,
    programmeId,
    programmeName: raw.program_name ?? raw.advertiser_name ?? `Daisycon programme ${programmeId}`,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: nullableIso(raw.date_click),
    dateConverted: conversionDate,
    dateApproved: status === 'approved' || status === 'paid' ? nullableIso(raw.date_modified) : undefined,
    datePaid: status === 'paid' ? nullableIso(raw.date_paid ?? raw.date_modified) : undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.disapproved_reason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function extractCommissionRate(raw: DaisyconProgrammeRaw): string | CommissionRateStructured | undefined {
  // Daisycon programme commission shapes vary widely (flat, percent, tiered,
  // per-category). We do not guess a structured value; we surface the verbatim
  // commission payload as a description so the operator can drill in via raw data.
  const c = raw.commission ?? raw.commissions;
  if (c === undefined || c === null) return undefined;
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  return {
    type: 'unknown',
    description: 'See rawNetworkData.commission for the verbatim Daisycon commission structure.',
  };
}

function extractCategories(raw: DaisyconProgrammeRaw): string[] | undefined {
  if (Array.isArray(raw.categories)) {
    const names = raw.categories
      .map((c) => (typeof c === 'string' ? c : c?.name))
      .filter((c): c is string => typeof c === 'string' && c.length > 0);
    return names.length > 0 ? names : undefined;
  }
  if (raw.category) return [raw.category];
  return undefined;
}

function toProgramme(raw: DaisyconProgrammeRaw): Programme {
  const id = String(raw.id ?? raw.program_id ?? '');
  const programme: Programme = {
    id,
    name: raw.name ?? `Daisycon programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
  if (raw.currency_code) programme.currency = raw.currency_code.toUpperCase();
  const rate = extractCommissionRate(raw);
  if (rate !== undefined) programme.commissionRate = rate;
  const categories = extractCategories(raw);
  if (categories) programme.categories = categories;
  const url = raw.url ?? raw.website;
  if (url) programme.advertiserUrl = url;
  return programme;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requirePublisherId(operation: string): string {
  return requireCredential('DAISYCON_PUBLISHER_ID', {
    network: SLUG,
    operation,
    hint:
      'Set DAISYCON_PUBLISHER_ID in ~/.affiliate-mcp/.env. ' +
      'Find your Publisher ID in the Daisycon publisher console URL or account settings.',
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class DaisyconAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the publisher's Daisycon programmes from the programmes endpoint.
   *
   *   GET /publishers/{publisherId}/programs?page=N&per_page=N
   *
   * Pagination is page-based; the total row count is returned in the
   * `x-total-count` header. We fetch pages until we have all rows (capped by
   * MAX_PAGES so a bad header cannot loop us). Status / search / category
   * filters are applied client-side after normalisation.
   *
   * BLOCKED(verify): the exact path and parameter set are confirmed only via
   * secondary sources; verify against a live account.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const publisherId = requirePublisherId('listProgrammes');
    const token = await getAccessToken();

    const rawProgrammes = await this.fetchAllPages<DaisyconProgrammeRaw>(
      'listProgrammes',
      `/publishers/${publisherId}/programs`,
      token,
      {},
    );

    let programmes = rawProgrammes.map((r) => toProgramme(r));

    const statusFilter = toArray(query?.status);
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
   * Fetch a single programme by id.
   *
   * Daisycon's programmes resource does not document a stable single-programme
   * sub-path for publishers, so we fetch the publisher's programmes and select
   * the matching id. If no programme matches, we throw NotImplementedError-free
   * NetworkError-free behaviour is preferred: we surface a clear error.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const all = await this.listProgrammes();
    const match = all.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NotImplementedError(
        `Daisycon programme "${programmeId}" was not found in the publisher's programmes list. ` +
          'Daisycon does not document a stable single-programme lookup path for publishers; ' +
          'the programme must appear in /publishers/{id}/programs.',
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Daisycon transactions across a date window with optional status / age /
   * programme filters.
   *
   *   GET /publishers/{publisherId}/transactions
   *     ?page=N&per_page=N&date_modified_start=YYYY-MM-DD[&date_modified_end=YYYY-MM-DD]
   *     [&currency_code=ISO4217][&status=open|approved|disapproved|paid][&program_id=N]
   *
   * Daisycon filters by `date_modified_start` (required) rather than a conversion
   * window; we map `query.from`/`query.to` onto the modified-date window. Total
   * row count is in the `x-total-count` header; we page until complete.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   * `query.minAgeDays` / `maxAgeDays` filter on the computed `ageDays` after
   * status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   * Disapproved transactions are normalised to 'reversed' and their
   * disapproved_reason surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const publisherId = requirePublisherId('listTransactions');
    const token = await getAccessToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const baseParams: Record<string, string | number | undefined> = {
      date_modified_start: from.toISOString().slice(0, 10),
      date_modified_end: to.toISOString().slice(0, 10),
    };

    // Server-side status filter when a single canonical status is requested.
    const statusFilter = toArray(query?.status);
    const upstreamStatus = mapCanonicalToDaisyconStatus(statusFilter);
    if (upstreamStatus) baseParams['status'] = upstreamStatus;

    if (query?.programmeId) baseParams['program_id'] = query.programmeId;

    const rawTransactions = await this.fetchAllPages<DaisyconTransactionRaw>(
      'listTransactions',
      `/publishers/${publisherId}/transactions`,
      token,
      baseParams,
    );

    let transactions = rawTransactions.map((r) => toTransaction(r, now));

    // Client-side canonical status filter — always applied when a status filter
    // was requested. The server-side filter uses Daisycon's upstream names
    // (e.g. 'disapproved'), which our transformer normalises (e.g. 'reversed').
    // Filtering on the normalised canonical status after transformation is
    // always correct, including for 'other' (which has no upstream equivalent).
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

    log.debug({ count: transactions.length, publisherId }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * We derive from `listTransactions` for the same reason as Awin/Skimlinks: a
   * dedicated reports endpoint would be a second source of truth for the same
   * data, and we still need the per-transaction `ageDays` to compute
   * `oldestUnpaidAgeDays`. One call, one source.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (principle 4.1).
   *
   * Multi-currency note: Daisycon transactions can mix currencies. `byStatus` and
   * the headline `totalEarnings` are reported in the first currency seen; the
   * verbatim per-row currency is preserved on each transaction's rawNetworkData.
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
          programmeName: t.programmeName || `Daisycon programme ${key}`,
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
   * Daisycon does not expose click-level data via the public publisher API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Daisycon does not expose click-level data via the public publisher API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Daisycon tracking (click) URLs are issued per programme/media binding by
   * Daisycon and are not deterministically constructible from credentials alone.
   *
   * Unlike Skimlinks (where the deeplink is a fixed go.skimresources.com format
   * keyed on publisher + domain id), a Daisycon click URL embeds Daisycon-side
   * routing for the specific programme/media subscription, and the public docs
   * do not document a stable, credential-only construction. Returning a guessed
   * URL would risk un-attributed clicks, so we throw NotImplementedError with a
   * precise reason rather than fabricate a link.
   *
   * If a future version reads the per-programme click URL from the programmes /
   * media resource and appends the destination as a deeplink parameter, this can
   * be implemented; that requires confirming the parameter name against a live
   * account (BLOCKED(verify)).
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Daisycon tracking links are issued per programme/media binding by Daisycon and are not ' +
        'deterministically constructible from credentials alone; the public API does not document a ' +
        'stable credential-only click-URL construction. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully obtaining an OAuth2 access token.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure: returns { ok: false, reason: '...' }. Never throws — verifyAuth
   * is called by error handlers.
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
      note: 'Daisycon does not expose click-level data via the public publisher API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Daisycon click URLs are not deterministically constructible from credentials alone.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('getProgramme', () => this.listProgrammes({ limit: 1 }).then(() => 1), 'Derived from listProgrammes; selects a programme by id.');

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Pagination helper
  // -------------------------------------------------------------------------

  /**
   * Fetch every page of a Daisycon list resource using page-based pagination.
   *
   * Daisycon returns the total row count in the `x-total-count` header. We page
   * until we have collected `totalCount` rows, or a page returns fewer than
   * `per_page` rows (last page), or MAX_PAGES is hit (safety cap against a bad
   * header). Each page goes through `daisyconRequest` — never `fetch` directly.
   */
  private async fetchAllPages<T>(
    operation: string,
    path: string,
    token: string,
    baseParams: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const all: T[] = [];
    let total = Infinity;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body, totalCount } = await daisyconRequest<T[]>({
        operation,
        path,
        token,
        query: { ...baseParams, page, per_page: PER_PAGE },
        resilience: RESILIENCE[operation as keyof ResilienceConfigMap] ?? RESILIENCE.default,
      });

      const rows = Array.isArray(body) ? body : [];
      all.push(...rows);

      if (!Number.isNaN(totalCount)) total = totalCount;
      if (all.length >= total) break;
      // Stop on a short page only when the total row count is unknown — when the
      // x-total-count header is present it is authoritative and drives paging.
      if (Number.isNaN(totalCount) && rows.length < PER_PAGE) break;
      // Defensive: an empty page with no total header means there is no more data.
      if (rows.length === 0) break;
    }

    return all;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const daisyconAdapter = new DaisyconAdapter();
registerAdapter(daisyconAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toArray<T>(v?: T | T[]): T[] | undefined {
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
  mapCanonicalToDaisyconStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
