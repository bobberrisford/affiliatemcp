/**
 * Daisycon advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the agency-side reference adapters: Impact
 * (`src/networks/impact-advertiser/`) is the REST template; this adapter
 * follows the same shape (ctx-required brand-scoped ops, listBrands discovery,
 * a per-publisher performance rollup) but speaks Daisycon's OAuth2 + services
 * host, reusing the token-cache pattern from the publisher Daisycon adapter
 * (`src/networks/daisycon/auth.ts`).
 *
 * Auth model: OAuth 2.0 refresh-token grant (see ./auth.ts). One OAuth
 * credential addresses every advertiser account the user is connected to —
 * hence `credentialScope: 'multi-brand'`. The advertiser ids are discovered
 * via `listBrands()` (GET /advertisers) and threaded back in as
 * `ctx.networkBrandId`.
 *
 * Operations:
 *   listBrands              GET /advertisers
 *   verifyAuth              OAuth token exchange (auth.ts)
 *   listProgrammes          derived: distinct programs on /advertisers/{id}/transactions
 *   listTransactions        GET /advertisers/{id}/transactions
 *   getProgrammePerformance GET /advertisers/{id}/transactions, grouped by media (publisher)
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listMediaPartners, listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `daisyconAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings.
 *   5. NEVER issue a non-GET request. The client enforces this; the adapter
 *      must not work around it.
 *   6. Brand-scoped ops REQUIRE `ctx.networkBrandId` — `requireCtx` throws a
 *      config_error envelope rather than guessing an advertiser id.
 */

import { daisyconAdvRequest } from './client.js';
import {
  getAccessToken,
  verifyAuth as authVerify,
  validateCredential as authValidate,
  SLUG,
} from './auth.js';
import { setupSteps } from './setup.js';
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
  type ProgrammeStatus,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('daisycon-advertiser.adapter');
const NAME = 'Daisycon (advertiser)';

/** Daisycon's transactions resource caps page size; 200 matches the publisher adapter. */
const PER_PAGE = 200;
/** Safety bound on pagination so a misreported x-total-count cannot loop forever. */
const MAX_PAGES = 50;

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
    'Read-only at v0.1. The HTTP client refuses any non-GET method.',
    'getProgrammePerformance is derived from /advertisers/{id}/transactions grouped by media (publisher) client-side; Daisycon has no advertiser-scoped statistics endpoint. `// TODO(verify)`.',
    'listProgrammes is derived from the distinct programs on the advertiser transactions; no advertiser-scoped programmes enumeration is documented. `// TODO(verify)`.',
    'listMediaPartners throws NotImplementedError; the publisher roster surfaces via getProgrammePerformance.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 15,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // Transaction queries and the derived performance rollup can run on wide
  // windows and paginate; give them more wall-clock budget.
  listTransactions: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
};

// ---------------------------------------------------------------------------
// Helpers — ctx, status mapping, raw shapes
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing — this can happen if a
 * future caller bypasses the tool dispatcher.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Daisycon advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the Daisycon advertiser id) via brands.json. Call ' +
          '`affiliate_resolve_brand` to see which brands are bound.',
      }),
    );
  }
  return ctx;
}

interface DaisyconAdvAdvertiserRaw {
  id?: number | string;
  advertiser_id?: number | string;
  name?: string;
  title?: string;
  status?: string;
  /** Some payloads flag whether the API can read this advertiser. */
  api_enabled?: boolean | string;
}

interface DaisyconAdvTransactionRaw {
  affiliatemarketing_id?: number | string;
  id?: number | string;
  advertiser_id?: number | string;
  program_id?: number | string;
  program_name?: string;
  media_id?: number | string;
  media_name?: string;
  publisher_id?: number | string;
  publisher_name?: string;
  status?: string;
  currency_code?: string;
  currency?: string;
  /** Order/sale value. */
  amount?: number | string;
  revenue?: number | string;
  /** Commission paid to the publisher. */
  commission?: number | string;
  /** Conversion date. */
  date?: string;
  date_click?: string;
  date_approved?: string;
  disapproved_reason?: string;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map a Daisycon transaction status to canonical `TransactionStatus`.
 *
 * Daisycon's documented status vocabulary on the transactions resource is
 * `open | approved | disapproved` (DataVirtuality reference, Strackr). Some
 * accounts also surface `pending` and `paid`; we map those defensively.
 *   - open / pending → 'pending'
 *   - approved       → 'approved'
 *   - disapproved / declined → 'reversed'
 *   - paid           → 'paid'
 *   - anything else  → 'other'
 */
function mapTransactionStatus(raw: DaisyconAdvTransactionRaw): TransactionStatus {
  const s = String(raw.status ?? '').toLowerCase();
  switch (s) {
    case 'open':
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'disapproved':
    case 'declined':
      return 'reversed';
    case 'paid':
      return 'paid';
    default:
      return 'other';
  }
}

/** Map a canonical performance status from a transaction's canonical status. */
function mapPerformanceStatus(txnStatus: TransactionStatus): ProgrammePerformanceRow['status'] {
  if (txnStatus === 'approved' || txnStatus === 'paid') return 'approved';
  if (txnStatus === 'reversed') return 'reversed';
  return 'pending';
}

/**
 * Map a set of canonical statuses to a single Daisycon upstream status filter.
 * Daisycon's transactions filter takes one status; multi-status queries fall
 * back to client-side filtering (returns undefined).
 */
function mapCanonicalToDaisyconStatus(statuses: TransactionStatus[]): string | undefined {
  if (statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':
      return 'open';
    case 'approved':
      return 'approved';
    case 'reversed':
      return 'disapproved';
    case 'paid':
      return 'paid';
    default:
      return undefined;
  }
}

function toAmount(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDaisyconDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  let candidate = input.trim();
  if (candidate === '') return undefined;
  // Daisycon dates are typically `YYYY-MM-DD HH:MM:SS` (no zone). Normalise to ISO.
  if (candidate.includes(' ') && !candidate.includes('T')) {
    candidate = candidate.replace(' ', 'T');
  }
  if (!/[Zz]$/.test(candidate) && !/[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

function computeAgeDays(raw: DaisyconAdvTransactionRaw, now: Date = new Date()): number {
  const parsed = parseDaisyconDate(raw.date);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

function readCurrency(raw: DaisyconAdvTransactionRaw): string {
  return raw.currency_code ?? raw.currency ?? 'EUR';
}

function publisherIdOf(raw: DaisyconAdvTransactionRaw): string {
  return String(raw.media_id ?? raw.publisher_id ?? '');
}

function publisherNameOf(raw: DaisyconAdvTransactionRaw): string {
  return raw.media_name ?? raw.publisher_name ?? '';
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toDiscoveredBrand(raw: DaisyconAdvAdvertiserRaw): DiscoveredBrand {
  const id = String(raw.id ?? raw.advertiser_id ?? '');
  const apiEnabledRaw = raw.api_enabled;
  const apiEnabled =
    apiEnabledRaw === undefined
      ? true
      : typeof apiEnabledRaw === 'boolean'
        ? apiEnabledRaw
        : String(apiEnabledRaw).toLowerCase() !== 'false';
  return {
    networkBrandId: id,
    displayName: raw.name ?? raw.title ?? `Daisycon advertiser ${id}`,
    apiEnabled,
  };
}

function toTransaction(raw: DaisyconAdvTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const currency = readCurrency(raw);
  return {
    id: String(raw.affiliatemarketing_id ?? raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.program_id ?? raw.advertiser_id ?? ''),
    programmeName: raw.program_name ?? '',
    status,
    amount: toAmount(raw.amount ?? raw.revenue),
    currency,
    commission: toAmount(raw.commission),
    dateClicked: parseDaisyconDate(raw.date_click),
    dateConverted: parseDaisyconDate(raw.date) ?? new Date(0).toISOString(),
    dateApproved: parseDaisyconDate(raw.date_approved),
    datePaid: status === 'paid' ? parseDaisyconDate(raw.date_approved) : undefined,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.disapproved_reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(raw: DaisyconAdvTransactionRaw): Programme {
  const id = String(raw.program_id ?? raw.advertiser_id ?? '');
  const status: ProgrammeStatus = 'joined';
  return {
    id,
    name: raw.program_name ?? `Daisycon programme ${id}`,
    network: SLUG,
    status,
    currency: readCurrency(raw),
    rawNetworkData: {
      derivedFrom:
        'distinct program present on the advertiser transactions (Daisycon does not document an ' +
        'advertiser-scoped programmes enumeration endpoint)',
      program_id: raw.program_id,
      program_name: raw.program_name,
      advertiser_id: raw.advertiser_id,
    },
  };
}

/**
 * Group transaction rows into per-publisher (media) performance rows.
 *
 * Daisycon exposes no advertiser-scoped statistics/grouping endpoint, so we
 * aggregate the advertiser transactions client-side: one row per
 * (date, publisher, status) key. `clicks` is always 0 — the transactions
 * resource does not carry click counts; the operator can drill into
 * rawNetworkData. `// TODO(verify)` against a live advertiser account.
 */
function rollupPerformance(
  rows: DaisyconAdvTransactionRaw[],
): ProgrammePerformanceRow[] {
  const buckets = new Map<string, ProgrammePerformanceRow>();
  for (const raw of rows) {
    const txnStatus = mapTransactionStatus(raw);
    const status = mapPerformanceStatus(txnStatus);
    const iso = parseDaisyconDate(raw.date);
    const date = iso ? iso.slice(0, 10) : '';
    const publisherId = publisherIdOf(raw);
    const currency = readCurrency(raw);
    const key = `${date}|${publisherId}|${status}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        date,
        publisherId,
        publisherName: publisherNameOf(raw),
        clicks: 0,
        conversions: 0,
        grossSale: 0,
        commission: 0,
        currency,
        status,
        rawNetworkData: [] as DaisyconAdvTransactionRaw[],
      };
      buckets.set(key, bucket);
    }
    bucket.conversions += 1;
    bucket.grossSale += toAmount(raw.amount ?? raw.revenue);
    bucket.commission += toAmount(raw.commission);
    if (!bucket.publisherName) bucket.publisherName = publisherNameOf(raw);
    (bucket.rawNetworkData as DaisyconAdvTransactionRaw[]).push(raw);
  }
  return [...buckets.values()];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class DaisyconAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the advertiser accounts the credential is connected to via
   * GET /advertisers.
   *
   * Source: https://github.com/aiwha-dev/DaisyconApi (RestClient.php
   *   getAdvertisers() → /advertisers against https://services.daisycon.com).
   * `// TODO(verify)`: exact response shape (array vs `{ advertisers: [...] }`)
   * and per-advertiser api-enabled flag against a live account; the transformer
   * reads multiple field aliases defensively.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const token = await getAccessToken();
    const { body } = await daisyconAdvRequest<
      DaisyconAdvAdvertiserRaw[] | { advertisers?: DaisyconAdvAdvertiserRaw[] }
    >({
      operation: 'listMediaPartners',
      path: '/advertisers',
      token,
      query: { page: 1, per_page: PER_PAGE },
      resilience: RESILIENCE.default,
    });
    const list: DaisyconAdvAdvertiserRaw[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { advertisers?: DaisyconAdvAdvertiserRaw[] }).advertisers)
        ? ((body as { advertisers: DaisyconAdvAdvertiserRaw[] }).advertisers)
        : [];
    return list.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth — reuse the OAuth token-exchange probe.
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
  // Internal: page through /advertisers/{id}/transactions.
  // -------------------------------------------------------------------------

  private async fetchTransactionRows(
    operation: 'listTransactions' | 'getProgrammePerformance',
    networkBrandId: string,
    query: {
      from?: string;
      to?: string;
      status?: string;
      mediaId?: string;
      programId?: string;
    },
  ): Promise<DaisyconAdvTransactionRaw[]> {
    const token = await getAccessToken();
    const path = `/advertisers/${encodeURIComponent(networkBrandId)}/transactions`;
    const resilience = RESILIENCE[operation] ?? RESILIENCE.default;

    const collected: DaisyconAdvTransactionRaw[] = [];
    let page = 1;
    let totalCount = NaN;

    while (page <= MAX_PAGES) {
      const { body, totalCount: tc } = await daisyconAdvRequest<DaisyconAdvTransactionRaw[]>({
        operation,
        path,
        token,
        query: {
          page,
          per_page: PER_PAGE,
          start: query.from ? query.from.slice(0, 10) : undefined,
          end: query.to ? query.to.slice(0, 10) : undefined,
          status: query.status,
          media_id: query.mediaId,
          program_id: query.programId,
        },
        resilience,
      });
      const rows = Array.isArray(body) ? body : [];
      collected.push(...rows);
      if (!Number.isNaN(tc)) totalCount = tc;

      // Stop when we have everything (per x-total-count) or got a partial page.
      if (rows.length < PER_PAGE) break;
      if (!Number.isNaN(totalCount) && collected.length >= totalCount) break;
      page += 1;
    }
    return collected;
  }

  // -------------------------------------------------------------------------
  // listTransactions — advertiser's transactions, brand-scoped.
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const now = new Date();

    const statusList = toTransactionStatusList(query?.status);
    const upstreamStatus = statusList ? mapCanonicalToDaisyconStatus(statusList) : undefined;

    const rows = await this.fetchTransactionRows('listTransactions', c.networkBrandId, {
      from: query?.from,
      to: query?.to,
      status: upstreamStatus,
      programId: query?.programmeId,
    });

    let txns = rows.map((r) => toTransaction(r, now));

    if (statusList && statusList.length > 0) {
      const set = new Set(statusList);
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
  // listProgrammes — derived from distinct programs on the advertiser txns.
  // -------------------------------------------------------------------------

  /**
   * Daisycon does not document an advertiser-scoped programmes enumeration, so
   * we derive the programmes from the distinct `program_id`s present on the
   * advertiser's transactions. `// TODO(verify)` against a live account; if an
   * advertiser-scoped /programs endpoint exists, prefer it.
   */
  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const rows = await this.fetchTransactionRows('listTransactions', c.networkBrandId, {});

    const seen = new Map<string, Programme>();
    for (const raw of rows) {
      const id = String(raw.program_id ?? raw.advertiser_id ?? '');
      if (!seen.has(id)) seen.set(id, toProgramme(raw));
    }
    let programmes = [...seen.values()];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher rollup over advertiser txns.
  // -------------------------------------------------------------------------

  /**
   * Daisycon's pre-aggregated statistics resource is publisher-scoped only
   * (`/publishers/{id}/statistics/...`), so for the advertiser side we derive a
   * per-publisher (media) rollup client-side from
   * `/advertisers/{id}/transactions`. One row per (date, publisher, status);
   * `clicks` is 0 because the transactions resource carries no click count.
   * `// TODO(verify)` against a live advertiser account.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);

    const rows = await this.fetchTransactionRows('getProgrammePerformance', c.networkBrandId, {
      from: query?.from,
      to: query?.to,
      mediaId: query?.publisherId,
      programId: query?.programmeId,
    });

    let perf = rollupPerformance(rows);
    if (query?.publisherId) perf = perf.filter((r) => r.publisherId === query.publisherId);
    if (typeof query?.limit === 'number') perf = perf.slice(0, query.limit);
    return perf;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Daisycon advertiser adapter does not implement getProgramme at v0.1; programmes are derived, use listProgrammes and filter client-side.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Daisycon advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Daisycon advertiser adapter does not implement listClicks at v0.1; Daisycon does not expose click-level data on the advertiser surface.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Daisycon advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listMediaPartners(
    _query?: MediaPartnerQuery,
    _ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    throw new NotImplementedError(
      'Daisycon advertiser adapter does not implement listMediaPartners at v0.1; Daisycon does not document an advertiser-scoped publisher-roster endpoint — publishers surface via getProgrammePerformance.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Not implemented for Daisycon advertiser at v0.1; publishers surface via getProgrammePerformance.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Daisycon advertiser at v0.1.');
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
      note: 'OAuth2 token exchange; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note: 'GET /advertisers. Response shape `// TODO(verify)` against a live account.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Derived from distinct programs on /advertisers/{id}/transactions; no advertiser-scoped /programs endpoint documented.',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'GET /advertisers/{id}/transactions; status open|approved|disapproved mapped to canonical states.',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Derived per-publisher rollup over /advertisers/{id}/transactions; Daisycon has no advertiser-scoped statistics endpoint, clicks reported as 0. `// TODO(verify)`.',
      claimStatus: 'experimental',
    };
    operations['listMediaPartners'] = {
      supported: false,
      note: 'No advertiser-scoped publisher-roster endpoint documented; publishers surface via getProgrammePerformance.',
    };
    operations['getProgramme'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['getEarningsSummary'] = { supported: false, note: 'Not implemented at v0.1.' };
    operations['listClicks'] = { supported: false, note: 'Not implemented at v0.1.' };
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

export const daisyconAdvertiserAdapter = new DaisyconAdvertiserAdapter();
registerAdapter(daisyconAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// Silence unused-import lint when noUnusedLocals is on.
void log;

export const _internals = {
  toDiscoveredBrand,
  toTransaction,
  toProgramme,
  rollupPerformance,
  mapTransactionStatus,
  mapPerformanceStatus,
  mapCanonicalToDaisyconStatus,
  parseDaisyconDate,
  computeAgeDays,
  toAmount,
};
