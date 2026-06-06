/**
 * Adrecord adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and the custom-header client in `src/networks/everflow/client.ts`. Read the
 * Awin header before modifying this one — the six cardinal rules apply here too.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `APIKEY: <key>` (also accepted as GET/POST var).
 * Base:    https://api.v2.adrecord.com
 * Docs:    https://api.v2.adrecord.com/docs/   (affiliate API v2)
 * Region:  Nordic (Sweden). Default reporting currency is typically SEK.
 * Rate:    ~30 requests per 30 seconds. The client wraps every call in
 *          withResilience; a throttle response (429) is retried with backoff,
 *          and listTransactions chunks wide windows so a single user query
 *          does not fan out into a burst that trips the limit.
 *
 * --- Endpoint map (verify against https://api.v2.adrecord.com/docs/) --------
 *
 *   GET  /programs            → programmes the publisher can work with.
 *                               Fields: id, name, status, currency, channels.
 *   GET  /channels            → the publisher's own channels (id, name).
 *   GET  /transactions        → latest transactions; default limit 10, sorted
 *                               by descending date. Supports fromDate / toDate /
 *                               lastUpdated / limit. Fields per row: id, date,
 *                               status, orderValue, commission, currency,
 *                               channel{id,name}, program{id,name},
 *                               commissionName, changes[].
 *   GET  /statistics          → aggregate report (impressions / clicks /
 *                               transactions per channel). Not per-transaction,
 *                               so we derive earnings from /transactions.
 *
 * --- Status mapping ---------------------------------------------------------
 *
 * Adrecord transaction status strings → canonical TransactionStatus. See
 * `mapTransactionStatus`. Adrecord exposes: Pending, Approved, Rejected,
 * Invoiced, Invoiced Paid, Paid to affiliate. We map "Paid to affiliate" and
 * "Invoiced Paid" to `paid`, "Approved"/"Invoiced" to `approved`, "Pending" to
 * `pending`, "Rejected" to `reversed`, and anything else to `other`.
 *
 * --- Amount unit ASSUMPTION -------------------------------------------------
 *
 * Adrecord reports `orderValue` and `commission` as numbers in major currency
 * units (e.g. commission: 10 with currency: "SEK" is 10 kronor, NOT 1000 öre).
 * This matches the documented examples but has NOT been confirmed against a
 * live account. If a future live test shows minor units, divide by 100 in the
 * transformer and update network.json `known_limitations`.
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Click-level data is not exposed as a list endpoint (only aggregate counts
 *     in /statistics); listClicks is unsupported.
 *   - The tracking-link URL format is not publicly documented in a way that
 *     allows deterministic construction; generateTrackingLink is unsupported.
 *   - Built from public API documentation; not yet verified against a live
 *     account.
 */

import { adrecordRequest } from './client.js';
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

const log = createLogger('adrecord.adapter');

const SLUG = 'adrecord';
const NAME = 'Adrecord';

/** Default reporting currency when a row omits one (Adrecord is SEK-first). */
const DEFAULT_CURRENCY = 'SEK';

/**
 * Adrecord's `/transactions` default page size is small (10). We chunk wide
 * date windows so a "last 90 days" query does not silently truncate at the
 * default page. Each chunk requests a generous explicit limit per slice.
 */
const TRANSACTIONS_CHUNK_DAYS = 31;
const TRANSACTIONS_PER_CHUNK = 1000;

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.v2.adrecord.com',
  // Adrecord uses a custom `APIKEY` header rather than standard Bearer.
  authModel: 'custom',
  docsUrl: 'https://api.v2.adrecord.com/docs/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: built from public API docs, not yet validated against a
  // live Adrecord account, and two operations are structurally unsupported.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live Adrecord account.',
    'Click-level data is not exposed as a list endpoint by the public Adrecord affiliate API; listClicks is unsupported.',
    'Tracking-link construction is not publicly documented for deterministic assembly; generateTrackingLink is unsupported.',
    'Transaction amounts are assumed to be in major currency units (e.g. SEK, not öre); not yet confirmed against a live account.',
    'Adrecord throttles the affiliate API at roughly 30 requests per 30 seconds; wide date ranges are chunked to stay within the limit.',
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
 * Transactions can be slow when a wide window returns many rows. Mirror the
 * Awin choice: a longer timeout and one extra retry so a transient gateway
 * error during heavy hours resolves rather than failing the whole call.
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
// Adrecord response shapes (deliberately minimal — every field optional)
// ---------------------------------------------------------------------------
//
// We do not model these with strict schemas. Adrecord's surface may drift; a
// defensive transformer that treats every field as possibly absent and keeps
// the original under `rawNetworkData` is more robust than a hard schema.
// ---------------------------------------------------------------------------

interface AdrecordProgrammeRaw {
  id?: number | string;
  name?: string;
  status?: string;
  currency?: string;
  category?: string;
  categories?: string[];
  url?: string;
  website?: string;
}

interface AdrecordChannelRaw {
  id?: number | string;
  name?: string;
}

interface AdrecordTransactionRaw {
  id?: number | string;
  date?: string;
  status?: string;
  orderValue?: number;
  commission?: number;
  commissionName?: string;
  currency?: string;
  channel?: AdrecordChannelRaw;
  program?: { id?: number | string; name?: string };
  // Adrecord exposes a status history under `changes`. We read the most recent
  // entry's date as the "approved"/updated anchor where present.
  changes?: Array<{ type?: string; date?: string; from?: string; to?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Adrecord → canonical TransactionStatus.
 *
 * Adrecord's documented status values are:
 *   Pending          → 'pending'
 *   Approved         → 'approved'
 *   Invoiced         → 'approved'  (commission confirmed, billed to advertiser,
 *                                   but not yet paid out to the affiliate)
 *   Invoiced Paid    → 'paid'      (advertiser settled the invoice)
 *   Paid to affiliate→ 'paid'
 *   Rejected         → 'reversed'  (the sale did not pay out — same user intent
 *                                   as Awin's "declined")
 *   anything else    → 'other'     (never invent a status the user did not see)
 *
 * Matching is case-insensitive and whitespace-tolerant because the casing of
 * these strings is not guaranteed across the API surface.
 */
function mapTransactionStatus(raw: AdrecordTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').trim().toLowerCase();
  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'invoiced':
      return 'approved';
    case 'invoiced paid':
    case 'paid to affiliate':
    case 'paid':
      return 'paid';
    case 'rejected':
    case 'declined':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Adrecord programme status → canonical ProgrammeStatus.
 *
 * Adrecord's affiliate /programs endpoint distinguishes programmes the
 * publisher has joined (an "active" relationship) from those still available
 * to apply to. We collapse the observed strings:
 *
 *   active / joined / approved → 'joined'
 *   pending / applied          → 'pending'
 *   rejected / declined        → 'declined'
 *   available / open / notjoined → 'available'
 *   paused / suspended / closed → 'suspended'
 *   anything else              → 'unknown'
 *
 * We prefer 'unknown' over a wrong guess; Adrecord may add states we have not
 * seen.
 */
function mapProgrammeStatus(raw: AdrecordProgrammeRaw): ProgrammeStatus {
  const s = (raw.status ?? '').trim().toLowerCase();
  if (s === 'active' || s === 'joined' || s === 'approved') return 'joined';
  if (s === 'pending' || s === 'applied') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'open' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'closed') return 'suspended';
  return 'unknown';
}

/**
 * Compute the age (in days) of a transaction. PRD §15.9 — the unpaid-age
 * affordance depends on this number.
 *
 * Adrecord exposes a single `date` (the conversion date) plus a `changes`
 * history. We anchor on the conversion date because it is always present;
 * the status-change history is supplementary and not consistently dated.
 */
function computeAgeDays(raw: AdrecordTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.date;
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

/** Latest status-change date, used as the "approved"/last-updated anchor. */
function latestChangeIso(raw: AdrecordTransactionRaw): string | undefined {
  const dates = (raw.changes ?? [])
    .map((c) => (c.date ? Date.parse(c.date) : NaN))
    .filter((t) => !Number.isNaN(t));
  if (dates.length === 0) return undefined;
  return new Date(Math.max(...dates)).toISOString();
}

// ---------------------------------------------------------------------------
// Transformers (Adrecord raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: AdrecordProgrammeRaw): Programme {
  const id = String(raw.id ?? '');
  const categories =
    raw.categories ?? (typeof raw.category === 'string' ? [raw.category] : undefined);
  return {
    id,
    name: raw.name ?? `Adrecord programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    // Adrecord's /programs listing does not expose a structured commission rate
    // we can map confidently, so we leave commissionRate undefined and keep the
    // verbatim payload on rawNetworkData.
    categories: categories?.filter((c): c is string => typeof c === 'string'),
    advertiserUrl: raw.url ?? raw.website,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AdrecordTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = raw.commission ?? 0;
  const sale = raw.orderValue ?? 0;
  const currency = raw.currency ?? DEFAULT_CURRENCY;

  const converted = nullableIso(raw.date) ?? new Date(0).toISOString();
  const approved = latestChangeIso(raw);

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.program?.id ?? ''),
    programmeName: raw.program?.name ?? '',
    status,
    amount: sale,
    currency,
    commission,
    // Adrecord does not expose a separate click date on the transaction row.
    dateClicked: undefined,
    dateConverted: converted,
    dateApproved: approved,
    // Adrecord folds payment into the status string ("Paid to affiliate"); it
    // does not expose a discrete paid date. Leave undefined rather than
    // fabricating one.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // Adrecord does not expose a free-text rejection reason on the transaction;
    // the status-change history is the closest signal but is not a reason
    // string. Leave undefined rather than inventing text.
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class AdrecordAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Adrecord programmes the publisher can work with.
   *
   * Adrecord's `/programs` endpoint returns an array of programmes. There is no
   * documented server-side `search`/`status`/`category` filter we can rely on,
   * so we fetch and filter client-side — the same approach Awin uses for its
   * unsupported search parameter.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');

    const raw = await adrecordRequest<AdrecordProgrammeRaw[] | { programs?: AdrecordProgrammeRaw[] }>({
      operation: 'listProgrammes',
      path: '/programs',
      apiKey,
      query: { limit: query?.limit },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = normaliseList<AdrecordProgrammeRaw>(raw, 'programs').map(toProgramme);

    const statusFilter = toStatusList(query?.status);
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
   * Fetch a single programme by id.
   *
   * Adrecord programme ids are numeric. Adrecord's affiliate API does not
   * document a per-programme detail path that adds fields beyond the list row,
   * so we fetch the list and select the matching id client-side. This keeps the
   * shape predictable and avoids guessing an undocumented endpoint.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Adrecord programme ids are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_adrecord_list_programmes) to find the correct id.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');

    const raw = await adrecordRequest<AdrecordProgrammeRaw[] | { programs?: AdrecordProgrammeRaw[] }>({
      operation: 'getProgramme',
      path: '/programs',
      apiKey,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const match = normaliseList<AdrecordProgrammeRaw>(raw, 'programs').find(
      (p) => String(p.id ?? '') === programmeId,
    );

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Adrecord returned no programme with id "${programmeId}".`,
          hint: 'The id may be wrong, or the programme is not visible to this account.',
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
   * Adrecord endpoint: `GET /transactions?fromDate=...&toDate=...&limit=...`.
   * The default page size is small (10) and the API throttles at ~30 req/30s,
   * so we chunk the window into ≤31-day slices, request a generous explicit
   * limit per slice, and run the slices sequentially. A wider caller window
   * therefore makes several calls but never silently truncates at the default
   * page.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, TRANSACTIONS_CHUNK_DAYS);

    const allRaw: AdrecordTransactionRaw[] = [];
    for (const slice of slices) {
      const chunk = await adrecordRequest<
        AdrecordTransactionRaw[] | { transactions?: AdrecordTransactionRaw[] }
      >({
        operation: 'listTransactions',
        path: '/transactions',
        apiKey,
        query: {
          fromDate: formatAdrecordDate(slice.start),
          toDate: formatAdrecordDate(slice.end),
          limit: TRANSACTIONS_PER_CHUNK,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...normaliseList<AdrecordTransactionRaw>(chunk, 'transactions'));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter — client-side; the endpoint window is per-date, not
    // per-programme.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Status filter.
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9. Applied AFTER status filtering so a query like
    // { status: 'approved', minAgeDays: 180 } is meaningful.
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
   * We derive from `listTransactions` rather than the `/statistics` endpoint:
   * /statistics returns aggregate impression/click/transaction counts per
   * channel, not the per-transaction status buckets or `ageDays` we need for
   * `oldestUnpaidAgeDays`. Deriving from transactions keeps the calculation
   * auditable — the user can recompute the same numbers from listTransactions.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Pull the underlying transactions (ignoring `limit` — a limit on a summary
    // would silently undercount, violating principle 4.1).
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
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      // Count commission, not sale amount — the user's earnings.
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
          programmeName: t.programmeName || `Adrecord programme ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid age. Unpaid = status in {pending, approved}.
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
   * Adrecord does not expose click-level data as a list endpoint. The
   * `/statistics` endpoint returns aggregate click counts per channel, not the
   * individual click rows the `Click` type describes.
   *
   * We throw `NotImplementedError` rather than returning an empty array — the
   * difference between "no clicks" and "no per-click API" is the difference
   * between an actionable observation and a wild goose chase (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Adrecord does not expose click-level data as a list endpoint via the public affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Adrecord's tracking-link format is not publicly documented in a way that
   * lets us construct a link deterministically (the affiliate dashboard issues
   * per-programme tracking links keyed to a channel id, but the URL scheme and
   * the deep-link parameter are not specified in the public affiliate API).
   *
   * Rather than guess at a URL shape and emit a link that may not redirect, we
   * throw `NotImplementedError` with a clear reason. If Adrecord documents the
   * scheme (or exposes a link-builder endpoint), this becomes a real
   * implementation and the limitation is dropped from network.json.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Adrecord does not publicly document a deterministic tracking-link format for the affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth`, which makes the cheap `GET /programs?limit=1`
   * call and never throws. We map its result to the adapter contract type.
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
   * Known-unsupported operations are recorded without probing.
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
      note: 'Requires a known programme id; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Adrecord does not expose click-level data as a list endpoint via the public affiliate API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Adrecord does not publicly document a deterministic tracking-link format',
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
// Module-level registration (see Awin adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const adrecordAdapter = new AdrecordAdapter();
registerAdapter(adrecordAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Adrecord endpoints may return a bare JSON array or an object wrapping the
 * array under a named key (e.g. `{ programs: [...] }`). Accept both and fall
 * back to an empty array.
 */
function normaliseList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const wrapped = (raw as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return wrapped as T[];
  }
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
 * Split `[from, to]` into ≤`maxDays`-day chunks so wide windows stay within the
 * default page size and the request-rate limit. Returns at least one slice; if
 * `from >= to` we still return one (zero-width) slice so the call shape stays
 * predictable.
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
 * Format a Date for Adrecord's `fromDate`/`toDate` params. Adrecord documents
 * these as UTC timestamps; we send an ISO-8601 string to the second (no
 * milliseconds) which the API parses cleanly.
 */
function formatAdrecordDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  latestChangeIso,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatAdrecordDate,
  normaliseList,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
