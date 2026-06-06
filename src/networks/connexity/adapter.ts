/**
 * Connexity adapter — US CPC-commerce affiliate network (ShopYourLikes).
 *
 * Structured on the Awin reference (`src/networks/awin/adapter.ts`); read that
 * file first for the full rationale behind the seven-operation shape, status
 * normalisation, `ageDays`, and the module-level `registerAdapter` side effect.
 *
 * IMPORTANT — Connexity is DISTINCT from the Skimlinks adapter
 * (`src/networks/skimlinks/`). Both monetise publisher links across many
 * merchants, but they are separate networks with separate credentials, hosts,
 * and APIs. This adapter must not be conflated with Skimlinks.
 *
 * --- How Connexity differs from a classic CPA network -----------------------
 *
 * Connexity pays on a cost-per-click (CPC) basis: a publisher earns when a user
 * is redirected to a merchant, not (necessarily) when a sale completes. That
 * shapes every operation:
 *
 *   - There is no per-sale transaction ledger. Reporting is DAILY AGGREGATE:
 *     redirects, estimated earnings, and effective CPC per day. `listTransactions`
 *     therefore surfaces one synthetic transaction PER DAY rather than per sale.
 *   - "Programmes" come from the Merchant Match API: keyword-driven merchant
 *     discovery returning each merchant's monetised deep-link and effective CPC.
 *   - A tracking link is produced by an API round-trip (the Deep Link API turns
 *     a destination URL into a monetised redirect), not by deterministic URL
 *     construction.
 *
 * --- Connexity API map ------------------------------------------------------
 *
 * Reporting + Merchant Match host: https://publisher-api.connexity.com
 *   GET /api/reporting/earnings?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *     → { publisherId, entriesCount, earnings: [{ date, redirects,
 *         estimatedEarnings, cpc }], totals: { cpcRedirects, cpaRedirects,
 *         earnings } }
 *   GET /api/merchant-match?keyword=...
 *     → { merchantMatches: [{ merchantId, merchantName, merchantUrl,
 *         deeplinkEcpc, deeplinkUrl, searchCategoryId, productSearchUrl }] }
 *
 * Deep Link host: https://api.cnnx.link
 *   GET /api/link/generate?url=...&afCampaignId=...&afPlacementId=...
 *     → { originalUrl, ecpc, publisherId, link }
 *
 * Auth on every call: `publisherId` + `apiKey` query parameters (see client.ts).
 *
 * Docs:
 *   - https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference
 *   - https://pubresources.connexity.com/hc/en-us/articles/17357975725085-Merchant-Match-API
 *   - http://api.cnnx.link/docs/api/overview
 *
 * Cardinal rules (mirrored from Awin):
 *   1. NEVER call `fetch` directly — use `connexityRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope` (principle 4.1).
 *   3. PRESERVE the raw response on `rawNetworkData`.
 *   4. NORMALISE status enums; prefer the honest mapping over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme", not "program").
 */

import { connexityRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
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
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('connexity.adapter');

const SLUG = 'connexity';
const NAME = 'Connexity';

/**
 * Connexity reports CPC earnings as US dollars with a decimal point
 * (`estimatedEarnings: 150.00`, `cpc: 0.50`). We treat the figure as a major
 * currency unit (dollars), not minor units (cents). See the amount-unit note in
 * `network.json` known_limitations — this is an assumption pending live
 * verification against a real account.
 */
const CURRENCY = 'USD';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://publisher-api.connexity.com',
  authModel: 'custom',
  docsUrl:
    'https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: the adapter has not been validated against a live Connexity publisher account; endpoint shapes are mapped from public documentation.',
    'Connexity is a cost-per-click (CPC) network: reporting is daily aggregate, not per-sale. listTransactions surfaces one synthetic transaction per day (redirects, estimated earnings, effective CPC) rather than individual sales, and all rows are reported as "approved" because CPC earnings carry no pending/reversed sale lifecycle.',
    'Amount unit assumed to be major currency units (US dollars) based on the documented decimal earnings figures; not yet confirmed against a live account.',
    'Click-level data is not exposed as structured records via the publisher API; the Get Click Report endpoint returns a CSV download rather than per-click rows, so listClicks is unsupported.',
    'Distinct from the Skimlinks adapter: Connexity (ShopYourLikes) is a separate network with separate credentials, hosts, and API.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Connexity response shapes (deliberately minimal — read defensively)
// ---------------------------------------------------------------------------

interface ConnexityMerchantRaw {
  merchantId?: number | string;
  merchantName?: string;
  merchantUrl?: string;
  deeplinkEcpc?: number;
  deeplinkUrl?: string;
  searchCategoryId?: number | string;
  productSearchUrl?: string;
}

interface ConnexityMerchantMatchEnvelope {
  merchantMatches?: ConnexityMerchantRaw[];
}

interface ConnexityEarningsRow {
  date?: string;
  redirects?: number;
  estimatedEarnings?: number;
  cpc?: number;
}

interface ConnexityEarningsEnvelope {
  publisherId?: number | string;
  entriesCount?: number;
  earnings?: ConnexityEarningsRow[];
  totals?: { cpcRedirects?: number; cpaRedirects?: number; earnings?: number };
}

interface ConnexityLinkRaw {
  originalUrl?: string;
  ecpc?: number;
  publisherId?: number | string;
  link?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as Connexity's `YYYY-MM-DD` date parameter. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Programme status for Connexity merchants.
 *
 * Connexity is an open CPC network: the Merchant Match API returns merchants a
 * publisher can monetise immediately, with no per-merchant join/approval
 * lifecycle exposed via the API. We therefore report every matched merchant as
 * 'joined' (the publisher can transact against it now). We do NOT invent
 * pending/declined states the API does not surface (cardinal rule 4).
 */
function mapMerchantStatus(_raw: ConnexityMerchantRaw): ProgrammeStatus {
  return 'joined';
}

/**
 * Transaction status for a Connexity daily earnings row.
 *
 * CPC earnings have no sale-level pending/approved/reversed lifecycle: a
 * redirect either earned or it did not, and the reported figure is an estimate
 * that settles. We map every row to 'approved' (recognised earnings) rather
 * than guess a richer lifecycle the API does not expose. The verbatim row is
 * preserved on `rawNetworkData`.
 */
function mapEarningsStatus(_raw: ConnexityEarningsRow): TransactionStatus {
  return 'approved';
}

/**
 * Compute the age (in days) of a daily earnings row at response time. Anchored
 * on the row `date` (the only date Connexity exposes for CPC earnings).
 */
function computeAgeDays(raw: ConnexityEarningsRow, now: Date = new Date()): number {
  if (!raw.date) return 0;
  const t = Date.parse(raw.date);
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
// Transformers (Connexity raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: ConnexityMerchantRaw): Programme {
  const id = String(raw.merchantId ?? '');
  return {
    id,
    name: raw.merchantName ?? `Connexity merchant ${id}`,
    network: SLUG,
    status: mapMerchantStatus(raw),
    currency: CURRENCY,
    // Connexity exposes the effective CPC (eCPC) per merchant rather than a
    // commission percentage. Surface it as a structured flat amount in the
    // network's currency so the caller has the monetisation signal.
    commissionRate:
      raw.deeplinkEcpc !== undefined
        ? {
            type: 'flat',
            value: raw.deeplinkEcpc,
            currency: CURRENCY,
            description: `Effective CPC ${raw.deeplinkEcpc} ${CURRENCY}`,
          }
        : undefined,
    advertiserUrl: raw.merchantUrl,
    rawNetworkData: raw,
  };
}

/**
 * Build a synthetic per-day transaction from a Connexity earnings row.
 *
 * Connexity has no per-sale ledger, so each daily aggregate becomes one
 * Transaction: `amount` and `commission` both carry the day's estimated CPC
 * earnings (there is no separate gross-sale figure for CPC), `dateConverted` is
 * the row date, and the id is derived from the date so it is stable across
 * calls.
 */
function toTransaction(raw: ConnexityEarningsRow, now: Date = new Date()): Transaction {
  const earnings = raw.estimatedEarnings ?? 0;
  const dateConverted = nullableIso(raw.date) ?? new Date(0).toISOString();
  return {
    id: `connexity-earnings-${raw.date ?? 'unknown'}`,
    network: SLUG,
    // CPC earnings are reported across all merchants in aggregate, not per
    // programme, so there is no programme id on a daily row.
    programmeId: '',
    programmeName: 'Connexity CPC earnings (all merchants)',
    status: mapEarningsStatus(raw),
    amount: earnings,
    currency: CURRENCY,
    commission: earnings,
    dateConverted,
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class ConnexityAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — Merchant Match
  // -------------------------------------------------------------------------

  /**
   * Discover monetisable Connexity merchants via the Merchant Match API.
   *
   * Merchant Match is keyword-driven: `query.search` becomes the `keyword`
   * parameter. Connexity has no "list every merchant" endpoint, so a search
   * term is the natural discovery key; when none is supplied we send a broad
   * default keyword so the operator still gets a sample of merchants rather
   * than an empty result.
   *
   * Status filtering is a client-side no-op in practice: every matched merchant
   * is 'joined' (open CPC network). We still honour `query.status` so a caller
   * asking for non-'joined' programmes gets an honest empty list.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const publisherId = requireCredential('CONNEXITY_PUBLISHER_ID', {
      network: SLUG,
      operation: 'listProgrammes',
    });
    const apiKey = requireCredential('CONNEXITY_API_KEY', {
      network: SLUG,
      operation: 'listProgrammes',
    });

    const keyword = query?.search && query.search.trim() !== '' ? query.search.trim() : 'shop';

    const raw = await connexityRequest<ConnexityMerchantMatchEnvelope>({
      operation: 'listProgrammes',
      path: '/api/merchant-match',
      publisherId,
      apiKey,
      query: { keyword },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (Array.isArray(raw?.merchantMatches) ? raw.merchantMatches : []).map(
      toProgramme,
    );

    if (query?.status) {
      const wanted = Array.isArray(query.status) ? query.status : [query.status];
      const set = new Set(wanted);
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
   * Fetch a single Connexity merchant by id.
   *
   * Connexity has no by-id merchant endpoint; Merchant Match is keyword-driven.
   * We run a merchant match (using the supplied search term if present, else a
   * broad default) and select the merchant whose id matches. If no match is
   * found we surface a `network_api_error` envelope rather than fabricating a
   * stub programme.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A Connexity merchant id is required.',
          hint: 'List programmes first (affiliate_connexity_list_programmes) to find the merchant id.',
        }),
      );
    }

    const publisherId = requireCredential('CONNEXITY_PUBLISHER_ID', {
      network: SLUG,
      operation: 'getProgramme',
    });
    const apiKey = requireCredential('CONNEXITY_API_KEY', {
      network: SLUG,
      operation: 'getProgramme',
    });

    const raw = await connexityRequest<ConnexityMerchantMatchEnvelope>({
      operation: 'getProgramme',
      path: '/api/merchant-match',
      publisherId,
      apiKey,
      query: { keyword: 'shop' },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const matches = Array.isArray(raw?.merchantMatches) ? raw.merchantMatches : [];
    const found = matches.find((m) => String(m.merchantId ?? '') === programmeId);

    if (!found) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Connexity merchant found with id "${programmeId}" in the merchant match results.`,
          hint: 'Merchant Match is keyword-driven; the merchant may not appear under the default keyword. Use listProgrammes with a relevant search term.',
        }),
      );
    }

    return toProgramme(found);
  }

  // -------------------------------------------------------------------------
  // listTransactions — daily CPC earnings
  // -------------------------------------------------------------------------

  /**
   * List daily CPC earnings as synthetic transactions over a date window.
   *
   * Connexity's Get Earnings Report takes `startDate`/`endDate` as `YYYY-MM-DD`
   * and returns one row per day. There is no documented hard cap on the window,
   * but to stay friendly to the report engine and mirror the Awin pattern we
   * chunk windows wider than 90 days into 90-day slices.
   *
   * Filters honoured client-side (the report does not support them server-side):
   *   - `programmeId`: a daily CPC row is not attributable to one merchant, so a
   *     `programmeId` filter yields an empty list (documented; never silently
   *     wrong).
   *   - `status`: every row is 'approved'; a request for another status yields
   *     an empty list.
   *   - `minAgeDays` / `maxAgeDays`: applied after status filtering (PRD §15.9).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const publisherId = requireCredential('CONNEXITY_PUBLISHER_ID', {
      network: SLUG,
      operation: 'listTransactions',
    });
    const apiKey = requireCredential('CONNEXITY_API_KEY', {
      network: SLUG,
      operation: 'listTransactions',
    });

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 90);

    const allRows: ConnexityEarningsRow[] = [];
    for (const slice of slices) {
      const chunk = await connexityRequest<ConnexityEarningsEnvelope>({
        operation: 'listTransactions',
        path: '/api/reporting/earnings',
        publisherId,
        apiKey,
        query: { startDate: ymd(slice.start), endDate: ymd(slice.end) },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      if (Array.isArray(chunk?.earnings)) allRows.push(...chunk.earnings);
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      // Daily CPC rows are not attributable to a single merchant.
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = query?.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : undefined;
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
   * Aggregate the daily CPC earnings into a summary.
   *
   * Derived from `listTransactions` (cardinal pattern) so the user can recompute
   * the same totals from the rows they see. Connexity does expose a `totals`
   * block on the earnings report, but deriving from the per-day rows keeps a
   * single source of truth and lets us populate `oldestUnpaidAgeDays` from the
   * same data.
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
      currency: CURRENCY,
    };

    let totalEarnings = 0;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || '__all';
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || 'Connexity CPC earnings (all merchants)',
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
      currency: CURRENCY,
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
   * Connexity does not expose click-level data as structured records.
   *
   * The earnings report carries an aggregate `redirects` count per day, and the
   * Get Click Report endpoint returns a CSV download rather than per-click JSON
   * rows. Neither yields the `Click` shape this operation must return. We throw
   * `NotImplementedError` rather than returning an empty array — the difference
   * between "no clicks" and "no per-click API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Connexity does not expose click-level data as structured records via the publisher API; the click report is a CSV download only',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — Deep Link API
  // -------------------------------------------------------------------------

  /**
   * Produce a monetised Connexity deep link for a destination URL.
   *
   * Unlike Awin (deterministic URL construction), Connexity requires an API
   * round-trip: `GET /api/link/generate` on the deep-link host turns the
   * destination URL into a monetised redirect and returns `{ link, ecpc }`.
   *
   * The Deep Link API monetises BY URL, not by merchant id, so `programmeId` is
   * NOT required here. When supplied it is passed as `afCampaignId` so the
   * caller can group clicks for reporting. `destinationUrl` is required.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.destinationUrl || input.destinationUrl.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the merchant page you want to monetise.',
        }),
      );
    }

    const publisherId = requireCredential('CONNEXITY_PUBLISHER_ID', {
      network: SLUG,
      operation: 'generateTrackingLink',
    });
    const apiKey = requireCredential('CONNEXITY_API_KEY', {
      network: SLUG,
      operation: 'generateTrackingLink',
    });

    const raw = await connexityRequest<ConnexityLinkRaw>({
      operation: 'generateTrackingLink',
      path: '/api/link/generate',
      host: 'deeplink',
      publisherId,
      apiKey,
      query: {
        url: input.destinationUrl,
        // Optional grouping key for reporting; omitted when no programmeId given.
        afCampaignId: input.programmeId && input.programmeId.trim() !== '' ? input.programmeId : undefined,
      },
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const trackingUrl = raw?.link;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Connexity Deep Link API did not return a monetised link.',
          networkErrorBody: JSON.stringify(raw ?? {}),
        }),
      );
    }

    const result: TrackingLink = {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      createdAt: new Date().toISOString(),
      rawNetworkData: raw,
    };
    if (input.programmeId && input.programmeId.trim() !== '') {
      result.programmeId = input.programmeId;
    }
    return result;
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

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    // listClicks: known-unsupported. Record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Connexity exposes click data only as a CSV report, not as structured per-click records',
    };

    // getProgramme requires a known merchant id; generateTrackingLink makes a
    // live API call. Record without an automatic probe to keep the diagnostic
    // fast; the user can call them directly to confirm.
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known merchant id; not probed automatically.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deep Link API round-trip; not probed automatically.',
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
// Module-level registration (see Awin adapter for the aggregator rationale)
// ---------------------------------------------------------------------------

export const connexityAdapter = new ConnexityAdapter();
registerAdapter(connexityAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Connexity has no documented
 * hard cap, but chunking keeps each report request small and mirrors the Awin
 * pattern. Returns at least one slice; if `from >= to` we return one
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

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapMerchantStatus,
  mapEarningsStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  ymd,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
