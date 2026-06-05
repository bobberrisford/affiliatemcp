/**
 * Coupang Partners adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and mirrors `src/networks/skimlinks/adapter.ts` closely. The
 * load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Coupang Partners API map (verified 2026-06-04) ----------------------------
 *
 * Base: https://api-gateway.coupang.com
 * Auth: HMAC-SHA256 (CEA scheme), Access Key + Secret Key, signed per request.
 *       See auth.ts. auth_model is "custom" (NOT bearer).
 *
 * Reports / commission (the workhorse — drives listTransactions + earnings):
 *   GET /v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission
 *       ?startDate=YYYYMMDD&endDate=YYYYMMDD&page=N
 *   → { data: [ { date, clickCount, orderCount, gmv, commission, ... } ] }
 *   Source: https://github.com/nicecoding1/python_example/blob/main/coupang_commission.py
 *
 * Deeplink (generateTrackingLink — a REAL POST API call, not deterministic):
 *   POST /v2/providers/affiliate_open_api/apis/openapi/v1/deeplink
 *       { coupangUrls: [destinationUrl], subId? }
 *   → { data: [ { originalUrl, shortenUrl, landingUrl } ] }
 *   Source: https://github.com/JEJEMEME/PCoupangAPI (create_deeplink)
 *
 * Product search exists (GET .../products/search) but it is a catalogue search,
 * NOT a list of merchant programmes the publisher has joined. Coupang Partners
 * is a single-merchant network (the publisher promotes Coupang itself), so it
 * exposes no programme-listing endpoint. listProgrammes / getProgramme throw
 * NotImplementedError accordingly.
 *
 * Click-level data is not exposed: the commission report carries an aggregate
 * `clickCount` per day but no per-click rows. listClicks throws
 * NotImplementedError rather than returning [].
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `coupangRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus`.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` — NEVER process.env (except in tests).
 *   7. UK English. "programme", not "program".
 */

import {
  coupangRequest,
  REPORTS_COMMISSION_PATH,
  DEEPLINK_PATH,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireAccessKey,
  requireSecretKey,
  formatYyyymmdd,
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('coupang-partners.adapter');

const SLUG = 'coupang-partners';
const NAME = 'Coupang Partners';

// Coupang Partners is a Korean network; commissions settle in KRW.
const DEFAULT_CURRENCY = 'KRW';

// Coupang Partners has a single merchant (Coupang). We surface it under a
// stable synthetic programme id so transactions group cleanly.
const COUPANG_PROGRAMME_ID = 'coupang';
const COUPANG_PROGRAMME_NAME = 'Coupang';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api-gateway.coupang.com',
  authModel: 'custom',
  docsUrl: 'https://partner-developers.coupangcorp.com/hc/ko/categories/360005470572-API-Docs',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Coupang Open API enforces strict rate limits (the affiliate product-search endpoint is documented at roughly 10 calls per hour); the reports endpoint is similarly throttled. Frequent polling will return HTTP 429.',
    'listProgrammes / getProgramme throw NotImplementedError: Coupang Partners is a single-merchant network (the publisher promotes Coupang itself) and exposes no programme-listing API. Product search is a catalogue search, not a programme list.',
    'listClicks throws NotImplementedError: the commission report exposes only an aggregate daily clickCount, not per-click rows.',
    'listTransactions maps the reports/commission endpoint, which returns DAILY AGGREGATE rows (date, clickCount, orderCount, gmv, commission), not individual orders. There is no per-row settlement status, so every transaction is normalised to status "other"; amounts are daily totals.',
    'generateTrackingLink calls the deeplink API (POST .../v1/deeplink) and is subject to the same rate limits.',
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

const REPORTS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  // Coupang is aggressively rate-limited; keep retries conservative so we do
  // not amplify a 429 storm. 429 is still retried per the shared policy.
  retries: 2,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTS_RESILIENCE,
  getEarningsSummary: REPORTS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Coupang raw response shapes
// ---------------------------------------------------------------------------

/**
 * One row of the reports/commission response.
 *
 * Field names confirmed from the working public reference client (the `date`
 * and `commission` fields are read directly there). The remaining aggregate
 * fields (clickCount, orderCount, gmv) are documented in the Coupang Partners
 * reports API and read defensively here. Live verification against a real
 * account is required before bumping claim_status to 'partial'.
 */
interface CoupangCommissionRow {
  date?: string; // e.g. "2026-06-03" or "20260603"
  clickCount?: number;
  orderCount?: number;
  gmv?: number | string; // gross merchandise value (sale amount), KRW
  commission?: number | string; // commission earned, KRW
}

interface CoupangReportResponse {
  rCode?: string;
  rMessage?: string;
  data?: CoupangCommissionRow[];
}

interface CoupangDeeplinkRow {
  originalUrl?: string;
  shortenUrl?: string;
  landingUrl?: string;
}

interface CoupangDeeplinkResponse {
  rCode?: string;
  rMessage?: string;
  data?: CoupangDeeplinkRow[];
}

// ---------------------------------------------------------------------------
// Status mapping helper
// ---------------------------------------------------------------------------

/**
 * Map a Coupang commission row to the canonical TransactionStatus.
 *
 * The reports/commission endpoint returns DAILY AGGREGATE rows with no
 * settlement status field — there is no pending/approved/paid/reversed
 * distinction in the payload. Per principle 4.1 we do NOT guess: every row is
 * normalised to 'other'. The verbatim row is preserved in `rawNetworkData`.
 *
 * Kept as a named helper (rather than a literal) so the decision is explicit
 * and testable, and so a future API version that adds a status field has an
 * obvious place to wire it in.
 */
function mapTransactionStatus(_row: CoupangCommissionRow): TransactionStatus {
  return 'other';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Coupang commission row at the moment the
 * adapter responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Coupang's commission rows carry only a `date` (the report day). That is the
 * single available anchor.
 */
function computeAgeDays(row: CoupangCommissionRow, now: Date = new Date()): number {
  const iso = parseCoupangDate(row.date);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Coupang returns the report date either as `YYYY-MM-DD` or compact `YYYYMMDD`.
 * Normalise both to an ISO timestamp at UTC midnight; return undefined when the
 * value is missing or unparseable.
 */
function parseCoupangDate(d?: string): string | undefined {
  if (!d) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : d;
  const ts = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function toTransaction(
  row: CoupangCommissionRow,
  index: number,
  now: Date = new Date(),
): Transaction {
  const dateConverted = parseCoupangDate(row.date) ?? new Date(0).toISOString();
  // Synthesise a stable id from the report day (the only identifying field on a
  // daily aggregate row). Index disambiguates if the same day appears twice.
  const dayKey = (row.date ?? 'unknown').replace(/[^0-9]/g, '') || 'unknown';
  return {
    id: `coupang-${dayKey}-${index}`,
    network: SLUG,
    programmeId: COUPANG_PROGRAMME_ID,
    programmeName: COUPANG_PROGRAMME_NAME,
    status: mapTransactionStatus(row),
    amount: toAmount(row.gmv),
    currency: DEFAULT_CURRENCY,
    commission: toAmount(row.commission),
    dateConverted,
    ageDays: computeAgeDays(row, now),
    rawNetworkData: row,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CoupangPartnersAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes / getProgramme — not exposed
  // -------------------------------------------------------------------------

  /**
   * Coupang Partners is a single-merchant network: the publisher promotes
   * Coupang itself, and the API exposes no programme-listing endpoint. The
   * product-search endpoint is a catalogue search, not a list of joined
   * programmes.
   *
   * We throw NotImplementedError rather than returning a single synthetic
   * programme — the difference between "Coupang has no programme list API" and
   * "you have joined one programme" is principle 4.1.
   */
  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(
      'Coupang Partners exposes no programme-listing API: it is a single-merchant network ' +
        '(you promote Coupang itself), and product search is a catalogue search rather than a programme list. ' +
        'See META.knownLimitations.',
    );
  }

  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(
      'Coupang Partners exposes no programme-listing API: it is a single-merchant network, ' +
        'so there is no per-programme lookup endpoint.',
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Coupang Partners commission rows across a date window.
   *
   * Endpoint:
   *   GET /v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission
   *       ?startDate=YYYYMMDD&endDate=YYYYMMDD&page=N
   *
   * IMPORTANT: the response is DAILY AGGREGATE rows, not individual orders.
   * Each row carries the day's clickCount, orderCount, gmv, and commission.
   * There is no per-row settlement status, so status normalises to 'other'.
   *
   * Pagination is page-based (`page`, zero-indexed). We walk pages until a page
   * returns fewer rows than the previous full page or an empty page. BLOCKED(verify):
   * Coupang does not publicly document the page size or a max window; a live
   * account test is required to confirm both. We default the window to 30 days.
   *
   * `query.status` filtering: because every row is 'other', a status filter that
   * does not include 'other' will correctly return an empty list. `programmeId`
   * filtering: there is one merchant, so a programmeId that is not the Coupang
   * synthetic id yields an empty list.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const accessKey = requireAccessKey('listTransactions');
    const secretKey = requireSecretKey('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startDate = formatYyyymmdd(from);
    const endDate = formatYyyymmdd(to);

    // Page-walk. Coupang's page size is undocumented; we stop when a page comes
    // back empty. A hard cap guards against an unbounded loop if the API never
    // signals the end.
    const MAX_PAGES = 50;
    const rows: CoupangCommissionRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await coupangRequest<CoupangReportResponse>({
        operation: 'listTransactions',
        method: 'GET',
        path: REPORTS_COMMISSION_PATH,
        query: { startDate, endDate, page },
        accessKey,
        secretKey,
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const pageRows = Array.isArray(response.data) ? response.data : [];
      if (pageRows.length === 0) break;
      rows.push(...pageRows);
    }

    let transactions = rows.map((r, i) => toTransaction(r, i, now));

    // programmeId filter — single merchant.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Canonical status filter (every row is 'other').
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
   * Aggregate the commission rows into an earnings summary.
   *
   * Derived from `listTransactions` (one call, one source of truth) for the same
   * reason as Awin/Skimlinks: a separate report endpoint would be a second
   * source for the same data, and we still need per-row `ageDays` to compute
   * `oldestUnpaidAgeDays`.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (4.1).
   *
   * NOTE: because every Coupang row is status 'other', `byStatus.other` carries
   * the full commission total and the pending/approved/reversed/paid buckets
   * stay zero. `oldestUnpaidAgeDays` is left undefined: Coupang exposes no
   * settlement status, so we cannot honestly say a commission is "unpaid".
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
      currency: DEFAULT_CURRENCY,
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || COUPANG_PROGRAMME_ID;
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || COUPANG_PROGRAMME_NAME,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }
    }

    if (firstCurrency) byStatus.currency = firstCurrency;

    return {
      network: SLUG,
      totalEarnings,
      currency: firstCurrency ?? DEFAULT_CURRENCY,
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      // Coupang exposes no settlement status; we do not invent an unpaid age.
      oldestUnpaidAgeDays: undefined,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks — not exposed
  // -------------------------------------------------------------------------

  /**
   * Coupang Partners does not expose click-level data: the commission report
   * carries only an aggregate daily `clickCount`, not per-click rows.
   *
   * We throw NotImplementedError rather than returning [] — the difference
   * between "no clicks" and "clicks not exposed" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Coupang Partners does not expose click-level data; the reports API returns only an aggregate daily clickCount.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — REAL API call (deeplink endpoint)
  // -------------------------------------------------------------------------

  /**
   * Generate a Coupang Partners deeplink via the deeplink API.
   *
   * Unlike Awin/Skimlinks (deterministic URL construction), Coupang requires a
   * real POST: the network mints the tracking URL server-side.
   *
   *   POST /v2/providers/affiliate_open_api/apis/openapi/v1/deeplink
   *       { coupangUrls: [destinationUrl] }
   *   → { data: [ { originalUrl, shortenUrl, landingUrl } ] }
   *
   * `programmeId` is accepted for interface compatibility but Coupang's deeplink
   * API takes only the destination URL (single merchant). We surface it on the
   * returned TrackingLink for the caller's reference.
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
          hint: 'Pass the full Coupang product or category URL you want to link to.',
        }),
      );
    }

    const accessKey = requireAccessKey('generateTrackingLink');
    const secretKey = requireSecretKey('generateTrackingLink');

    const response = await coupangRequest<CoupangDeeplinkResponse>({
      operation: 'generateTrackingLink',
      method: 'POST',
      path: DEEPLINK_PATH,
      body: { coupangUrls: [input.destinationUrl] },
      accessKey,
      secretKey,
      resilience: RESILIENCE.default,
    });

    const first = Array.isArray(response.data) ? response.data[0] : undefined;
    const trackingUrl = first?.shortenUrl ?? first?.landingUrl;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          networkErrorBody: JSON.stringify(response),
          message:
            'Coupang Partners deeplink API returned no shortenUrl/landingUrl for the supplied URL.',
          hint: 'Confirm the destination URL is a valid Coupang (coupang.com) product or category URL.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: response,
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
      note: 'Coupang Partners is a single-merchant network with no programme-listing API.',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'Coupang Partners is a single-merchant network with no per-programme lookup API.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Coupang Partners exposes only an aggregate daily clickCount, not per-click rows.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    // generateTrackingLink is a real API call; probe it with a Coupang URL.
    await probe('generateTrackingLink', () =>
      this.generateTrackingLink({
        programmeId: COUPANG_PROGRAMME_ID,
        destinationUrl: 'https://www.coupang.com/',
      }),
    );

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

export const coupangPartnersAdapter = new CoupangPartnersAdapter();
registerAdapter(coupangPartnersAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  parseCoupangDate,
  toTransaction,
  toAmount,
};

void log;
