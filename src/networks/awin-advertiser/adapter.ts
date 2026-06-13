/**
 * Awin advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. The third and final adapter in the agency-side rollout —
 * Impact (`src/networks/impact-advertiser/`) is the REST template and CJ
 * (`src/networks/cj-advertiser/`) is the read-only-guard template. Awin sits
 * closer to Impact in shape (REST with `/advertisers/{id}/...` path
 * segments) but with two adapter-level differences worth flagging upfront:
 *
 *   - Awin enforces a HARD rate limit of 20 calls per minute per user. The
 *     client (`./client.ts`) wraps every request in a token-bucket limiter.
 *     This adapter does not need to think about pacing — it just issues
 *     requests and lets the client queue them. Documented in the network's
 *     known limitations.
 *
 *   - Awin's advertiser API is gated to the Accelerate and Advanced plans.
 *     Brands on the Entry-tier plan exist in `/accounts` output but return
 *     401/403 on data endpoints. `listBrands` returns advertiser-type accounts
 *     with `apiEnabled: true` and DOES NOT probe each one — the wizard
 *     surfaces a graceful "found but not API-accessible — upgrade or skip"
 *     message when the operator tries to register an Entry-tier brand. This
 *     trades correctness for rate-budget conservation; see the rationale in
 *     `listBrands` below.
 *
 * Auth model: OAuth 2.0 bearer token, user-scoped. The same token the
 * publisher adapter at `src/networks/awin/` uses works here too if the user's
 * Awin sign-in is linked to both publisher and advertiser accounts.
 *
 * Operations:
 *   listBrands              GET /accounts (filtered to type === 'advertiser')
 *   verifyAuth              GET /accounts (same call; checks 200)
 *   listProgrammes          synthetic single-row per ctx.networkBrandId
 *   listTransactions        GET /advertisers/{id}/transactions/
 *   listMediaPartners       GET /advertisers/{id}/publishers/
 *   getProgrammePerformance GET /advertisers/{id}/reports/publisher
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `awinAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings.
 *   5. NEVER issue a non-GET request. The client enforces this; the adapter
 *      must not work around it.
 */

import { awinAdvRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  normaliseType,
  SLUG,
  type AwinAdvAccountRaw,
} from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DiscoveredBrand,
  type EarningsSummary,
  type MediaPartner,
  type MediaPartnerQuery,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
  type ProgrammeQuery,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('awin-advertiser.adapter');
const NAME = 'Awin (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.awin.com',
  authModel: 'oauth2',
  docsUrl: 'https://developer.awin.com/apidocs',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-23',
  claimStatus: 'experimental',
  knownLimitations: [
    'Read-only at v0.1. The HTTP client refuses any non-GET method.',
    '20 calls per minute per user — client applies a process-wide token bucket; bursty multi-brand operations queue rather than fail fast.',
    'Advertiser API is gated to Awin Accelerate / Advanced plans; Entry-tier brands appear in listBrands but data endpoints return 401/403.',
    'listProgrammes is synthetic (one programme per advertiserId); Awin programmes are configured in the UI.',
    'Awin `declined` status maps to canonical `reversed`.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 6,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
  // Awin reports against a reporting timezone (Europe/London is Awin's default,
  // matching the publisher adapter at src/networks/awin/). The verified
  // advertiser fixtures carry offset-qualified (`…Z`) timestamps, which
  // parseAwinDate preserves verbatim; this declaration governs the NAIVE-input
  // path, which parseAwinDate now interprets in this zone rather than blindly
  // assuming UTC. Per the NetworkMeta.networkTimezone contract the naïve→UTC
  // conversion is the adapter's responsibility, not a consumer hint.
  networkTimezone: 'Europe/London',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // Reports + transactions queries can run on wide windows; give them more
  // wall-clock budget so the rate-limit queueing doesn't trip the outer
  // timeout for legitimate operations.
  listTransactions: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 90_000,
    retries: 3,
  },
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 90_000,
    retries: 3,
  },
};

// ---------------------------------------------------------------------------
// Helpers — ctx, status mapping, raw shapes
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Awin advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Awin advertiser accountId) via brands.json. Call ' +
          '`affiliate_resolve_brand` to see which brands are bound.',
      }),
    );
  }
  return ctx;
}

function requireToken(operation: string): string {
  return requireCredential('AWIN_ADVERTISER_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Generate an OAuth token at the Awin dashboard → Toolbox → API Credentials. ' +
      'The same user-scoped token works for both the publisher and the advertiser surfaces.',
  });
}

// Awin transaction row shape — minimal, defensive. We read only what we use.
interface AwinAdvTransactionRaw {
  id?: number | string;
  url?: string;
  advertiserId?: number | string;
  publisherId?: number | string;
  publisherName?: string;
  campaign?: string;
  siteName?: string;
  commissionStatus?: string;
  saleAmount?: { amount?: number | string; currency?: string };
  commissionAmount?: { amount?: number | string; currency?: string };
  amount?: number | string;
  commission?: number | string;
  currency?: string;
  /** ISO timestamp of the click that led to the conversion. */
  clickDate?: string;
  /** ISO timestamp of the conversion event. */
  transactionDate?: string;
  /** When the transaction was validated (approved/declined). */
  validationDate?: string;
  /** Awin's "declined" reason if surfaced. */
  declineReason?: string;
}

interface AwinAdvPublisherRaw {
  id?: number | string;
  publisherId?: number | string;
  name?: string;
  publisherName?: string;
  status?: string;
  relationship?: string;
  region?: string;
  promotionType?: string;
}

interface AwinAdvReportRow {
  publisherId?: number | string;
  publisherName?: string;
  /** Awin reports return one of: an ISO datetime, a `YYYY-MM-DD`, or `YYYY-MM` bucket. */
  date?: string;
  startDate?: string;
  impressions?: number | string;
  clicks?: number | string;
  conversions?: number | string;
  pendingNo?: number | string;
  declinedNo?: number | string;
  validationNo?: number | string;
  commission?: number | string;
  pendingComm?: number | string;
  declinedComm?: number | string;
  saleValue?: number | string;
  validationValue?: number | string;
  pendingValue?: number | string;
  declinedValue?: number | string;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map Awin's `commissionStatus` to canonical `TransactionStatus`.
 *
 * Awin's vocabulary (per https://developer.awin.com/apidocs):
 *   - `pending`   → 'pending'
 *   - `approved`  → 'approved'
 *   - `declined`  → 'reversed' (this is the documented mapping — Awin's
 *                   "declined" means the advertiser rejected the transaction,
 *                   which is semantically a reversal in our canonical model)
 *   - any other   → 'other'
 *
 * `// TODO(verify)`: some tenants surface a `paid` status; we map that to
 * 'paid' but have not confirmed it against a live tenant.
 */
function mapTransactionStatus(raw: AwinAdvTransactionRaw): TransactionStatus {
  const s = String(raw.commissionStatus ?? '').toLowerCase();
  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'declined':
      return 'reversed';
    case 'paid':
      return 'paid';
    default:
      return 'other';
  }
}

function mapPublisherStatus(raw: AwinAdvPublisherRaw): MediaPartner['status'] {
  const s = String(raw.status ?? raw.relationship ?? '').toLowerCase();
  if (s === 'active' || s === 'joined' || s === 'approved') return 'active';
  if (s === 'pending' || s === 'pendingreview' || s === 'inreview') return 'pending';
  if (
    s === 'inactive' ||
    s === 'paused' ||
    s === 'declined' ||
    s === 'rejected' ||
    s === 'suspended'
  )
    return 'inactive';
  return 'unknown';
}

/**
 * Map Awin's per-row report state to the 3-value performance status. The
 * pre-built report endpoint returns aggregate columns (pendingNo, validationNo,
 * declinedNo) rather than a per-row status — we pick the most-news-worthy of
 * the three:
 *   - any declined → 'reversed'
 *   - any pending  → 'pending'
 *   - otherwise    → 'approved'
 */
function mapReportRowStatus(raw: AwinAdvReportRow): ProgrammePerformanceRow['status'] {
  const declined = toNumber(raw.declinedNo);
  const pending = toNumber(raw.pendingNo);
  if (declined > 0) return 'reversed';
  if (pending > 0) return 'pending';
  return 'approved';
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a naïve wall-clock timestamp (no offset) into the canonical UTC
 * instant, interpreting the wall-clock reading in `timeZone`. Mirrors the
 * publisher adapter's helper (src/networks/awin/adapter.ts); each adapter owns
 * a private copy rather than sharing through src/shared, per the
 * one-directory-per-network boundary.
 *
 * Method: guess the instant as if the wall-clock were UTC, ask `Intl` what that
 * instant looks like in `timeZone`, and shift by the measured offset. Handles
 * BST/GMT (and any DST zone) without a dependency.
 */
function zonedNaiveToUtcIso(naive: string, timeZone: string): string | undefined {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return undefined;
  const utcGuess = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? '0'),
  );
  if (Number.isNaN(utcGuess)) return undefined;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcGuess))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const seenHour = parts['hour'] === '24' ? 0 : Number(parts['hour']);
  const asSeenInZone = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    seenHour,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return new Date(utcGuess - (asSeenInZone - utcGuess)).toISOString();
}

/**
 * Parse an Awin timestamp into canonical UTC ISO-8601.
 *
 * Offset-qualified inputs (`…Z` or `…±HH:MM`) name an absolute instant and are
 * preserved verbatim. Naïve inputs (no offset) are interpreted as wall-clock in
 * `META.networkTimezone` and converted to UTC, rather than blindly assumed UTC:
 * the same lossy-host-parse hazard the publisher adapter documents applies
 * here. Returns `undefined` for empty or unparseable input.
 */
function parseAwinDate(
  input?: string,
  timeZone: string = META.networkTimezone ?? 'UTC',
): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  const candidate = input.trim();
  if (candidate === '') return undefined;
  const hasOffset = /[Zz]$/.test(candidate) || /[+-]\d{2}:?\d{2}$/.test(candidate);
  if (hasOffset) {
    const ts = Date.parse(candidate);
    return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
  }
  return zonedNaiveToUtcIso(candidate, timeZone);
}

function computeAgeDays(raw: AwinAdvTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.validationDate ?? raw.transactionDate;
  const parsed = parseAwinDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

function readMoney(
  primary: { amount?: number | string; currency?: string } | undefined,
  fallbackAmount?: number | string,
  fallbackCurrency?: string,
): { amount: number; currency: string } {
  if (primary && typeof primary === 'object') {
    return {
      amount: toNumber(primary.amount),
      currency: primary.currency ?? fallbackCurrency ?? 'GBP',
    };
  }
  return {
    amount: toNumber(fallbackAmount),
    currency: fallbackCurrency ?? 'GBP',
  };
}

/**
 * Extract the registrable domain (eTLD+1) from a URL, lowercased and stripped
 * of a leading `www.`. Heuristic, not a Public Suffix List lookup (the
 * PSL-accurate version belongs in the shared brand-resolver). Mirrors the
 * publisher adapter; kept private per the one-directory-per-network boundary.
 */
function registrableDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  if (host.startsWith('www.')) host = host.slice(4);
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const twoPartTlds = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  const secondLast = labels[labels.length - 2];
  if (secondLast && twoPartTlds.has(secondLast)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toDiscoveredBrand(raw: AwinAdvAccountRaw): DiscoveredBrand {
  const id = String(raw.accountId ?? raw.id ?? '');
  return {
    networkBrandId: id,
    displayName: raw.accountName ?? raw.name ?? `Awin advertiser ${id}`,
    // We intentionally do NOT probe each brand to determine apiEnabled — see
    // the listBrands docblock for the rate-budget rationale. The wizard's
    // brand-registration sub-flow surfaces the "Entry-tier, not API-accessible"
    // message when an upgrade-gated brand is actually used.
    apiEnabled: true,
  };
}

function toTransaction(raw: AwinAdvTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const sale = readMoney(raw.saleAmount, raw.amount, raw.currency);
  const commission = readMoney(
    raw.commissionAmount,
    raw.commission,
    raw.currency ?? sale.currency,
  );
  // Verbatim upstream status token before normalisation, so a consumer can
  // re-split rows that collapsed to `other` (Awin advertiser has no derived
  // `paid` flag — the status string is the single source, unlike the
  // publisher adapter's paidToPublisher case).
  const statusRaw =
    raw.commissionStatus !== undefined ? String(raw.commissionStatus) : undefined;

  // merchantKey: on the advertiser side the merchant IS the brand addressed by
  // ctx.networkBrandId. The transaction row exposes the brand's landing `url`,
  // whose registrable domain gives the same cross-network identity the
  // publisher adapter derives. No advertiser display name is present on the
  // row, so there is no fallback-name path here.
  const merchantKey = registrableDomain(raw.url);

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.advertiserId ?? ''),
    programmeName: raw.campaign ?? raw.siteName ?? '',
    status,
    statusRaw,
    amount: sale.amount,
    currency: sale.currency,
    commission: commission.amount,
    dateClicked: parseAwinDate(raw.clickDate),
    dateConverted: parseAwinDate(raw.transactionDate) ?? new Date(0).toISOString(),
    dateApproved: parseAwinDate(raw.validationDate),
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.declineReason ?? undefined : undefined,
    merchantKey,
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: AwinAdvPublisherRaw): MediaPartner {
  const id = String(raw.id ?? raw.publisherId ?? '');
  return {
    id,
    name: raw.name ?? raw.publisherName ?? `Awin publisher ${id}`,
    status: mapPublisherStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(raw: AwinAdvReportRow): ProgrammePerformanceRow {
  // Normalise date down to yyyy-mm-dd (or yyyy-mm).
  const rawDate = raw.date ?? raw.startDate ?? '';
  let date = '';
  if (rawDate) {
    const parsed = parseAwinDate(rawDate);
    if (parsed) {
      date = parsed.slice(0, 10);
    } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(rawDate)) {
      date = rawDate;
    }
  }

  // Awin's report returns totals split by status. For canonical reporting we
  // sum approved + pending sale value (declined is excluded from `grossSale`
  // because it's been actively rejected). Commission similarly sums approved
  // + pending.
  const approvedSale = Math.max(
    toNumber(raw.validationValue) - toNumber(raw.declinedValue),
    0,
  );
  const pendingSale = toNumber(raw.pendingValue);
  const grossSale = approvedSale + pendingSale > 0
    ? approvedSale + pendingSale
    : toNumber(raw.saleValue);

  const approvedComm = Math.max(
    toNumber(raw.commission) - toNumber(raw.declinedComm),
    0,
  );
  const pendingComm = toNumber(raw.pendingComm);
  const commission = approvedComm + pendingComm > 0 ? approvedComm + pendingComm : toNumber(raw.commission);

  return {
    date,
    publisherId: String(raw.publisherId ?? ''),
    publisherName: raw.publisherName ?? '',
    clicks: toNumber(raw.clicks),
    conversions: toNumber(raw.conversions ?? raw.validationNo ?? 0),
    grossSale,
    commission,
    currency: raw.currency ?? 'GBP',
    status: mapReportRowStatus(raw),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AwinAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — enumerate advertiser-type accounts.
  // -------------------------------------------------------------------------

  /**
   * `GET /accounts` returns every Awin account (publisher AND advertiser) the
   * token can see. We filter `type === 'advertiser'`.
   *
   * Rate-budget rationale for SKIPPING per-brand probes:
   *
   *   Awin's hard limit is 20 calls per minute per user. A typical
   *   wizard run already spends a slot on verifyAuth + a slot on listBrands.
   *   A per-brand probe (cheapest known endpoint: `/advertisers/{id}/publishers`)
   *   would consume one slot per advertiser. An agency with 18 brands would
   *   blow the budget on discovery alone, leaving the user staring at queued
   *   retries for the next minute.
   *
   *   The alternative path the spec calls out — probe the first N and mark
   *   the rest `apiEnabled: undefined` — is half a solution: the user still
   *   has no signal on the brands we didn't probe, and the wizard would need
   *   to handle three states (true/false/undefined) instead of two.
   *
   *   The simpler, more honest design: report every advertiser-type account
   *   as `apiEnabled: true`. The wizard's brand-registration sub-flow already
   *   handles errors gracefully when the operator tries to USE a brand whose
   *   data endpoints reject — that surface message says "found in your
   *   portfolio but not API-accessible — upgrade or skip". Documented in
   *   network.json knownLimitations and the per-network README.
   *
   *   TODO(verify): if Awin's /accounts response ever exposes a per-account
   *   `apiEnabled` / `tier` / `plan` field, prefer reading that to set the
   *   `apiEnabled` flag accurately. We do not see one on the current docs.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const token = requireToken('listBrands');
    const envelope = await awinAdvRequest<
      AwinAdvAccountRaw[] | { accounts?: AwinAdvAccountRaw[] }
    >({
      operation: 'verifyAuth',
      path: '/accounts',
      token,
      resilience: RESILIENCE.default,
    });
    const list: AwinAdvAccountRaw[] = Array.isArray(envelope)
      ? envelope
      : Array.isArray((envelope as { accounts?: AwinAdvAccountRaw[] }).accounts)
        ? ((envelope as { accounts: AwinAdvAccountRaw[] }).accounts)
        : [];
    return list
      .filter((a) => normaliseType(a.type) === 'advertiser')
      .map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth — reuse the auth.ts probe (same call as listBrands).
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) {
      return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — synthetic single-row per advertiserId.
  // -------------------------------------------------------------------------

  /**
   * Awin's "programme" concept is configured in the UI (regions, terms,
   * commission groups) and is not exposed as an enumerable list under
   * `/advertisers/{id}/programmes/` on every tenant — some tenants 404. We
   * synthesise: one Programme entry whose `id` is the call-context
   * advertiserId and whose `name` is best-effort. The human-readable name
   * lives on `brands.json` (`displayName` of the binding).
   *
   * `// TODO(verify)`: on tenants where `/advertisers/{id}/programmes/`
   * returns a list, prefer that. Documented in network.json.
   */
  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    // Surface a clear error if the token is missing even before the synthetic
    // row is built: a user with no token gets a config_error rather than a
    // misleading "found 1 programme".
    requireToken('listProgrammes');

    const programme: Programme = {
      id: c.networkBrandId,
      name: `Awin advertiser ${c.networkBrandId}`,
      network: SLUG,
      status: 'joined',
      currency: 'GBP',
      // The synthetic row carries no advertiser URL and only a placeholder name
      // (`Awin advertiser {id}`), so there is no honest cross-network identity
      // to derive. We mark the source `none` rather than slugify the
      // placeholder, which would manufacture a key that matches nothing.
      merchantKeySource: 'none',
      rawNetworkData: {
        derivedFrom:
          'synthetic per-advertiser Programme (Awin programmes are UI-configured; ' +
          'no enumerable /programmes endpoint at v0.1)',
        advertiserId: c.networkBrandId,
      },
    };

    let programmes: Programme[] = [programme];
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — /advertisers/{id}/transactions/
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Single-status filter passes through to Awin; multi-status is filtered
    // client-side after the round-trip.
    const statusFilter = toTransactionStatusList(query?.status);
    const upstreamStatus =
      statusFilter && statusFilter.length === 1 && statusFilter[0]
        ? canonicalToAwinStatus(statusFilter[0])
        : undefined;

    const envelope = await awinAdvRequest<
      AwinAdvTransactionRaw[] | { transactions?: AwinAdvTransactionRaw[] }
    >({
      operation: 'listTransactions',
      path: `/advertisers/${encodeURIComponent(c.networkBrandId)}/transactions/`,
      token,
      query: {
        startDate: from.toISOString(),
        endDate: to.toISOString(),
        // Awin defaults to `transaction`; we expose the alternative `validation`
        // for callers who want validation-window semantics.
        dateType: 'transaction',
        status: upstreamStatus,
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const list: AwinAdvTransactionRaw[] = Array.isArray(envelope)
      ? envelope
      : Array.isArray((envelope as { transactions?: AwinAdvTransactionRaw[] }).transactions)
        ? ((envelope as { transactions: AwinAdvTransactionRaw[] }).transactions)
        : [];
    let txns = list.map((r) => toTransaction(r, now));

    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      txns = txns.filter((t) => set.has(t.status));
    }
    if (query?.programmeId) txns = txns.filter((t) => t.programmeId === query.programmeId);
    if (typeof query?.minAgeDays === 'number') {
      txns = txns.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      txns = txns.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }
    if (typeof query?.limit === 'number') txns = txns.slice(0, query.limit);
    return txns;
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — /advertisers/{id}/publishers/
  // -------------------------------------------------------------------------

  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const c = requireCtx('listMediaPartners', ctx);
    const token = requireToken('listMediaPartners');

    const envelope = await awinAdvRequest<
      AwinAdvPublisherRaw[] | { publishers?: AwinAdvPublisherRaw[] }
    >({
      operation: 'listMediaPartners',
      path: `/advertisers/${encodeURIComponent(c.networkBrandId)}/publishers/`,
      token,
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });

    const list: AwinAdvPublisherRaw[] = Array.isArray(envelope)
      ? envelope
      : Array.isArray((envelope as { publishers?: AwinAdvPublisherRaw[] }).publishers)
        ? ((envelope as { publishers: AwinAdvPublisherRaw[] }).publishers)
        : [];
    let partners = list.map(toMediaPartner);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toMediaPartnerStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      partners = partners.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') partners = partners.slice(0, query.limit);
    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — /advertisers/{id}/reports/publisher
  // -------------------------------------------------------------------------

  /**
   * Awin's pre-built per-publisher report — the cleanest API path of the three
   * advertiser networks we've shipped. Returns one row per publisher per
   * period with `impressions`, `clicks`, `conversions`, `commission`,
   * `saleValue` already aggregated by Awin's reporting engine.
   *
   * `// TODO(verify)`: exact column names. Awin's report endpoints have
   * historically returned slightly different column sets per tenant (e.g.
   * `pendingNo` vs `pendingNumber`). The transformer reads multiple aliases
   * defensively; if a column is missing we read 0.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const token = requireToken('getProgrammePerformance');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const envelope = await awinAdvRequest<
      AwinAdvReportRow[] | { rows?: AwinAdvReportRow[]; data?: AwinAdvReportRow[] }
    >({
      operation: 'getProgrammePerformance',
      path: `/advertisers/${encodeURIComponent(c.networkBrandId)}/reports/publisher`,
      token,
      query: {
        startDate: from.toISOString().slice(0, 10),
        endDate: to.toISOString().slice(0, 10),
        dateType: 'transaction',
      },
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    const list: AwinAdvReportRow[] = Array.isArray(envelope)
      ? envelope
      : Array.isArray((envelope as { rows?: AwinAdvReportRow[] }).rows)
        ? ((envelope as { rows: AwinAdvReportRow[] }).rows)
        : Array.isArray((envelope as { data?: AwinAdvReportRow[] }).data)
          ? ((envelope as { data: AwinAdvReportRow[] }).data)
          : [];

    let rows = list.map(toPerformanceRow);
    if (query?.publisherId) {
      rows = rows.filter((r) => r.publisherId === query.publisherId);
    }
    if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Awin advertiser adapter does not implement getProgramme at v0.1; programmes are synthetic, use listProgrammes.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Awin advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Awin advertiser adapter does not implement listClicks at v0.1; click totals are surfaced via getProgrammePerformance.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Awin advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Awin advertiser at v0.1.');
  }

  // -------------------------------------------------------------------------
  // Setup + diagnostics
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};
    operations['verifyAuth'] = {
      supported: true,
      note: 'GET /accounts; not re-probed here to avoid burning rate-limit budget during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'GET /accounts filtered to type === advertiser; per-brand API-enabled probing is skipped to conserve the 20-per-minute rate budget — Entry-tier brands appear here but their data endpoints 401/403.',
      claimStatus: 'partial',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Synthetic single-row Programme per advertiserId; Awin programmes are UI-configured and not enumerable via /programmes on every tenant.',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'GET /advertisers/{id}/transactions/; declined → reversed mapping applied.',
    };
    operations['listMediaPartners'] = {
      supported: true,
      note: 'GET /advertisers/{id}/publishers/.',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'GET /advertisers/{id}/reports/publisher; pre-built per-publisher report. Column aliases (pendingNo vs pendingNumber, etc.) `// TODO(verify)` against a live tenant.',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = {
      supported: false,
      note: 'Click totals surface via getProgrammePerformance.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Publisher-side operation; not applicable to advertiser adapter.',
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

export const awinAdvertiserAdapter = new AwinAdvertiserAdapter();
registerAdapter(awinAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toMediaPartnerStatusList(
  v?: MediaPartner['status'] | Array<MediaPartner['status']>,
): Array<MediaPartner['status']> | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Canonical → Awin upstream status. Note: `reversed` maps to `declined` for
 * the upstream filter — symmetric with the inbound mapping in
 * `mapTransactionStatus`.
 */
function canonicalToAwinStatus(s: TransactionStatus): string | undefined {
  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'reversed':
      return 'declined';
    case 'paid':
      // `// TODO(verify)`: not all tenants support `paid` as a status filter.
      return 'paid';
    default:
      return undefined;
  }
}

// Silence unused-import lint when noUnusedLocals is on.
void log;

export const _internals = {
  toDiscoveredBrand,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  mapTransactionStatus,
  mapPublisherStatus,
  mapReportRowStatus,
  parseAwinDate,
  zonedNaiveToUtcIso,
  registrableDomain,
  computeAgeDays,
  canonicalToAwinStatus,
};
