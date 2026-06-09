/**
 * Howl adapter (formerly Narrativ).
 *
 * Howl is an independent creator/journalist link network: it mints monetised
 * "smart links" for editorial content and reports earnings back to the
 * publisher. This adapter follows the canonical Awin pattern
 * (`src/networks/awin/adapter.ts`); read that file's header for the six cardinal
 * rules. The non-obvious, Howl-specific decisions are documented inline.
 *
 * --- Howl API map (verified against https://docs.narrativ.com/) -------------
 *
 *   GET  /api/v1/tokeninfo/
 *     → token metadata + owning user id. Used by verifyAuth (cheap call).
 *       https://docs.narrativ.com/auth.html
 *   GET  /api/v1/publishers/{pubId}/stats_by_article_merchant_daily/
 *        ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *     → per-day, per-(article, merchant) earnings: clicks, impressions,
 *       advertiser_attributed_sales, advertiser_attributed_revenue,
 *       pub_earnings, advertiser_name, merch_id, event_date.
 *       https://docs.narrativ.com/statistics.html
 *   POST /api/v1/smart_links/
 *        { url, article_name, article_url, pub_id?, exclusive_match_requested? }
 *     → 201 with the monetised link in `smart_link_url`.
 *       https://docs.narrativ.com/smartlink.html
 *
 * --- Why programmes and transactions both derive from the statistics endpoint
 *
 * Howl does NOT expose a live REST "list merchants/programmes I can work with"
 * endpoint for a publisher key — merchant catalogues are delivered as scheduled
 * Merchant Feed files (S3/SFTP), and per-order transaction data is delivered as
 * scheduled Publisher Report CSV files (Clicks / Orders / Returns), not as a
 * queryable endpoint (https://docs.narrativ.com/pubreport.html). The only live,
 * key-authenticated earnings surface is the daily statistics endpoint.
 *
 * We therefore derive BOTH programmes and transactions from
 * `stats_by_article_merchant_daily`:
 *   - listProgrammes: the distinct merchants (`merch_id` / `advertiser_name`)
 *     the publisher has driven activity to in the window.
 *   - listTransactions: one row per (event_date, article, merchant) stats
 *     bucket. These are daily AGGREGATES, not individual orders — Howl's live
 *     API has no per-order surface. The aggregate is the honest unit available;
 *     the limitation is recorded in `META.knownLimitations`.
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * Howl's statistics endpoint returns monetary fields (`pub_earnings`,
 * `advertiser_attributed_sales`) as decimal MAJOR units (e.g. dollars), and
 * Howl settles publishers in USD. The docs do not state a currency field on the
 * stats row, so we assume USD and major units. If a future tenant reports
 * otherwise, change `HOWL_CURRENCY` and the unit handling in `toTransaction`.
 */

import { howlRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiKey, requirePublisherId } from './auth.js';
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

const log = createLogger('howl.adapter');

const SLUG = 'howl';
const NAME = 'Howl';

/**
 * Currency assumption. Howl's statistics rows carry no currency field and Howl
 * settles publishers in USD. See the file header's "Amount unit assumption".
 */
const HOWL_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.narrativ.com',
  // Custom Authorization scheme `NRTV-API-KEY <key>`, not a standard bearer.
  authModel: 'custom',
  docsUrl: 'https://docs.narrativ.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: implemented against the published Howl (Narrativ) API documentation and not yet verified against a live publisher account.',
    'Monetary amounts are assumed to be in USD major units (e.g. dollars); the statistics endpoint exposes no currency field, so this is an assumption pending live verification.',
    'Howl has no live per-order transactions endpoint; listTransactions returns daily per-(article, merchant) aggregates from the statistics endpoint. Individual orders are only available via the scheduled Publisher Report CSV files (Clicks/Orders/Returns).',
    'Howl has no live merchant/programme catalogue endpoint for a publisher key; listProgrammes returns only the merchants the publisher has driven activity to in the requested window.',
    'Howl does not expose a transaction approval/payment lifecycle via the statistics API, so transaction status cannot be normalised to pending/approved/paid; rows are reported as approved when earnings are present, otherwise other.',
    'Click-level data is not exposed via a queryable endpoint (only the scheduled Clicks report file); listClicks is unsupported.',
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
 * The statistics endpoint can be slow over wide windows. We give the ops that
 * read it a longer timeout and an extra retry, mirroring Awin's transactions
 * profile.
 */
const STATS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listProgrammes: STATS_RESILIENCE,
  listTransactions: STATS_RESILIENCE,
  getEarningsSummary: STATS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Howl response shapes (deliberately minimal)
// ---------------------------------------------------------------------------

/** One row of `stats_by_article_merchant_daily`. */
interface HowlStatRaw {
  advertiser_name?: string;
  article_name?: string;
  article_id?: string | number;
  article_url?: string;
  merch_id?: string | number;
  pub_id?: string | number;
  event_date?: string;
  clicks?: number;
  impressions?: number;
  advertiser_attributed_sales?: number;
  advertiser_attributed_revenue?: number;
  pub_earnings?: number;
}

interface HowlStatsResponse {
  pub_id?: string | number;
  date_from?: string;
  date_to?: string;
  stats?: HowlStatRaw[];
  // Some Howl endpoints wrap the payload under `data`.
  data?: { stats?: HowlStatRaw[]; date_from?: string; date_to?: string };
}

interface HowlSmartLinkResponse {
  smart_link_url?: string;
  smart_link_id?: string | number;
  pub_id?: string | number;
  url?: string;
  data?: {
    smart_link_url?: string;
    smart_link_id?: string | number;
    pub_id?: string | number;
    url?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Howl statistics → canonical TransactionStatus.
 *
 * The statistics API reports earnings but NOT an approval/payment lifecycle
 * (no pending/approved/reversed/paid signal). We therefore cannot honestly map
 * to those states. Convention (recorded in META.knownLimitations):
 *   - earnings present  → 'approved' (the publisher has accrued earnings)
 *   - no earnings        → 'other'
 * We never invent a 'paid' or 'pending' state Howl's live API did not provide.
 */
function mapStatStatus(raw: HowlStatRaw): TransactionStatus {
  const earnings = raw.pub_earnings ?? 0;
  return earnings > 0 ? 'approved' : 'other';
}

/**
 * Compute the age (in days) of a stats row at the moment the adapter responded,
 * anchored on `event_date` (the day the activity occurred). PRD §15.9.
 */
function computeAgeDays(raw: HowlStatRaw, now: Date = new Date()): number {
  const anchor = raw.event_date;
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

/**
 * A stable id for an aggregated stats row. Howl gives no per-row identifier
 * (the rows are aggregates), so we synthesise one from the natural key
 * (date + article + merchant). Deterministic so callers can correlate.
 */
function statRowId(raw: HowlStatRaw): string {
  return `${raw.event_date ?? 'na'}:${raw.article_id ?? 'na'}:${raw.merch_id ?? 'na'}`;
}

// ---------------------------------------------------------------------------
// Transformers (Howl raw → canonical domain types)
// ---------------------------------------------------------------------------

/**
 * Build a Programme from a merchant seen in the statistics rows. Howl exposes
 * no commission-rate or category metadata on the stats row, so those are left
 * undefined; the verbatim row(s) live on `rawNetworkData`.
 */
function toProgramme(merchId: string, advertiserName: string, rows: HowlStatRaw[]): Programme {
  return {
    id: merchId,
    name: advertiserName || `Howl merchant ${merchId}`,
    network: SLUG,
    // Activity in the window implies an active working relationship.
    status: 'joined' as ProgrammeStatus,
    currency: HOWL_CURRENCY,
    rawNetworkData: rows,
  };
}

function toTransaction(raw: HowlStatRaw, now: Date = new Date()): Transaction {
  const status = mapStatStatus(raw);
  const commission = raw.pub_earnings ?? 0;
  const sale = raw.advertiser_attributed_sales ?? raw.advertiser_attributed_revenue ?? 0;
  const eventDate = nullableIso(raw.event_date) ?? new Date(0).toISOString();

  return {
    id: statRowId(raw),
    network: SLUG,
    programmeId: String(raw.merch_id ?? ''),
    programmeName: raw.advertiser_name ?? '',
    status,
    amount: sale,
    currency: HOWL_CURRENCY,
    commission,
    // Howl's stats row has no click timestamp; the activity date is event_date.
    dateConverted: eventDate,
    // No approval/payment dates exist on the statistics row.
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class HowlAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch the raw statistics rows for a date window. Centralised because both
   * listProgrammes and listTransactions read the same endpoint.
   *
   * Howl's statistics endpoint takes `date_from`/`date_to` as `YYYY-MM-DD`. We
   * chunk wide windows into ≤31-day slices defensively: the docs do not state a
   * hard cap, but daily-aggregate endpoints across networks tend to throttle or
   * truncate large ranges, and chunking keeps each call small and uniform with
   * the rest of the project.
   */
  private async fetchStats(from: Date, to: Date): Promise<HowlStatRaw[]> {
    const apiKey = requireApiKey('listTransactions');
    const pubId = requirePublisherId('listTransactions');

    const slices = chunkDateRange(from, to, 31);
    const all: HowlStatRaw[] = [];
    for (const slice of slices) {
      const res = await howlRequest<HowlStatsResponse>({
        operation: 'listTransactions',
        path: `/api/v1/publishers/${encodeURIComponent(pubId)}/stats_by_article_merchant_daily/`,
        apiKey,
        query: {
          date_from: formatHowlDate(slice.start),
          date_to: formatHowlDate(slice.end),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const stats = res?.stats ?? res?.data?.stats ?? [];
      if (Array.isArray(stats)) all.push(...stats);
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the merchants the publisher has driven activity to in the window.
   *
   * Howl has no live programme-catalogue endpoint for a publisher key (see file
   * header), so "programmes" are the distinct merchants in the statistics rows.
   * Default window: last 30 days. Filters (search/status/categories/limit) are
   * applied client-side; Howl exposes no server-side filter on this endpoint.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.fetchStats(from, now);

    // Group rows by merchant.
    const byMerchant = new Map<string, { name: string; rows: HowlStatRaw[] }>();
    for (const r of rows) {
      const id = String(r.merch_id ?? '');
      if (!id) continue;
      const entry = byMerchant.get(id);
      if (entry) {
        entry.rows.push(r);
        if (!entry.name && r.advertiser_name) entry.name = r.advertiser_name;
      } else {
        byMerchant.set(id, { name: r.advertiser_name ?? '', rows: [r] });
      }
    }

    let programmes = [...byMerchant.entries()].map(([id, v]) => toProgramme(id, v.name, v.rows));

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    // Every derived programme is 'joined'; honour an explicit status filter so
    // a caller asking for 'available' gets an honest empty result rather than
    // joined merchants mislabelled.
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
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
   * Fetch a single merchant (programme) by merch id. Since programmes are
   * derived from the statistics rows, we list the recent window and pick the
   * matching merchant. An unknown id surfaces as a network_api_error envelope
   * rather than a fabricated stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'Howl merchant (programme) id is required.',
          hint: 'List programmes first (affiliate_howl_list_programmes) to find the merch id.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Howl merchant with id "${programmeId}" found in the recent activity window.`,
          hint: 'Howl only surfaces merchants the publisher has driven activity to. Widen the period or confirm the id via affiliate_howl_list_programmes.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List daily per-(article, merchant) earnings rows as transactions.
   *
   * These are AGGREGATES, not individual orders — Howl's live API has no
   * per-order surface (see file header). Default window: last 30 days. Status,
   * programme, age, and limit filters are applied client-side after the fetch,
   * matching Awin's ordering so `{ status, minAgeDays }` is meaningful.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.fetchStats(from, to);
    let transactions = rows.map((r) => toTransaction(r, now));

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
   * Aggregate transactions into an earnings summary, derived client-side from
   * listTransactions so the user can reproduce the numbers (matches Awin).
   *
   * `oldestUnpaidAgeDays` uses the only status we can assert — 'approved' — as
   * the unpaid signal, because Howl's live API exposes no payment lifecycle.
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
      currency: HOWL_CURRENCY,
    };

    let totalEarnings = 0;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
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
          programmeName: t.programmeName || `Howl merchant ${key}`,
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

    return {
      network: SLUG,
      totalEarnings,
      currency: HOWL_CURRENCY,
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
   * Howl does not expose click-level data via a queryable endpoint. Click rows
   * are only delivered in the scheduled Clicks report file (S3/SFTP), which is
   * out of scope for a live REST adapter. We throw rather than return [] so the
   * user can tell "no clicks" from "no endpoint" (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Howl does not expose click-level data via a queryable endpoint; clicks are delivered only in the scheduled Clicks report file',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Mint a monetised Howl smart link via `POST /api/v1/smart_links/`.
   *
   * Unlike Awin's deterministic deep-link, Howl links are minted server-side:
   * Howl resolves the destination to a participating merchant and returns the
   * monetised URL in `smart_link_url`. We therefore make a real API call.
   *
   * The Howl request requires `url` (the destination), `article_name`, and
   * `article_url`. Our contract only carries `destinationUrl` and (optional)
   * `programmeId`, so we supply minimal placeholder article context derived
   * from the destination — Howl uses it for reporting attribution, not for
   * link validity. `pub_id` is sent so multi-publisher keys resolve correctly.
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
          message: 'destinationUrl is required to mint a Howl smart link.',
          hint: 'Pass the full URL of the product or merchant page you want to monetise.',
        }),
      );
    }

    const apiKey = requireApiKey('generateTrackingLink');
    const pubId = requirePublisherId('generateTrackingLink');

    const body = {
      url: input.destinationUrl,
      // Howl requires article context for reporting attribution. We supply the
      // destination host as a neutral placeholder; callers that publish through
      // a CMS would pass real article metadata via a dedicated flow.
      article_name: 'affiliate-mcp generated link',
      article_url: input.destinationUrl,
      pub_id: Number.isNaN(Number(pubId)) ? pubId : Number(pubId),
    };

    const res = await howlRequest<HowlSmartLinkResponse>({
      operation: 'generateTrackingLink',
      path: '/api/v1/smart_links/',
      apiKey,
      method: 'POST',
      body,
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const payload = res?.data ?? res;
    const trackingUrl = payload?.smart_link_url;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Howl smart link response did not contain a smart_link_url.',
          networkErrorBody: JSON.stringify(res),
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: res,
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
          claimStatus: 'experimental',
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

    operations['listClicks'] = {
      supported: false,
      note: 'Howl does not expose click-level data via a queryable endpoint (Clicks report file only).',
    };

    // getProgramme reads the same stats window as listProgrammes; not probed
    // separately to keep the diagnostic fast.
    operations['getProgramme'] = {
      supported: true,
      note: 'Derived from the statistics endpoint; requires a known merch id, not probed automatically.',
      claimStatus: 'experimental',
    };

    // generateTrackingLink mints a real link server-side; not probed to avoid
    // creating a stray link during a diagnostic.
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Mints a live Howl smart link via POST /api/v1/smart_links/; not probed automatically to avoid creating a link.',
      claimStatus: 'experimental',
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
// Module-level registration (see Awin adapter for the rationale).
// ---------------------------------------------------------------------------

export const howlAdapter = new HowlAdapter();
registerAdapter(howlAdapter);

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
 * Split `[from, to]` into ≤`maxDays`-day chunks. Howl's statistics endpoint
 * does not document a hard cap, but we chunk defensively (see `fetchStats`).
 * Returns at least one slice; a `from >= to` window returns a single slice so
 * the call shape stays predictable.
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
 * Format a Date for Howl's `date_from`/`date_to` params, which take a calendar
 * day `YYYY-MM-DD`.
 */
function formatHowlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapStatStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatHowlDate,
  statRowId,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
