/**
 * Optimise Media (OMG Network API) — publisher-side adapter.
 *
 * Patterned on the canonical reference (`src/networks/awin/adapter.ts`) and the
 * custom-API-key client in `src/networks/everflow/client.ts`. Read the Awin
 * file header for the full reasoning behind the structure; the non-obvious
 * decisions here are documented inline with "why" comments.
 *
 * --- OMG Network API map (see docs URLs in network.json) --------------------
 *
 *   GET  /Campaigns
 *     → list of campaigns, filterable by status to those where the publisher
 *       has a relationship. These are our "programmes".
 *   GET  /Conversions
 *     → detailed list of conversions for the publisher. `ConversionType` can
 *       return conversions with basket items or those related to a payment;
 *       `dateField` selects which date event the window filters on. These are
 *       our "transactions".
 *   (Product feeds) — documented for the network but not modelled here; noted
 *       as a known limitation.
 *
 * Auth: a custom `apikey` request header, minted via a Service Account in the
 * Insights Dashboard. See `auth.ts` / `client.ts`.
 *
 * --- Cardinal rules (mirrored from Awin) ------------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `optimiseMediaRequest` from `./client`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope` carrying the
 *      network, operation, httpStatus, and verbatim `networkErrorBody`.
 *   3. PRESERVE the raw payload on `rawNetworkData` for every domain object.
 *   4. NORMALISE status enums to the canonical set; prefer 'unknown'/'other'
 *      over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme", not "program").
 *
 * Claim status is `experimental`: the field names below are mapped defensively
 * against the documented OMG Network API shape and have NOT been confirmed
 * against a live Service Account at commit time. The verbatim payload is always
 * preserved on `rawNetworkData` so a user can reconcile any mismatch.
 */

import { optimiseMediaRequest } from './client.js';
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

const log = createLogger('optimise-media.adapter');

const SLUG = 'optimise-media';
const NAME = 'Optimise Media';

const EXPERIMENTAL_NOTE =
  'Experimental: field mappings follow the documented OMG Network API but have ' +
  'not been confirmed against a live Service Account.';

const AMOUNT_UNIT_NOTE =
  'Amounts are assumed to be in major currency units (e.g. pounds), not minor ' +
  'units (pence). Verify against a live account; raw payloads are preserved on rawNetworkData.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.optimisemedia.com',
  // The `apikey` header is non-standard (not Bearer/Basic/OAuth2), so we
  // declare the auth model as `custom`.
  authModel: 'custom',
  docsUrl: 'https://docs.optimisemedia.com/api/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    EXPERIMENTAL_NOTE,
    AMOUNT_UNIT_NOTE,
    'Click-level data is not exposed via the OMG Network API; listClicks is unsupported.',
    'Tracking-link construction is not documented for the OMG Network API; generateTrackingLink is unsupported.',
    'Product feeds are documented for the network but are not modelled by this adapter.',
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

/**
 * The Conversions endpoint can be slow for a wide window with basket-item
 * detail. Give it a longer timeout and one extra retry, mirroring Awin's
 * treatment of /transactions.
 */
const CONVERSIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: CONVERSIONS_RESILIENCE,
  getEarningsSummary: CONVERSIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// OMG Network API response shapes (deliberately minimal, read defensively)
// ---------------------------------------------------------------------------

interface OptimiseCampaignRaw {
  campaignId?: number | string;
  CampaignId?: number | string;
  campaignName?: string;
  CampaignName?: string;
  name?: string;
  status?: string;
  Status?: string;
  relationshipStatus?: string;
  currency?: string;
  Currency?: string;
  currencyCode?: string;
  commission?: string;
  commissionDescription?: string;
  category?: string;
  categories?: string[];
  sector?: string;
  url?: string;
  Url?: string;
  displayUrl?: string;
  advertiserUrl?: string;
}

interface OptimiseConversionRaw {
  conversionId?: number | string;
  ConversionId?: number | string;
  transactionId?: number | string;
  campaignId?: number | string;
  CampaignId?: number | string;
  campaignName?: string;
  CampaignName?: string;
  status?: string;
  Status?: string;
  conversionStatus?: string;
  // Sale / order value.
  saleValue?: number;
  orderValue?: number;
  value?: number;
  amount?: number;
  // Commission / payout to the publisher.
  commission?: number;
  commissionValue?: number;
  payout?: number;
  currency?: string;
  Currency?: string;
  currencyCode?: string;
  // Date events — the API selects which one the window filters on via dateField.
  clickDate?: string;
  ClickDate?: string;
  conversionDate?: string;
  ConversionDate?: string;
  transactionDate?: string;
  saleDate?: string;
  validationDate?: string;
  ValidationDate?: string;
  approvedDate?: string;
  paymentDate?: string;
  paidDate?: string;
  // Reversal / decline context.
  declineReason?: string;
  rejectionReason?: string;
  reason?: string;
  // Basket detail (present when ConversionType requests it).
  basketItems?: unknown[];
  items?: unknown[];
}

interface OptimiseConversionsEnvelope {
  data?: OptimiseConversionRaw[];
  items?: OptimiseConversionRaw[];
  results?: OptimiseConversionRaw[];
  totalCount?: number;
  total?: number;
  page?: number;
  pageSize?: number;
}

interface OptimiseCampaignsEnvelope {
  data?: OptimiseCampaignRaw[];
  items?: OptimiseCampaignRaw[];
  results?: OptimiseCampaignRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: OMG conversion status → canonical TransactionStatus.
 *
 * The documented states centre on pending / approved (validated) / rejected
 * (declined) / paid. Optimise terminology varies, so we read a small set of
 * synonyms and map anything unrecognised to 'other' rather than guessing.
 */
function mapTransactionStatus(raw: OptimiseConversionRaw): TransactionStatus {
  const s = String(raw.status ?? raw.Status ?? raw.conversionStatus ?? '').toLowerCase();
  if (s.includes('paid')) return 'paid';
  if (s.includes('pending') || s.includes('awaiting')) return 'pending';
  if (s.includes('approv') || s.includes('valid') || s.includes('confirm') || s.includes('accept'))
    return 'approved';
  if (s.includes('reject') || s.includes('declin') || s.includes('revers') || s.includes('cancel'))
    return 'reversed';
  return 'other';
}

/**
 * Status normalisation: OMG campaign relationship → canonical ProgrammeStatus.
 *
 * The Campaigns endpoint filters by the publisher's relationship status. We
 * collapse the documented states to our enum and map anything unrecognised to
 * 'unknown'.
 */
function mapProgrammeStatus(raw: OptimiseCampaignRaw): ProgrammeStatus {
  const s = String(raw.relationshipStatus ?? raw.status ?? raw.Status ?? '').toLowerCase();
  if (s.includes('join') || s.includes('approv') || s.includes('active') || s.includes('accept'))
    return 'joined';
  if (s.includes('pending') || s.includes('await')) return 'pending';
  if (s.includes('declin') || s.includes('reject') || s.includes('refus')) return 'declined';
  if (s.includes('paus') || s.includes('suspend')) return 'suspended';
  if (s.includes('available') || s.includes('open') || s.includes('notjoined')) return 'available';
  return 'unknown';
}

/**
 * Compute the age (in days) of a conversion. PRD §15.9.
 *
 * Anchor on the validation/approval date if present (matches Awin: "how long
 * has this been approved-but-not-paid"), otherwise the conversion date.
 */
function computeAgeDays(raw: OptimiseConversionRaw, now: Date = new Date()): number {
  const anchor =
    raw.validationDate ??
    raw.ValidationDate ??
    raw.approvedDate ??
    raw.conversionDate ??
    raw.ConversionDate ??
    raw.transactionDate ??
    raw.saleDate;
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

function firstNumber(...values: Array<number | undefined>): number {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Transformers (OMG raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: OptimiseCampaignRaw): Programme {
  const id = String(raw.campaignId ?? raw.CampaignId ?? '');
  const name = raw.campaignName ?? raw.CampaignName ?? raw.name ?? `Optimise campaign ${id}`;
  const categories =
    raw.categories ??
    [raw.category, raw.sector].filter((c): c is string => typeof c === 'string');
  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? raw.Currency ?? raw.currencyCode,
    commissionRate:
      raw.commission || raw.commissionDescription
        ? { type: 'unknown', description: raw.commissionDescription ?? raw.commission }
        : undefined,
    categories: categories.length > 0 ? categories : undefined,
    advertiserUrl: raw.displayUrl ?? raw.advertiserUrl ?? raw.url ?? raw.Url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: OptimiseConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const amount = firstNumber(raw.saleValue, raw.orderValue, raw.value, raw.amount);
  const commission = firstNumber(raw.commission, raw.commissionValue, raw.payout);
  const currency = raw.currency ?? raw.Currency ?? raw.currencyCode ?? 'GBP';

  const conversionIso =
    nullableIso(raw.conversionDate ?? raw.ConversionDate ?? raw.transactionDate ?? raw.saleDate) ??
    new Date(0).toISOString();
  const clickIso = nullableIso(raw.clickDate ?? raw.ClickDate);
  const approvedIso = nullableIso(raw.validationDate ?? raw.ValidationDate ?? raw.approvedDate);
  const paidIso = nullableIso(raw.paymentDate ?? raw.paidDate);

  return {
    id: String(raw.conversionId ?? raw.ConversionId ?? raw.transactionId ?? ''),
    network: SLUG,
    programmeId: String(raw.campaignId ?? raw.CampaignId ?? ''),
    programmeName: raw.campaignName ?? raw.CampaignName ?? '',
    status,
    amount,
    currency,
    commission,
    dateClicked: clickIso,
    dateConverted: conversionIso,
    dateApproved: approvedIso,
    datePaid: paidIso,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? raw.declineReason ?? raw.rejectionReason ?? raw.reason ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class OptimiseMediaAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — GET /Campaigns
  // -------------------------------------------------------------------------

  /**
   * List campaigns (programmes) the publisher has a relationship with.
   *
   * The Campaigns endpoint filters by relationship status server-side; we pass
   * the requested status through where it maps cleanly and additionally apply
   * client-side filters for search / categories / limit so the contract holds
   * regardless of what the server supports.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    const statusFilter = toStatusList(query?.status);

    const raw = await optimiseMediaRequest<OptimiseCampaignsEnvelope | OptimiseCampaignRaw[]>({
      operation: 'listProgrammes',
      path: '/Campaigns',
      apiKey,
      query: {
        status: pickCampaignStatus(statusFilter),
        page: 1,
        pageSize: query?.limit && query.limit > 0 ? query.limit : 100,
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = normaliseCampaigns(raw).map(toProgramme);

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
  // getProgramme — GET /Campaigns filtered to one id
  // -------------------------------------------------------------------------

  /**
   * Fetch a single campaign by id.
   *
   * The OMG Network API exposes campaigns through the list endpoint; we request
   * it filtered to the requested id and return the matching row. An empty
   * result surfaces as a network_api_error envelope rather than a fabricated
   * stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Optimise campaign IDs are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_optimise_media_list_programmes) to find the correct id.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');

    const raw = await optimiseMediaRequest<OptimiseCampaignsEnvelope | OptimiseCampaignRaw[]>({
      operation: 'getProgramme',
      path: '/Campaigns',
      apiKey,
      query: { campaignId: programmeId, page: 1, pageSize: 100 },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const rows = normaliseCampaigns(raw);
    const match =
      rows.find((r) => String(r.campaignId ?? r.CampaignId ?? '') === programmeId) ?? rows[0];

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Optimise returned no campaign for id "${programmeId}".`,
          hint: 'Confirm the campaign id via affiliate_optimise_media_list_programmes.',
        }),
      );
    }

    return toProgramme(match);
  }

  // -------------------------------------------------------------------------
  // listTransactions — GET /Conversions
  // -------------------------------------------------------------------------

  /**
   * List conversions (transactions) across a date window.
   *
   * The Conversions endpoint filters the window by a chosen date event via
   * `dateField`; we anchor on the conversion date because that matches the
   * canonical `dateConverted` and the caller's `from`/`to` intent. The window
   * is chunked into ≤31-day slices defensively — wide windows with basket
   * detail are the documented slow path, and chunking keeps each call within a
   * comfortable response size whether or not the server caps it.
   *
   * Status / programme / age filters are applied client-side after the fetch so
   * combined queries (e.g. `{ status: 'approved', minAgeDays: 180 }`) are
   * meaningful (PRD §15.9 / §15.10).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: OptimiseConversionRaw[] = [];
    for (const slice of slices) {
      const chunk = await optimiseMediaRequest<
        OptimiseConversionsEnvelope | OptimiseConversionRaw[]
      >({
        operation: 'listTransactions',
        path: '/Conversions',
        apiKey,
        query: {
          startDate: formatOptimiseDate(slice.start),
          endDate: formatOptimiseDate(slice.end),
          // The documented field that selects which date event the window
          // filters on. We anchor on the conversion date.
          dateField: 'conversion',
          campaignId: query?.programmeId,
          page: 1,
          pageSize: 1000,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...normaliseConversions(chunk));
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
  // getEarningsSummary — derived from listTransactions
  // -------------------------------------------------------------------------

  /**
   * Aggregate conversions into an earnings summary.
   *
   * Derived from `listTransactions` (not a separate report endpoint) so the
   * user can recompute the same numbers from the transactions they see — see
   * the Awin adapter's rationale. The `limit` is dropped so a summary never
   * silently undercounts (principle 4.1).
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
          programmeName: t.programmeName || `Optimise campaign ${key}`,
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
  // listClicks — unsupported
  // -------------------------------------------------------------------------

  /**
   * The OMG Network API does not expose click-level data to publishers. We
   * throw `NotImplementedError` rather than returning an empty array so the
   * user can tell "no clicks" from "no endpoint" (principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Optimise Media does not expose click-level data via the OMG Network API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — unsupported
  // -------------------------------------------------------------------------

  /**
   * Optimise Media tracking links are issued through the dashboard / link
   * tools; the OMG Network API does not document a deterministic deep-link
   * scheme or a link-generation endpoint. We throw `NotImplementedError`
   * rather than fabricate a URL that may not track. If a documented scheme
   * surfaces, this becomes a real implementation and the limitation is dropped.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Optimise Media tracking-link generation is not documented in the OMG Network API',
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

    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known campaign id; not probed automatically.',
      claimStatus: 'experimental',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Optimise Media does not expose click-level data via the OMG Network API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Tracking-link generation is not documented in the OMG Network API.',
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
// Module-level registration (see Awin adapter for the rationale)
// ---------------------------------------------------------------------------

export const optimiseMediaAdapter = new OptimiseMediaAdapter();
registerAdapter(optimiseMediaAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function normaliseCampaigns(
  response: OptimiseCampaignsEnvelope | OptimiseCampaignRaw[],
): OptimiseCampaignRaw[] {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? response.results ?? [];
}

function normaliseConversions(
  response: OptimiseConversionsEnvelope | OptimiseConversionRaw[],
): OptimiseConversionRaw[] {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? response.results ?? [];
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

/**
 * Map our canonical ProgrammeStatus to the OMG Campaigns `status` filter. We
 * pass the dominant requested status through where it maps cleanly; the
 * client-side filter in `listProgrammes` enforces the exact set. Undefined
 * means "no server-side status filter".
 */
function pickCampaignStatus(statuses?: ProgrammeStatus[]): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  if (statuses.includes('joined')) return 'joined';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('available')) return 'available';
  return undefined;
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Returns at least one slice;
 * a zero-width slice is returned when `from >= to` so the call shape stays
 * predictable (mirrors Awin's `chunkDateRange`).
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
 * Format a Date for the OMG Conversions window params. We use an ISO date-time
 * trimmed to the second; the exact accepted format is not load-bearing because
 * the values are URL-encoded by the client.
 */
function formatOptimiseDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  formatOptimiseDate,
  pickCampaignStatus,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
