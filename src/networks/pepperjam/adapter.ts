/**
 * Pepperjam (Ascend by Partnerize) — publisher-side adapter.
 *
 * Built on the Awin reference pattern (`src/networks/awin/adapter.ts`); read
 * that file's header for the full reasoning behind the cardinal rules. The
 * non-obvious, network-specific decisions are documented inline below.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — discovery via /publisher/advertiser
 *   getProgramme        — single advertiser via /publisher/advertiser (filtered)
 *   listTransactions    — /publisher/report/transaction-details
 *   getEarningsSummary  — derived client-side from listTransactions
 *   listClicks          — NOT exposed on the publisher API → NotImplementedError
 *   generateTrackingLink— NOT documented for deterministic build → NotImplementedError
 *   verifyAuth          — cheap /publisher/advertiser call (see auth.ts)
 *
 * Two admin ops (`listPublishers`, `listPublisherSectors`) are scaffolded for
 * v0.2 and throw `NotImplementedError`.
 *
 * --- Pepperjam / Ascend API map ---------------------------------------------
 *
 * Base: https://api.pepperjamnetwork.com, versioned `/20120402/`. Auth is a
 * self-issued `apiKey` query param plus `format=json` (both injected by
 * client.ts). Every GET returns a `meta`/`data` envelope; `data` is the array.
 *
 *   GET /publisher/advertiser
 *     → advertisers (programmes) the publisher can work with. Paginated via
 *       meta.pagination (2500 rows/page).
 *   GET /publisher/report/transaction-details?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *     → transactions. Paginated via meta.pagination.
 *
 * Docs: Ascend API Overview
 *   https://ascendpartner.zendesk.com/hc/en-gb/articles/13501008650909-API-Overview
 * and the singer-io/tap-pepperjam field reference
 *   https://github.com/singer-io/tap-pepperjam
 *
 * --- DISTINCT from the Partnerize adapter -----------------------------------
 *
 * Ascend is Partnerize-owned, but this REST surface is unrelated to the
 * Partnerize Reporting API. This adapter is standalone and shares no code with
 * `partnerize`.
 *
 * --- Amount-unit assumption -------------------------------------------------
 *
 * The transaction-details report returns `sale_amount`, `commission`, etc. as
 * decimal MAJOR currency units (e.g. `12.50` = $12.50), per the singer tap
 * schema (`number`) and observed Ascend payloads. We pass them through
 * unchanged. Currency is assumed USD (Pepperjam/Ascend is a US network and the
 * report does not return a per-row currency code). If a future tenant returns
 * minor units or a non-USD currency, this is the assumption to revisit — the
 * raw row is preserved on `rawNetworkData` so the user can always reconcile.
 */

import { pepperjamRequest, type PepperjamEnvelope } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
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

const log = createLogger('pepperjam.adapter');

const SLUG = 'pepperjam';
const NAME = 'Pepperjam';

/**
 * Pepperjam/Ascend is a US network and the transaction report does not return
 * a per-row currency code. We default to USD; see the amount-unit note in the
 * file header.
 */
const DEFAULT_CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.pepperjamnetwork.com',
  // `custom`: auth is a self-issued apiKey query parameter, not a Bearer token.
  authModel: 'custom',
  docsUrl: 'https://ascendpartner.zendesk.com/hc/en-gb/articles/13501008650909-API-Overview',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: the adapter has not been validated against a live publisher
  // account at commit time, and the amount unit / currency carry assumptions.
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: not yet validated against a live Pepperjam (Ascend) publisher account.',
    'Transaction amounts are assumed to be major currency units in USD; the report does not return a per-row currency code.',
    'Distinct from the Partnerize adapter: Ascend is Partnerize-owned but this REST API is unrelated to the Partnerize Reporting API.',
    'Click-level data is not exposed via the public Pepperjam publisher API; listClicks is unsupported.',
    'Tracking-link construction is not documented as a deterministic scheme on the publisher API; generateTrackingLink is unsupported.',
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
 * The transaction report can be slow for active publishers across a wide
 * window. Mirror Awin's reasoning: a longer timeout + one more retry resolves a
 * transient gateway hiccup during heavy hours rather than failing the call.
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
// Pepperjam response shapes (deliberately minimal — read defensively)
// ---------------------------------------------------------------------------

interface PepperjamAdvertiserRaw {
  id?: number | string;
  name?: string;
  status?: string; // joined / pending / available / declined-style strings
  relationship?: string;
  website?: string;
  // Categories may appear as an array of {id,name} objects on some endpoints.
  category?: Array<{ id?: number | string; name?: string }>;
  // Commission appears as a free-text summary on the advertiser listing.
  commission?: string;
}

interface PepperjamTransactionRaw {
  transaction_id?: number | string;
  order_id?: string;
  program_id?: number | string;
  program_name?: string;
  sale_amount?: number | string;
  commission?: number | string;
  status?: string; // pending / locked / paid / declined / ...
  sale_date?: string; // datetime
  // Some report variants expose a modified/processed date.
  modified?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Pepperjam transaction status → canonical.
 *
 * Ascend's publisher transaction statuses observed in the wild:
 *   pending             → 'pending'  (awaiting the lock period)
 *   locked / approved   → 'approved' (validated, awaiting payment)
 *   paid                → 'paid'
 *   declined / reversed → 'reversed' (the sale did not pay out)
 *   anything else       → 'other'
 *
 * We never invent a status the user did not see on Ascend's side; unknown
 * values map to 'other' and the raw row is preserved on `rawNetworkData`.
 */
function mapTransactionStatus(raw: PepperjamTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'locked' || s === 'approved' || s === 'confirmed') return 'approved';
  if (s === 'paid') return 'paid';
  if (s === 'declined' || s === 'reversed' || s === 'cancelled' || s === 'canceled') {
    return 'reversed';
  }
  return 'other';
}

/**
 * Status normalisation: Pepperjam advertiser relationship → canonical.
 *
 * The advertiser listing exposes the publisher's relationship to the
 * programme. We collapse to our enum and fall back to 'unknown' rather than
 * miscategorising a value we have not seen.
 */
function mapProgrammeStatus(raw: PepperjamAdvertiserRaw): ProgrammeStatus {
  const s = (raw.status ?? raw.relationship ?? '').toLowerCase();
  if (s === 'joined' || s === 'active' || s === 'approved') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'notjoined' || s === 'not_joined') return 'available';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  return 'unknown';
}

/**
 * Coerce a value that may be a number or a numeric string into a number.
 * Returns 0 for anything unparseable so totals never become NaN.
 */
function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Compute the age (in days) of a transaction at response time, anchored on the
 * sale (conversion) date. Ascend's publisher report does not expose a distinct
 * validation/approval date, so the conversion date is the only honest anchor.
 */
function computeAgeDays(raw: PepperjamTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.sale_date ?? raw.modified;
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
// Transformers (Pepperjam raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: PepperjamAdvertiserRaw): Programme {
  const id = String(raw.id ?? '');
  return {
    id,
    name: raw.name ?? `Pepperjam advertiser ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: DEFAULT_CURRENCY,
    // The advertiser listing surfaces commission as a free-text summary; we
    // pass it through as a description rather than guessing a structured rate.
    commissionRate: raw.commission ? { type: 'unknown', description: raw.commission } : undefined,
    categories: (raw.category ?? [])
      .map((c) => c.name)
      .filter((n): n is string => typeof n === 'string'),
    advertiserUrl: raw.website,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: PepperjamTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.commission);
  const sale = toNumber(raw.sale_amount);
  const saleDate = nullableIso(raw.sale_date) ?? new Date(0).toISOString();

  return {
    id: String(raw.transaction_id ?? raw.order_id ?? ''),
    network: SLUG,
    programmeId: String(raw.program_id ?? ''),
    programmeName: raw.program_name ?? '',
    status,
    amount: sale,
    currency: DEFAULT_CURRENCY,
    commission,
    // Ascend's publisher report does not expose a separate click date.
    dateClicked: undefined,
    dateConverted: saleDate,
    // No distinct approval or paid date on this report; leave undefined rather
    // than fabricating.
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // The report does not carry a reversal reason; surface nothing rather than
    // an invented string.
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class PepperjamAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the advertisers (programmes) the publisher can work with.
   *
   *   GET /publisher/advertiser
   *     → `data` is an array of advertisers; paginated via meta.pagination.
   *
   * We page through all results (2500/page) so callers see the full set, then
   * apply client-side filters for search / status / categories / limit. The
   * Ascend advertiser endpoint does not document a server-side search param, so
   * filtering in-process is the honest choice.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');

    const raw = await this.fetchAllPages<PepperjamAdvertiserRaw>(
      'listProgrammes',
      '/publisher/advertiser',
      apiKey,
      {},
      RESILIENCE.listProgrammes ?? RESILIENCE.default,
    );

    let programmes = raw.map(toProgramme);

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
   * Fetch a single advertiser/programme by id.
   *
   * The publisher advertiser endpoint does not document a single-resource path
   * (`/publisher/advertiser/{id}`), so we list and filter client-side. This is
   * the same trade-off Awin makes for its programme search: one round trip,
   * then an in-process match. If a tenant later exposes a by-id path, this is
   * the only method that needs to change.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A Pepperjam advertiser (programme) id is required.',
          hint: 'List programmes first (affiliate_pepperjam_list_programmes) to find the id.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');

    const raw = await this.fetchAllPages<PepperjamAdvertiserRaw>(
      'getProgramme',
      '/publisher/advertiser',
      apiKey,
      {},
      RESILIENCE.getProgramme ?? RESILIENCE.default,
    );

    const match = raw.find((r) => String(r.id ?? '') === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Pepperjam advertiser found with id "${programmeId}".`,
          hint: 'List programmes first (affiliate_pepperjam_list_programmes) to find a valid id.',
        }),
      );
    }

    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions across a date window with optional status / age /
   * programme filters.
   *
   *   GET /publisher/report/transaction-details
   *     ?startDate=YYYY-MM-DD &endDate=YYYY-MM-DD
   *     → `data` is an array of transaction rows; paginated via meta.pagination.
   *
   * Ascend's report API is keyed on calendar dates (`YYYY-MM-DD`). To keep
   * per-call payloads bounded for active publishers we chunk wide windows into
   * 31-day slices (mirroring Awin) and page through each slice. The default
   * window is the last 30 days when no dates are supplied.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: PepperjamTransactionRaw[] = [];
    for (const slice of slices) {
      const rows = await this.fetchAllPages<PepperjamTransactionRaw>(
        'listTransactions',
        '/publisher/report/transaction-details',
        apiKey,
        {
          startDate: formatPepperjamDate(slice.start),
          endDate: formatPepperjamDate(slice.end),
        },
        RESILIENCE.listTransactions ?? RESILIENCE.default,
      );
      allRaw.push(...rows);
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

    // Age filters — applied AFTER status filtering so `{ status, minAgeDays }`
    // is meaningful (PRD §15.9).
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
   * listTransactions (see Awin's getEarningsSummary for why deriving from the
   * transaction record keeps the calculation auditable and avoids two sources
   * of truth). We never apply `limit` here — a summary with a limit would
   * silently undercount (principle 4.1).
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
      currency: DEFAULT_CURRENCY,
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      // Count commission (the publisher's earnings), not sale amount.
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
          programmeName: t.programmeName || `Pepperjam advertiser ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // Oldest unpaid: status in {pending, approved}.
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
   * Pepperjam does not expose click-level data via its public publisher API.
   *
   * We throw `NotImplementedError` rather than returning an empty array — the
   * difference between "no clicks" and "no endpoint" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Pepperjam does not expose click-level data via the public publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Pepperjam tracking links are issued per-creative through the Ascend
   * console / creative API; the publisher API does not document a deterministic
   * URL scheme that can be assembled from (publisherId, programmeId,
   * destinationUrl) the way Awin's `awin1.com/cread.php` link can. Rather than
   * fabricate a URL that may not track, we surface this as unsupported.
   *
   * If Ascend documents a deterministic deep-link format (or a publisher
   * link-builder endpoint), this becomes a real implementation and the
   * limitation line is dropped from META.knownLimitations.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Pepperjam does not document a deterministic publisher tracking-link scheme; ' +
        'links are issued per-creative in the Ascend console',
    );
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

  /**
   * Probe each operation with a minimal call to record live capability data.
   * Known-unsupported ops are recorded without probing (pure waste otherwise).
   * Each probe is isolated in try/catch so one failure does not block the rest.
   */
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
      note: 'Requires a known advertiser id; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Pepperjam does not expose click-level data via the public publisher API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'No documented deterministic publisher tracking-link scheme; links are issued per-creative.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Pagination helper (private)
  // -------------------------------------------------------------------------

  /**
   * Fetch every page of a Pepperjam list/report resource.
   *
   * Ascend paginates via the `meta.pagination` block (2500 rows/page) and a
   * `page` query parameter. We read `meta.pagination.total_pages` after the
   * first page and walk the rest. A guard cap of 1000 pages prevents an
   * unbounded loop if the API ever returns a malformed pagination block.
   */
  private async fetchAllPages<T>(
    operation: string,
    resource: string,
    apiKey: string,
    query: Record<string, string | number | undefined>,
    resilience: ResilienceConfig,
  ): Promise<T[]> {
    const out: T[] = [];
    const MAX_PAGES = 1000;

    let page = 1;
    let totalPages = 1;
    do {
      const envelope = await pepperjamRequest<PepperjamEnvelope<T>>({
        operation,
        resource,
        apiKey,
        query: { ...query, page },
        resilience,
      });

      if (Array.isArray(envelope.data)) out.push(...envelope.data);

      const reported = envelope.meta?.pagination?.total_pages;
      if (typeof reported === 'number' && reported > 0) {
        totalPages = reported;
      }
      page += 1;
    } while (page <= totalPages && page <= MAX_PAGES);

    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (aggregator pattern — see Awin's adapter footer).
// ---------------------------------------------------------------------------

export const pepperjamAdapter = new PepperjamAdapter();
registerAdapter(pepperjamAdapter);

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
 * Split `[from, to]` into ≤`maxDays`-day chunks so wide windows stay bounded
 * per call. Returns at least one slice; if `from >= to` we return one
 * (zero-width) slice so the call shape stays predictable.
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
 * Format a Date for Ascend's `startDate`/`endDate` params. Ascend's report API
 * is keyed on calendar dates (`YYYY-MM-DD`).
 */
function formatPepperjamDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  formatPepperjamDate,
  toNumber,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
