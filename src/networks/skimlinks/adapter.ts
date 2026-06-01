/**
 * Skimlinks adapter — publisher-side implementation.
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
 * --- Skimlinks API map ---------------------------------------------------------
 *
 * OAuth2 token endpoint:
 *   POST https://authentication.skimapis.com/access_token
 *     grant_type=client_credentials&client_id=...&client_secret=...
 *   → { access_token, token_type, expires_in }
 *
 * Reporting API (base: https://api-reports.skimlinks.com):
 *   GET /publishers/{publisherId}/commissions
 *     ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *     [&status=pending|approved|declined|paid]
 *     [&merchant_id=N]
 *     [&limit=N&page=N]
 *   Response: { count, commissions: [{ commissionId, amount, currency, status,
 *                 merchantId, merchantName, url, customId, clickTime,
 *                 transactionDate, approvedDate, paidDate, ... }] }
 *   Source: https://developers.skimlinks.com/reporting.html
 *         + https://api-reports.skimlinks.com/doc/doc_report_v0.3.html
 *
 * Merchant API (https://api-merchants.skimlinks.com):
 *   Tier-gated behind a Product Key for Managed accounts. Not available to
 *   standard publishers. listProgrammes and getProgramme throw NotImplementedError.
 *   Source: https://blog.rapidapi.com/directory/skimlinks-merchant/
 *
 * Tracking link format (deterministic, no API call required):
 *   https://go.skimresources.com/?id={publisherId}X{domainId}&xs=1&url={encodedDestination}
 *   The `id` parameter is ALWAYS `{publisherId}X{domainId}` — domainId is a
 *   SEPARATE numeric ID from publisherId (each registered domain/site has its own
 *   domain ID assigned by Skimlinks). Find the full site ID in Hub → Settings →
 *   Sites. Requires SKIMLINKS_DOMAIN_ID as a separate credential.
 *   Source: https://support.skimlinks.com/hc/en-us/articles/223835748
 *           Live URL observation: id=110320X1568188 (publisherId ≠ domainId)
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `skimlinksRequest`.
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

import { skimlinksRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken } from './auth.js';
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

const log = createLogger('skimlinks.adapter');

const SLUG = 'skimlinks';
const NAME = 'Skimlinks';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api-reports.skimlinks.com',
  authModel: 'oauth2',
  docsUrl: 'https://developers.skimlinks.com/reporting.html',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listProgrammes / getProgramme require the Skimlinks Merchant API (api-merchants.skimlinks.com), which is gated behind a Managed account and a Product Key; both operations throw NotImplementedError for standard publisher accounts.',
    'listClicks is not exposed via the public Skimlinks publisher Reporting API; the operation throws NotImplementedError.',
    'generateTrackingLink requires both SKIMLINKS_PUBLISHER_ID and SKIMLINKS_DOMAIN_ID; the Domain ID is the number after the X in your Site ID (find it in Hub → Settings → Sites). The id parameter format is {publisherId}X{domainId}.',
    'OAuth2 access tokens have a limited lifetime (typically 1 hour); the adapter caches the token in memory and re-fetches on expiry.',
    'Maximum date window per commissions API call is not publicly documented; a live account test is required to confirm no server-side cap exists.',
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
// Skimlinks raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Skimlinks' field names can vary across API versions.
// Treating every field as possibly absent and preserving the original under
// `rawNetworkData` keeps the adapter robust to upstream drift.

interface SkimlinksCommissionRaw {
  // Field names confirmed from the Skimlinks Commission Reporting API v0.3 docs
  // (https://api-reports.skimlinks.com/doc/doc_report_v0.3.html) and corroborated
  // by search-engine snippets of the API response structure. The September 2022
  // API changes (https://support.skimlinks.com/hc/en-us/articles/6993058288541)
  // standardised naming conventions. The adapter reads both old and new names
  // defensively so it is robust to version drift. Live verification against a
  // real account is required before bumping claim_status to 'partial'.
  commissionId?: string | number;
  amount?: number | string;
  currency?: string;
  status?: string; // pending | approved | declined | paid (varies by API version)
  merchantId?: string | number;
  merchantName?: string;
  url?: string; // the URL that was clicked / converted on
  customId?: string; // publisher's custom tracking ID (SubID)
  clickTime?: string; // ISO 8601
  transactionDate?: string; // ISO 8601
  approvedDate?: string; // ISO 8601
  paidDate?: string; // ISO 8601
  orderValue?: number | string; // gross sale amount
  commissionValue?: number | string; // synonym for amount (older API v0.3 name)
  declineReason?: string; // set when status = declined
}

interface SkimlinksCommissionsResponse {
  count?: number;
  commissions?: SkimlinksCommissionRaw[];
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Skimlinks commission status string to the canonical TransactionStatus.
 *
 * Skimlinks status → canonical:
 *   pending               → 'pending'  (awaiting validation)
 *   approved / confirmed  → 'approved' (validated, not yet paid out)
 *   paid / settled        → 'paid'     (included in a publisher payment)
 *   declined / rejected   → 'reversed' (commission was declined/reversed)
 *   anything else         → 'other'
 *
 * Why 'declined' → 'reversed': from the publisher's perspective, a declined
 * commission means the sale didn't pay out — semantically a reversal, which
 * is what every other network calls this state. The verbatim status is
 * preserved in `rawNetworkData`.
 */
function mapTransactionStatus(raw: SkimlinksCommissionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'pending') return 'pending';
  if (s === 'approved' || s === 'confirmed') return 'approved';
  if (s === 'paid' || s === 'settled') return 'paid';
  if (s === 'declined' || s === 'rejected' || s === 'reversed') return 'reversed';
  return 'other';
}

/**
 * Map a Skimlinks programme/merchant relationship to the canonical ProgrammeStatus.
 *
 * Skimlinks does not expose a "joined" status through the standard publisher API
 * (Merchant API is managed-only). We default to 'unknown' for any value we cannot
 * confidently map.
 *
 *   active          → 'joined'
 *   pending         → 'pending'
 *   declined        → 'declined'
 *   available       → 'available'
 *   suspended/paused→ 'suspended'
 *   anything else   → 'unknown'
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'joined') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'notjoined') return 'available';
  if (s === 'suspended' || s === 'paused') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Skimlinks commission at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: approvedDate (how long has this been approved-but-not-paid?)
 * falls back to transactionDate (conversion date). For pending transactions,
 * the transactionDate is the earliest available anchor.
 */
function computeAgeDays(raw: SkimlinksCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.approvedDate ?? raw.transactionDate ?? raw.clickTime;
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

function toTransaction(raw: SkimlinksCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  // Skimlinks uses `amount` in newer API docs; `commissionValue` in older.
  const commission = toAmount(raw.amount ?? raw.commissionValue);
  // Gross order/sale value.
  const sale = toAmount(raw.orderValue);
  const currency = (raw.currency ?? 'GBP').toUpperCase();

  const transactionDate = nullableIso(raw.transactionDate) ?? new Date(0).toISOString();
  const clickDate = nullableIso(raw.clickTime);
  const approvedDate = nullableIso(raw.approvedDate);
  const paidDate = nullableIso(raw.paidDate);

  return {
    id: String(raw.commissionId ?? ''),
    network: SLUG,
    programmeId: String(raw.merchantId ?? ''),
    programmeName: raw.merchantName ?? `Skimlinks merchant ${raw.merchantId ?? ''}`,
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
      status === 'reversed' ? raw.declineReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requirePublisherId(operation: string): string {
  return requireCredential('SKIMLINKS_PUBLISHER_ID', {
    network: SLUG,
    operation,
    hint:
      'Set SKIMLINKS_PUBLISHER_ID in ~/.affiliate-mcp/.env. ' +
      'Find your Publisher ID in the Skimlinks Hub URL or under Toolbox → API.',
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class SkimlinksAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * Skimlinks' Merchant API (the endpoint for listing merchants) is gated behind
   * a Managed account and a Product Key. It is not available to standard publishers.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "Skimlinks returned no merchants" and "the Merchant API
   * is tier-gated" is principle 4.1.
   *
   * If a future version of the adapter adds Product Key support:
   *   GET https://api-merchants.skimlinks.com/merchants?publisher_id={publisherId}&...
   *   Headers: X-Skim-Product-Key: {productKey} + Authorization: Bearer {token}
   * Add SKIMLINKS_PRODUCT_KEY to env_vars and network.json, remove this throw.
   */
  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(
      'Skimlinks Merchant API (merchant/programme listing) requires a Managed account and a Product Key, ' +
        'which is not available to standard publisher accounts via the public API. ' +
        'See META.knownLimitations for details.',
    );
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Same restriction as listProgrammes — Merchant API is tier-gated.
   */
  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(
      'Skimlinks Merchant API (single merchant lookup) requires a Managed account and a Product Key, ' +
        'which is not available to standard publisher accounts via the public API.',
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Skimlinks commissions across a date window with optional status / age / programme filters.
   *
   * Skimlinks Reporting API endpoint:
   *   GET /publishers/{publisherId}/commissions
   *     ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
   *     [&status=pending|approved|declined|paid]
   *     [&merchant_id={merchantId}]
   *     [&limit=N&page=N]
   *
   * The API does not publicly document a maximum window per call (unlike Awin's
   * 31-day cap). No cap was found in any accessible documentation. We default to
   * 30 days when no window is specified. BLOCKED(verify): confirm exact max window
   * with a live account — requires credentials to test. Pagination is page-based
   * (confirmed from API docs snippets: response includes pagination.total,
   * pagination.from, pagination.itemCount fields; query params are limit and page).
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` returns ONLY transactions whose computed `ageDays` is
   * >= the threshold. Applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Declined commissions (`status: declined` upstream) are normalised to
   * 'reversed' and their `declineReason` surfaces in `reversalReason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const publisherId = requirePublisherId('listTransactions');
    const token = await getAccessToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // No documented maximum window found in public API docs; passes full window in
    // a single call. A live account test is required to confirm no server-side cap.
    // Pagination params are limit/page (page-based, not cursor-based).
    const params: Record<string, string | number | undefined> = {
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    };

    // Server-side status filter when a single canonical status is requested.
    // For multiple statuses we filter client-side (Skimlinks accepts one value).
    const statusFilter = toTransactionStatusList(query?.status);
    const singleStatusUpstream = mapCanonicalToSkimlinksStatus(statusFilter);
    if (singleStatusUpstream) {
      params['status'] = singleStatusUpstream;
    }

    if (query?.programmeId) {
      params['merchant_id'] = query.programmeId;
    }

    const response = await skimlinksRequest<SkimlinksCommissionsResponse>({
      operation: 'listTransactions',
      path: `/publishers/${publisherId}/commissions`,
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawCommissions: SkimlinksCommissionRaw[] = Array.isArray(response.commissions)
      ? response.commissions
      : [];

    let transactions = rawCommissions.map((r) => toTransaction(r, now));

    // Client-side canonical status filter — always applied when a status filter
    // was requested, even when we also sent a server-side filter.
    //
    // Why we filter client-side even when `singleStatusUpstream` is set:
    //   The server-side filter uses Skimlinks' upstream status names (e.g. 'declined'),
    //   which our transformer normalises to canonical names (e.g. 'reversed'). If we
    //   trusted the server-side filter alone, a query for `status: 'other'` (which
    //   has no upstream equivalent) would return wrong results. Filtering on the
    //   normalised canonical status after transformation is always correct.
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
   * We derive from `listTransactions` for the same reason as Awin: a dedicated
   * reports endpoint would be a second source of truth for the same data, and
   * we'd still need the per-transaction `ageDays` to compute `oldestUnpaidAgeDays`.
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
          programmeName: t.programmeName || `Skimlinks merchant ${key}`,
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
   * Skimlinks does not expose click-level data via the public publisher Reporting API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the API"
   * is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Skimlinks does not expose click-level data via the public publisher Reporting API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Skimlinks deeplink (deterministic, no API call required).
   *
   * Format (verified from Skimlinks documentation and live link inspection):
   *
   *   https://go.skimresources.com/?id={publisherId}X{publisherId}&xs=1&url={encodedDestination}
   *
   * The `id` parameter uses the format `{publisherId}X{siteId}`. For single-site
   * publishers, the site ID typically equals the publisher ID, giving the pattern
   * `{publisherId}X{publisherId}`. Publishers with multiple registered sites have
   * a distinct siteId — but SKIMLINKS_PUBLISHER_ID as configured is the publisher
   * ID, not a site-specific ID. We construct `{publisherId}X{publisherId}` as the
   * safest default for single-site publishers.
   *
   * The `programmeId` is intentionally NOT embedded in the deeplink — Skimlinks'
   * deeplink format is destination-URL-only; the merchant is resolved by Skimlinks
   * from the destination domain. We require programmeId in the method signature
   * (interface contract) but use it only to set `TrackingLink.programmeId` for
   * the caller's reference.
   *
   * The `xs=1` parameter enables Skimlinks' extended tracking mode. This is the
   * standard flag for deeplinks as documented in Skimlinks' link wrapper docs.
   *
   * DOMAIN ID NOTE (confirmed from public documentation):
   * The `id` parameter takes the format `{publisherId}X{domainId}` where domainId
   * is a SEPARATE numeric ID from the publisher ID. Each registered site/domain in
   * a Skimlinks account has its own domain ID. For single-site publishers the
   * site ID visible in Hub → Settings → Sites (e.g. "123456X789012") already
   * encodes both parts. Publishers must supply SKIMLINKS_DOMAIN_ID explicitly.
   *
   * Sources: https://support.skimlinks.com/hc/en-us/articles/223835748
   *          Real-world deeplink observation: id=110320X1568188 (publisherId ≠ domainId)
   *          https://intercom.geni.us/en/articles/2823246-how-to-add-your-skimlinks-affiliate-id-s
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

    const publisherId = requirePublisherId('generateTrackingLink');
    // Domain ID is a separate number from publisher ID — each registered
    // site/domain in a Skimlinks account has its own domain ID, assigned by
    // Skimlinks. Find it in Hub → Settings → Sites: the full Site ID reads
    // "{publisherId}X{domainId}" — the number after the X is your domain ID.
    const domainId = requireCredential('SKIMLINKS_DOMAIN_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint:
        'Your Domain ID is the number AFTER the X in your Skimlinks Site ID. ' +
        'Find the full Site ID at https://hub.skimlinks.com → Settings → Sites. ' +
        'For example if your Site ID is "123456X789012" then your Domain ID is "789012".',
    });
    // Require credentials to be configured even though the URL is deterministic.
    // This way, a half-configured environment is caught at link-generation time.
    await getAccessToken();

    // Skimlinks deeplink format: id={publisherId}X{domainId}
    // The two numeric components are always distinct (confirmed from live URL inspection
    // and publisher documentation: id=110320X1568188 for example).
    const id = `${publisherId}X${domainId}`;
    const encodedDestination = encodeURIComponent(input.destinationUrl);
    const trackingUrl = `https://go.skimresources.com/?id=${id}&xs=1&url=${encodedDestination}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'go.skimresources.com deterministic construction',
        id,
        xs: 1,
        url: input.destinationUrl,
        note: 'id={publisherId}X{domainId}; domainId is always distinct from publisherId (see Hub → Settings → Sites).',
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully obtaining an OAuth2 access token.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure (wrong credentials, network error): returns { ok: false, reason: '...' }.
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
   * Probe each operation with a minimal call.
   *
   * listProgrammes / getProgramme / listClicks are known-unsupported and are
   * recorded without probing to avoid wasting network calls.
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
    operations['listProgrammes'] = {
      supported: false,
      note: 'Skimlinks Merchant API is tier-gated behind a Managed account and a Product Key.',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Skimlinks Merchant API is tier-gated behind a Managed account and a Product Key.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Skimlinks does not expose click-level data via the public publisher Reporting API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    // generateTrackingLink is deterministic — record as supported without a probe.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic go.skimresources.com URL construction; no live probe needed.',
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

export const skimlinksAdapter = new SkimlinksAdapter();
registerAdapter(skimlinksAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Map a set of canonical TransactionStatus values to a single Skimlinks API
 * status parameter. Returns undefined if the set requires client-side filtering
 * (multiple statuses or statuses we cannot express in a single Skimlinks value).
 *
 * Canonical → Skimlinks API:
 *   pending   → 'pending'
 *   approved  → 'approved'
 *   reversed  → 'declined'
 *   paid      → 'paid'
 *   other     → (no mapping; filter client-side)
 *
 * If multiple statuses are requested, we cannot express that in a single server
 * filter param, so we return undefined and let the caller filter client-side.
 */
function mapCanonicalToSkimlinksStatus(
  statuses?: TransactionStatus[],
): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':   return 'pending';
    case 'approved':  return 'approved';
    case 'reversed':  return 'declined';
    case 'paid':      return 'paid';
    default:          return undefined;
  }
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
  mapCanonicalToSkimlinksStatus,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
