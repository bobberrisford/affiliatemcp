/**
 * Impact advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the publisher Impact adapter's defensive style:
 * Impact is NOT a pattern source — most of its quirks (dual pagination, nullable
 * bodies, mixed date formats) apply on the brand surface too. Use the Awin
 * adapter as the canonical template for new networks.
 *
 * The brand surface has TWO credential tiers (see ./auth.ts):
 *   - agency-passthrough:  /Agencies/{AgencySID}/Advertisers/{BrandSID}/...
 *   - brand-direct:        /Advertisers/{BrandSID}/...
 *
 * The adapter receives a `ctx?: AdapterCallContext` from the tool dispatcher
 * carrying `networkBrandId` (the BrandSID for whichever logical brand the
 * caller asked about). Operations REQUIRE the context — without it we cannot
 * address a brand. We throw a `config_error` envelope rather than guessing.
 *
 * The Impact docs site returned 403 to automated WebFetch during this PR's
 * research, so several endpoint signatures are marked `// TODO(verify):` and
 * should be confirmed against a live agency tenant in a follow-up PR.
 *
 * Operations:
 *   listBrands             → GET /Agencies/{AgencySID}/Advertisers  (agency)
 *                            or single synthetic entry from /Advertisers/{SID}/Company (brand-direct)
 *   verifyAuth             → reuses the shape-detection probe in auth.ts
 *   listProgrammes         → GET /Advertisers/{BrandSID}/Campaigns
 *   listTransactions       → GET /Advertisers/{BrandSID}/Actions
 *   listMediaPartners      → GET /Advertisers/{BrandSID}/MediaPartners
 *   getProgrammePerformance→ GET /Advertisers/{BrandSID}/Reports/adv_performance_by_media
 *   listContracts          → GET /Advertisers/{BrandSID}/Campaigns/{CampaignId}/Contracts
 *   getContract            → GET /Advertisers/{BrandSID}/Campaigns/{CampaignId}/Contracts/{ContractId}
 *
 * Pagination: listProgrammes, listTransactions, listMediaPartners, and
 * getProgrammePerformance paginate to completion when `query.limit` is absent,
 * honouring Impact's dual `@nextpageuri` / `@page`+`@numpages` signals (same
 * concession as the publisher adapter). A `MAX_PAGES` backstop stops runaway
 * loops and logs a stderr warning so truncation is never silent. When `limit`
 * IS present, the loop stops as soon as enough raw rows are collected.
 *
 * Contract operations are READ-ONLY here. The write surface (proposeContract,
 * applyContract, removeContract) lands in follow-up PRs behind a consent gate;
 * see docs/decisions/2026-06-12-impact-contracts-actions.md. The exact contract
 * endpoint paths and payload shapes carry `// TODO(verify):` until confirmed
 * against a live agency tenant.
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `impactAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings.
 *   5. NEVER issue a non-GET request. The client enforces this; the adapter
 *      must not work around it.
 */

import { createHash } from 'node:crypto';
import { impactAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type ActionDescriptor,
  type AdapterCallContext,
  type AnyOperation,
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('impact-advertiser.adapter');
const NAME = 'Impact (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.impact.com',
  authModel: 'basic',
  docsUrl: 'https://integrations.impact.com/impact-brand/',
  adapterVersion: '0.1.1',
  lastVerified: '2026-05-23',
  claimStatus: 'experimental',
  knownLimitations: [
    'Read-only at v0.1. The HTTP client refuses non-GET methods.',
    'Two credential tiers auto-detected at runtime: agency-passthrough and brand-direct.',
    'getProgrammePerformance uses Impact pre-built `adv_performance_by_media` report; sync vs async behaviour `// TODO(verify)` until a live agency tenant is available.',
    'listProgrammes, listTransactions, listMediaPartners, and getProgrammePerformance paginate to completion on absent `limit` via `@nextpageuri` / `@page`, capped at MAX_PAGES with a stderr warning rather than a silent truncation.',
    'listContracts/getContract read the brand-partner payment-term relationship; endpoint paths under `/Campaigns/{id}/Contracts` carry `// TODO(verify)` until confirmed against a live agency tenant. proposeContract builds a reviewable change plan from those reads (advisement only, no network write); the contract write surface (apply/remove) is not enabled here.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 8,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // getProgrammePerformance hits Impact's report engine — give it more time
  // and an extra retry, same rationale as the publisher adapter's /Actions
  // profile.
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 4,
  },
};

/**
 * Default upstream page size when the caller supplies no `limit`, and the
 * hard backstop on how many pages one operation may pull. The cap exists so a
 * tenant returning a self-referential `@nextpageuri` (observed historically on
 * the publisher surface) cannot loop indefinitely; hitting it logs a stderr
 * warning so a truncated pull is never silent (principle 4.1). Same pattern as
 * the tolt adapter's MAX_PAGES.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Helpers — ctx, status mapping, raw shapes
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on advertiser-side operations. We throw a
 * `config_error` envelope so the user sees a clear "this op needs `brand`"
 * rather than a runtime TypeError when ctx is missing — this can happen if
 * a future caller bypasses the tool dispatcher.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Impact advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId via brands.json. Call `affiliate_resolve_brand` to see which brands are bound.',
      }),
    );
  }
  return ctx;
}

/**
 * Require a programme/campaign id on contract operations. Impact addresses
 * contracts under a campaign, so without it we cannot build the path. We throw
 * a `config_error` envelope so the user sees a clear "this op needs
 * `programmeId`" rather than hitting a malformed URL.
 */
function requireProgrammeId(operation: string, programmeId?: string): string {
  if (!programmeId || programmeId.trim() === '') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `Impact advertiser ${operation} requires a programmeId (the CampaignId whose contracts to address).`,
        hint: 'Call listProgrammes for the brand first to discover campaign ids, then pass programmeId.',
      }),
    );
  }
  return programmeId;
}

/**
 * Impact's dual pagination signals on the brand-side list envelopes. Some
 * tenants return `@nextpageuri`, others `@page`/`@numpages`; both are honoured
 * (same concession as the publisher adapter's IMPACT-WORKAROUND).
 */
interface ImpactAdvPagedEnvelope {
  '@page'?: string | number;
  '@nextpageuri'?: string;
  '@numpages'?: string | number;
}

interface ImpactAdvAdvertiserRaw {
  Id?: string | number;
  CompanyName?: string;
  Name?: string;
  AccountStatus?: string;
  ApiEnabled?: boolean | string;
}

interface ImpactAdvCampaignRaw {
  CampaignId?: string | number;
  CampaignName?: string;
  CampaignStatus?: string;
  ContractStatus?: string;
  CampaignCurrency?: string;
  CampaignUrl?: string;
}

interface ImpactAdvActionRaw {
  Id?: string | number;
  CampaignId?: string | number;
  CampaignName?: string;
  State?: string;
  EventDate?: string;
  CreationDate?: string;
  LockingDate?: string;
  ClearedDate?: string;
  ReferringDate?: string;
  IntendedAmount?: string | number;
  Amount?: string | number;
  Payout?: string | number;
  Currency?: string;
  ReversalReason?: string;
  MediaPartnerId?: string | number;
  MediaPartnerName?: string;
}

interface ImpactAdvMediaPartnerRaw {
  Id?: string | number;
  MediaPartnerId?: string | number;
  Name?: string;
  MediaPartnerName?: string;
  AccountStatus?: string;
  Status?: string;
}

interface ImpactAdvReportRow {
  Date?: string;
  Day?: string;
  Month?: string;
  MediaPartnerId?: string | number;
  MediaPartner?: string;
  MediaPartnerName?: string;
  Clicks?: string | number;
  Actions?: string | number;
  Conversions?: string | number;
  SaleAmount?: string | number;
  GrossSale?: string | number;
  Earnings?: string | number;
  Payout?: string | number;
  Currency?: string;
  State?: string;
}

interface ImpactAdvReportEnvelope extends ImpactAdvPagedEnvelope {
  Records?: ImpactAdvReportRow[];
  Rows?: ImpactAdvReportRow[];
  Data?: ImpactAdvReportRow[];
  ResultUri?: string;
  Status?: string;
}

// TODO(verify): exact contract payload shape against a live agency tenant.
// The Impact docs site returned 403 to automated fetches during research, so
// the transformer reads several field aliases defensively.
interface ImpactAdvContractRaw {
  Id?: string | number;
  ContractId?: string | number;
  CampaignId?: string | number;
  CampaignName?: string;
  Name?: string;
  ContractName?: string;
  Status?: string;
  ContractStatus?: string;
  MediaPartnerId?: string | number;
  MediaPartnerName?: string;
  PayoutDescription?: string;
  Terms?: string;
  StartDate?: string;
  EffectiveDate?: string;
  EndDate?: string;
  ExpirationDate?: string;
}

interface ImpactAdvContractEnvelope {
  Contracts?: ImpactAdvContractRaw[];
  Contract?: ImpactAdvContractRaw;
}

export type ImpactContractStatus = 'active' | 'pending' | 'expired' | 'inactive' | 'unknown';

/** Impact-local read shape until a second network proves shared semantics. */
export interface ImpactContract {
  id: string;
  network: typeof SLUG;
  programmeId: string;
  programmeName?: string;
  mediaPartnerId?: string;
  mediaPartnerName?: string;
  status: ImpactContractStatus;
  payoutTerms?: string;
  effectiveDate?: string;
  expiryDate?: string;
  rawNetworkData: unknown;
}

export interface ImpactContractQuery {
  programmeId: string;
  status?: ImpactContractStatus | ImpactContractStatus[];
  mediaPartnerId?: string;
  limit?: number;
  /** Impact's one-based `Page` value, kept opaque at the MCP boundary. */
  cursor?: string;
}

/**
 * The intended contract change, fed to `proposeContract`. Adapter-local (like
 * `ImpactContract`) until a second network proves shared semantics.
 *
 * `apply` with a `contractId` modifies that contract; `apply` without one
 * proposes a new contract; `remove` requires a `contractId`. The `apply`
 * payload fields (`payoutTerms`, `mediaPartnerId`) are the parts a change can
 * touch today; the exact upstream payload shape (template id vs inline rate)
 * is `// TODO(verify)` against a live agency tenant.
 */
export interface ContractChangeIntent {
  action: 'apply' | 'remove';
  /** Logical brand slug the caller supplied; echoed into the plan for display. */
  brand: string;
  /** CampaignId whose contracts are addressed. */
  programmeId: string;
  /** Required for `remove`; present on `apply` = modify, absent = create. */
  contractId?: string;
  /** apply payload — TODO(verify) exact shape. */
  payoutTerms?: string;
  mediaPartnerId?: string;
}

/**
 * The reviewable plan `proposeContract` returns. Shape per the accepted Impact
 * contracts decision (docs/decisions/2026-06-12-impact-contracts-actions.md):
 * action, brand, programme, summary, before/after snapshots, warnings, and a
 * `confirmationToken` that pins a later (gated, not-yet-built) apply to exactly
 * these reviewed parameters. `experimental` is always true while the write
 * payload shape is unverified.
 *
 * proposeContract performs NO network write: it reads current state via the
 * read half and computes this plan locally. The token is an advisement
 * boundary, not a security boundary.
 */
export interface ContractChangePlan {
  action: 'apply' | 'remove';
  network: typeof SLUG;
  /** Logical brand slug (echoed from the intent), never the network's brand id. */
  brand: string;
  programmeId: string;
  summary: string;
  /** Current contract state, when the change targets an existing contract. */
  before?: ImpactContract;
  /** Current contracts observed for this target, preserved with raw payloads. */
  observedContracts: ImpactContract[];
  /** Intended end state. `undefined` for a removal (nothing remains). */
  after?: Partial<ImpactContract>;
  warnings: string[];
  /** No executable validity window exists until the separately reviewed write half ships. */
  expiresAt: null;
  confirmationToken: string;
  experimental: true;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapCampaignStatus(raw: ImpactAdvCampaignRaw): ProgrammeStatus {
  const s = String(raw.CampaignStatus ?? raw.ContractStatus ?? '').toLowerCase();
  if (s === 'active' || s === 'live') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  if (s === 'declined' || s === 'rejected') return 'declined';
  return 'unknown';
}

function mapActionStatus(raw: ImpactAdvActionRaw): TransactionStatus {
  const s = String(raw.State ?? '').toUpperCase();
  switch (s) {
    case 'PENDING':
      return 'pending';
    case 'APPROVED':
    case 'LOCKED':
      return 'approved';
    case 'REVERSED':
      return 'reversed';
    case 'PAID':
      return 'paid';
    default:
      return 'other';
  }
}

function mapMediaPartnerStatus(raw: ImpactAdvMediaPartnerRaw): MediaPartner['status'] {
  const s = String(raw.AccountStatus ?? raw.Status ?? '').toLowerCase();
  if (s === 'active' || s === 'approved' || s === 'live') return 'active';
  if (s === 'pending' || s === 'pendingreview' || s === 'inreview') return 'pending';
  if (s === 'inactive' || s === 'paused' || s === 'declined' || s === 'rejected')
    return 'inactive';
  return 'unknown';
}

function mapContractStatus(raw: ImpactAdvContractRaw): ImpactContractStatus {
  const s = String(raw.Status ?? raw.ContractStatus ?? '').toLowerCase();
  if (s === 'active' || s === 'live' || s === 'approved') return 'active';
  if (s === 'pending' || s === 'proposed' || s === 'inreview') return 'pending';
  if (s === 'expired' || s === 'ended') return 'expired';
  if (s === 'inactive' || s === 'paused' || s === 'terminated' || s === 'removed')
    return 'inactive';
  return 'unknown';
}

function mapReportRowStatus(raw: ImpactAdvReportRow): ProgrammePerformanceRow['status'] {
  const s = String(raw.State ?? '').toUpperCase();
  if (s === 'APPROVED' || s === 'LOCKED' || s === 'PAID') return 'approved';
  if (s === 'REVERSED') return 'reversed';
  return 'pending';
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseImpactDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  let candidate = input.trim();
  if (candidate === '') return undefined;
  if (!/[Zz]$/.test(candidate) && !/[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

function computeAgeDays(raw: ImpactAdvActionRaw, now: Date = new Date()): number {
  const anchor = raw.LockingDate ?? raw.EventDate ?? raw.CreationDate;
  const parsed = parseImpactDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  const ms = now.getTime() - ts;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ImpactAdvCampaignRaw): Programme {
  const id = String(raw.CampaignId ?? '');
  return {
    id,
    name: raw.CampaignName ?? `Impact campaign ${id}`,
    network: SLUG,
    status: mapCampaignStatus(raw),
    currency: raw.CampaignCurrency,
    advertiserUrl: raw.CampaignUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ImpactAdvActionRaw, now: Date = new Date()): Transaction {
  const status = mapActionStatus(raw);
  const commission = toNumber(raw.Payout);
  const sale = toNumber(raw.IntendedAmount ?? raw.Amount);
  const currency = raw.Currency ?? 'USD';

  const eventDate = parseImpactDate(raw.EventDate) ?? new Date(0).toISOString();
  const clickDate = parseImpactDate(raw.ReferringDate);
  const approvedDate = parseImpactDate(raw.LockingDate);
  const paidDate = parseImpactDate(raw.ClearedDate);

  return {
    id: String(raw.Id ?? ''),
    network: SLUG,
    programmeId: String(raw.CampaignId ?? ''),
    programmeName: raw.CampaignName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: eventDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.ReversalReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toMediaPartner(raw: ImpactAdvMediaPartnerRaw): MediaPartner {
  return {
    id: String(raw.Id ?? raw.MediaPartnerId ?? ''),
    name: raw.Name ?? raw.MediaPartnerName ?? `Impact media partner ${String(raw.Id ?? raw.MediaPartnerId ?? '')}`,
    status: mapMediaPartnerStatus(raw),
    rawNetworkData: raw,
  };
}

function toPerformanceRow(raw: ImpactAdvReportRow): ProgrammePerformanceRow {
  // Normalise the date down to yyyy-mm-dd (or yyyy-mm).
  const rawDate = raw.Date ?? raw.Day ?? raw.Month ?? '';
  let date = '';
  if (rawDate) {
    const parsed = parseImpactDate(rawDate);
    if (parsed) {
      // Yyyy-mm-dd from the iso prefix.
      date = parsed.slice(0, 10);
    } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(rawDate)) {
      date = rawDate;
    }
  }

  const clicks = toNumber(raw.Clicks);
  const conversions = toNumber(raw.Actions ?? raw.Conversions);
  const grossSale = toNumber(raw.SaleAmount ?? raw.GrossSale);
  const commission = toNumber(raw.Payout ?? raw.Earnings);
  return {
    date,
    publisherId: String(raw.MediaPartnerId ?? ''),
    publisherName: raw.MediaPartner ?? raw.MediaPartnerName ?? '',
    clicks,
    conversions,
    grossSale,
    commission,
    currency: raw.Currency ?? 'USD',
    status: mapReportRowStatus(raw),
    rawNetworkData: raw,
  };
}

function toContract(
  raw: ImpactAdvContractRaw,
  programmeIdFallback?: string,
  contractIdFallback?: string,
  operation = 'getContract',
): ImpactContract {
  const id = String(raw.Id ?? raw.ContractId ?? contractIdFallback ?? '');
  const programmeId = String(raw.CampaignId ?? programmeIdFallback ?? '');
  if (!id || !programmeId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation,
        networkErrorBody: JSON.stringify(raw),
        message: 'Impact returned a contract without the identifiers required by the read contract.',
        hint: 'Retry once; if the response is unchanged, keep the operation experimental and report the scrubbed payload shape.',
      }),
    );
  }
  const mediaPartnerId =
    raw.MediaPartnerId !== undefined && raw.MediaPartnerId !== null
      ? String(raw.MediaPartnerId)
      : undefined;
  return {
    id,
    network: SLUG,
    programmeId,
    programmeName: raw.CampaignName ?? raw.ContractName ?? raw.Name,
    mediaPartnerId,
    mediaPartnerName: raw.MediaPartnerName,
    status: mapContractStatus(raw),
    payoutTerms: raw.PayoutDescription ?? raw.Terms,
    effectiveDate: parseImpactDate(raw.EffectiveDate ?? raw.StartDate),
    expiryDate: parseImpactDate(raw.ExpirationDate ?? raw.EndDate),
    rawNetworkData: raw,
  };
}

function toDiscoveredBrand(raw: ImpactAdvAdvertiserRaw): DiscoveredBrand {
  const id = String(raw.Id ?? '');
  const apiEnabledRaw = raw.ApiEnabled;
  const apiEnabled =
    apiEnabledRaw === undefined
      ? true
      : typeof apiEnabledRaw === 'boolean'
        ? apiEnabledRaw
        : String(apiEnabledRaw).toLowerCase() !== 'false';
  return {
    networkBrandId: id,
    displayName: raw.CompanyName ?? raw.Name ?? `Impact advertiser ${id}`,
    apiEnabled,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ImpactAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Agency tier: enumerate brands via GET /Agencies/{AgencySID}/Advertisers.
   * Brand-direct tier: return one synthetic entry sourced from
   * /Advertisers/{SID}/Company (or a fallback if Company isn't accessible).
   *
   * TODO(verify): the exact response shape for /Agencies/{SID}/Advertisers
   * and /Advertisers/{SID}/Company against a live tenant. Docs site returned
   * 403 to WebFetch during this PR. The transformer reads multiple field
   * aliases defensively.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const { getDetectedCredentials } = await import('./auth.js');
    const creds = await getDetectedCredentials('listBrands');

    if (creds.shape === 'agency') {
      const envelope = await impactAdvRequest<
        | { Advertisers?: ImpactAdvAdvertiserRaw[] }
        | ImpactAdvAdvertiserRaw[]
      >({
        operation: 'verifyAuth',
        agencyPath: '/Advertisers',
        resilience: RESILIENCE.default,
      });
      const list: ImpactAdvAdvertiserRaw[] = Array.isArray(envelope)
        ? envelope
        : envelope?.Advertisers ?? [];
      return list.map(toDiscoveredBrand);
    }

    // Brand-direct: synthesise one entry. The brand SID IS the account SID.
    // TODO(verify): the /Advertisers/{SID}/Company endpoint name; some tenants
    // surface this as /Advertisers/{SID} directly.
    let displayName = `Impact advertiser ${creds.accountSid}`;
    try {
      const company = await impactAdvRequest<
        ImpactAdvAdvertiserRaw | { Company?: ImpactAdvAdvertiserRaw }
      >({
        operation: 'verifyAuth',
        brandPath: '/Company',
        networkBrandId: creds.accountSid,
        resilience: RESILIENCE.default,
      });
      const flat = (company as { Company?: ImpactAdvAdvertiserRaw }).Company ?? (company as ImpactAdvAdvertiserRaw);
      if (flat && (flat.CompanyName || flat.Name)) {
        displayName = flat.CompanyName ?? flat.Name ?? displayName;
      }
    } catch (err) {
      // Identity lookup is best-effort under brand-direct; fall back to a
      // synthesised label rather than failing the whole discovery flow.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'brand-direct identity lookup failed; falling back to synthetic label',
      );
    }

    return [
      {
        networkBrandId: creds.accountSid,
        displayName,
        apiEnabled: true,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // verifyAuth — reuse the shape detection probe.
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) {
      const id = r.identity ? `impact-advertiser/${r.identity.shape}/${r.identity.accountSid}` : undefined;
      return id ? { ok: true, identity: id } : { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — brand's campaigns.
  // -------------------------------------------------------------------------

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    const c = requireCtx('listProgrammes', ctx);
    const list = await collectAdvPages<ImpactAdvCampaignRaw>({
      operation: 'listProgrammes',
      brandPath: '/Campaigns',
      networkBrandId: c.networkBrandId,
      pageSize: query?.limit ?? PAGE_SIZE,
      target: query?.limit,
      extract: (envelope) =>
        Array.isArray(envelope)
          ? (envelope as ImpactAdvCampaignRaw[])
          : ((envelope as { Campaigns?: ImpactAdvCampaignRaw[] })?.Campaigns ?? []),
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });
    let programmes = list.map(toProgramme);
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — brand's actions.
  // -------------------------------------------------------------------------

  async listTransactions(
    query?: TransactionQuery,
    ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);

    // Build a State filter from the canonical status (best-effort — Impact's
    // brand /Actions endpoint accepts State=PENDING|APPROVED|REVERSED|PAID).
    const statusFilter = toTransactionStatusList(query?.status);
    const stateParam =
      statusFilter && statusFilter.length === 1 && statusFilter[0]
        ? canonicalToImpactState(statusFilter[0])
        : undefined;

    const list = await collectAdvPages<ImpactAdvActionRaw>({
      operation: 'listTransactions',
      brandPath: '/Actions',
      networkBrandId: c.networkBrandId,
      baseQuery: {
        ActionDateStart: query?.from,
        ActionDateEnd: query?.to,
        State: stateParam,
      },
      pageSize: query?.limit ?? PAGE_SIZE,
      target: query?.limit,
      extract: (envelope) =>
        Array.isArray(envelope)
          ? (envelope as ImpactAdvActionRaw[])
          : ((envelope as { Actions?: ImpactAdvActionRaw[] })?.Actions ?? []),
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });
    let txns = list.map((r) => toTransaction(r));
    if (query?.programmeId) txns = txns.filter((t) => t.programmeId === query.programmeId);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      txns = txns.filter((t) => set.has(t.status));
    }
    if (typeof query?.limit === 'number') txns = txns.slice(0, query.limit);
    return txns;
  }

  // -------------------------------------------------------------------------
  // listMediaPartners — publishers on the brand's programme.
  // -------------------------------------------------------------------------

  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const c = requireCtx('listMediaPartners', ctx);
    const list = await collectAdvPages<ImpactAdvMediaPartnerRaw>({
      operation: 'listMediaPartners',
      brandPath: '/MediaPartners',
      networkBrandId: c.networkBrandId,
      pageSize: query?.limit ?? PAGE_SIZE,
      target: query?.limit,
      extract: (envelope) =>
        Array.isArray(envelope)
          ? (envelope as ImpactAdvMediaPartnerRaw[])
          : ((envelope as { MediaPartners?: ImpactAdvMediaPartnerRaw[] })?.MediaPartners ?? []),
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });
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
  // getProgrammePerformance — per-publisher rollup.
  // -------------------------------------------------------------------------

  /**
   * Uses Impact's pre-built `adv_performance_by_media` report template.
   *
   * TODO(verify): some tenants serve this endpoint synchronously (returns the
   * rows directly), others async (returns `{ ResultUri }` and the caller polls
   * `/ReportExport/{id}` for completion). The implementation below handles
   * both shapes: if the first response carries rows we use them; otherwise we
   * follow `ResultUri` with up to 60s of polling and a per-request retry.
   * Verify exact endpoint name + ResultUri shape against a live tenant.
   *
   * Pagination: once a rows-bearing envelope arrives (sync or polled), the
   * continuation follows `@nextpageuri` / `@page` like the other list ops,
   * pulling to completion on absent `limit` and stopping early once `limit`
   * raw rows are collected, capped at MAX_PAGES with a stderr warning.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const resilience = RESILIENCE.getProgrammePerformance ?? RESILIENCE.default;
    const pageSize = query?.limit ?? 1000;
    const reportPath = '/Reports/adv_performance_by_media';
    const baseQuery: Record<string, string | number | undefined> = {
      START_DATE: query?.from,
      END_DATE: query?.to,
      MEDIA_PARTNER_ID: query?.publisherId,
      CAMPAIGN_ID: query?.programmeId,
    };

    const first = await impactAdvRequest<ImpactAdvReportEnvelope | ImpactAdvReportRow[]>({
      operation: 'getProgrammePerformance',
      brandPath: reportPath,
      networkBrandId: c.networkBrandId,
      query: { ...baseQuery, Page: 1, PageSize: pageSize },
      resilience,
    });

    let envelope: ImpactAdvReportEnvelope | ImpactAdvReportRow[] = first;
    // The `@page` fallback re-requests basePath: the sync path re-sends the
    // report parameters; the polled path re-requests the ResultUri bare.
    let basePath = reportPath;
    let baseQ: Record<string, string | number | undefined> | undefined = baseQuery;

    if (extractRows(first).length === 0 && isAsync(first)) {
      // Async shape: poll the ResultUri. We bound polling at 60s; each
      // iteration sleeps 2s. TODO(verify): exact path of ResultUri vs the
      // brand prefix.
      const resultUri = (first as ImpactAdvReportEnvelope).ResultUri ?? '';
      if (!resultUri) return [];
      const pollPath = resultUri.startsWith('/') ? resultUri : `/${resultUri}`;
      const startedAt = Date.now();
      const timeoutMs = 60_000;
      let resolved = false;
      while (Date.now() - startedAt < timeoutMs) {
        await sleep(2_000);
        const poll = await impactAdvRequest<ImpactAdvReportEnvelope | ImpactAdvReportRow[]>({
          operation: 'getProgrammePerformance',
          brandPath: pollPath,
          networkBrandId: c.networkBrandId,
          resilience,
        });
        if (extractRows(poll).length > 0 || !isAsync(poll)) {
          envelope = poll;
          basePath = pollPath;
          baseQ = undefined;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'timeout',
            network: SLUG,
            operation: 'getProgrammePerformance',
            message: `Impact report poll exceeded ${timeoutMs}ms.`,
            hint: 'Narrow the date window or try again — Impact reports run async on large windows.',
          }),
        );
      }
    }

    // Collect page 1, then follow the continuation signals to completion (or
    // to `limit`, or to the MAX_PAGES backstop).
    const collected: ImpactAdvReportRow[] = [...extractRows(envelope)];
    let pages = 1;
    let next = nextAdvPageState(envelope, basePath, c.networkBrandId);
    while (
      next.nextPath &&
      collected.length > 0 &&
      (query?.limit === undefined || collected.length < query.limit)
    ) {
      if (pages >= MAX_PAGES) {
        log.warn(
          { operation: 'getProgrammePerformance', cap: MAX_PAGES, fetched: collected.length },
          'impact-advertiser pagination hit MAX_PAGES cap; result may be truncated',
        );
        break;
      }
      pages += 1;
      const env = await impactAdvRequest<ImpactAdvReportEnvelope | ImpactAdvReportRow[]>({
        operation: 'getProgrammePerformance',
        brandPath: next.nextPath,
        networkBrandId: c.networkBrandId,
        query:
          next.pageParam !== undefined
            ? { ...baseQ, Page: next.pageParam, PageSize: pageSize }
            : undefined,
        resilience,
      });
      const rows = extractRows(env);
      if (rows.length === 0) break;
      collected.push(...rows);
      next = nextAdvPageState(env, basePath, c.networkBrandId);
    }

    let mapped = collected.map(toPerformanceRow);
    if (typeof query?.limit === 'number') mapped = mapped.slice(0, query.limit);
    return mapped;
  }

  // -------------------------------------------------------------------------
  // listContracts / getContract — the brand-partner payment-term relationship.
  // READ-ONLY. The write surface lives in a follow-up PR behind a consent gate.
  // -------------------------------------------------------------------------

  /**
   * List the contracts on one of the brand's campaigns.
   *
   * Impact addresses contracts under a campaign, so `query.programmeId` (the
   * CampaignId) is required; we throw a `config_error` envelope when it is
   * missing rather than guessing a campaign.
   *
   * TODO(verify): the `/Campaigns/{id}/Contracts` path and response envelope
   * against a live agency tenant. The decision record notes scoped tokens may
   * force a `Programs` vs `Campaigns` split; reads use the `Campaigns` path per
   * the reference until confirmed.
   */
  async listContracts(
    query?: ImpactContractQuery,
    ctx?: AdapterCallContext,
  ): Promise<ImpactContract[]> {
    const c = requireCtx('listContracts', ctx);
    const campaignId = requireProgrammeId('listContracts', query?.programmeId);
    const envelope = await impactAdvRequest<ImpactAdvContractEnvelope | ImpactAdvContractRaw[]>({
      operation: 'listContracts',
      brandPath: `/Campaigns/${encodeURIComponent(campaignId)}/Contracts`,
      networkBrandId: c.networkBrandId,
      query: { PageSize: query?.limit ?? 100, Page: query?.cursor },
      resilience: RESILIENCE.default,
    });
    const list: ImpactAdvContractRaw[] = Array.isArray(envelope)
      ? envelope
      : envelope?.Contracts ?? [];
    let contracts = list.map((raw) => toContract(raw, campaignId, undefined, 'listContracts'));
    const statusFilter = toContractStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      contracts = contracts.filter((ct) => set.has(ct.status));
    }
    if (query?.mediaPartnerId) {
      contracts = contracts.filter((ct) => ct.mediaPartnerId === query.mediaPartnerId);
    }
    if (typeof query?.limit === 'number') contracts = contracts.slice(0, query.limit);
    return contracts;
  }

  /**
   * Fetch a single contract on one of the brand's campaigns by id.
   *
   * TODO(verify): the `/Campaigns/{id}/Contracts/{contractId}` path and whether
   * the single-contract response is wrapped (`{ Contract }`) or returned flat,
   * against a live agency tenant.
   */
  async getContract(
    input: { programmeId: string; contractId: string },
    ctx?: AdapterCallContext,
  ): Promise<ImpactContract> {
    const c = requireCtx('getContract', ctx);
    const campaignId = requireProgrammeId('getContract', input?.programmeId);
    const contractId = String(input?.contractId ?? '');
    if (contractId === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getContract',
          message: 'Impact advertiser getContract requires a contractId.',
          hint: 'Call listContracts for the campaign first to discover contract ids.',
        }),
      );
    }
    const envelope = await impactAdvRequest<ImpactAdvContractEnvelope | ImpactAdvContractRaw>({
      operation: 'getContract',
      brandPath: `/Campaigns/${encodeURIComponent(campaignId)}/Contracts/${encodeURIComponent(contractId)}`,
      networkBrandId: c.networkBrandId,
      resilience: RESILIENCE.default,
    });
    const wrapped = envelope as ImpactAdvContractEnvelope;
    const flat = wrapped.Contract ?? wrapped.Contracts?.[0] ?? (envelope as ImpactAdvContractRaw);
    return toContract(flat, campaignId, contractId);
  }

  // -------------------------------------------------------------------------
  // proposeContract — the first DOING-surface action (ADVISEMENT, not a write).
  // -------------------------------------------------------------------------

  /**
   * Build a reviewable plan for changing a contract WITHOUT performing any
   * network write. Reads current state via the read half (GET only, through the
   * guarded client), projects the intended end state, collects warnings, and
   * returns a deterministic `confirmationToken` over the normalised intent plus
   * the observed before-state.
   *
   * This issues NO non-GET request. The actual write (`applyContract` /
   * `removeContract`) is gated behind a separate opt-in token and live-tenant
   * verification, and is not built here; this advisement step lets an operator
   * see exactly what such a change would do, and its blast radius, first.
   *
   * TODO(verify): the projected `after` payload shape (template id vs inline
   * rate fields) against a live agency tenant, per the contracts decision.
   */
  async proposeContract(
    input: ContractChangeIntent,
    ctx?: AdapterCallContext,
  ): Promise<ContractChangePlan> {
    const c = requireCtx('proposeContract', ctx);
    const intent = normaliseContractChangeIntent(input);
    const campaignId = requireProgrammeId('proposeContract', intent.programmeId);
    if (intent.action === 'remove' && !intent.contractId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'proposeContract',
          message: 'Impact advertiser proposeContract requires a contractId to remove a contract.',
          hint: 'Call listContracts for the campaign first to discover contract ids.',
        }),
      );
    }
    // Read current state only when the change targets an existing contract.
    const before = intent.contractId
      ? await this.getContract({ programmeId: campaignId, contractId: intent.contractId }, c)
      : undefined;
    const observedContracts = before
      ? [before]
      : await this.listContracts(
          { programmeId: campaignId, mediaPartnerId: intent.mediaPartnerId, limit: 100 },
          c,
        );
    const after = projectContractAfter(before, intent, campaignId);
    return {
      action: intent.action,
      network: SLUG,
      brand: intent.brand,
      programmeId: campaignId,
      summary: renderContractSummary(before, intent),
      before,
      observedContracts,
      after,
      warnings: buildContractWarnings(before, intent, observedContracts),
      expiresAt: null,
      confirmationToken: computeConfirmationToken(intent, campaignId, before, observedContracts),
      experimental: true,
    };
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Impact advertiser adapter does not implement getProgramme at v0.1; use listProgrammes and filter client-side.',
    );
  }
  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Impact advertiser adapter does not implement getEarningsSummary at v0.1; use getProgrammePerformance for the per-publisher rollup.',
    );
  }
  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Impact advertiser adapter does not implement listClicks at v0.1; brand-side click data is reported via getProgrammePerformance.',
    );
  }
  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Impact advertiser adapter does not generate tracking links — that is a publisher-side operation.',
    );
  }
  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster.',
    );
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for Impact advertiser at v0.1.');
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
      note: 'Live probe runs at wizard time; not re-probed here to avoid hitting the network during diagnostic.',
    };
    operations['listBrands'] = {
      supported: true,
      note:
        'Multi-brand discovery hook. Marked experimental: under brand-direct mode the ' +
        '`/Advertisers/{SID}/Company` endpoint shape is `// TODO(verify)` against a live tenant. ' +
        'Conservative — set regardless of detected credential mode at v0.1.',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = { supported: true };
    operations['listTransactions'] = { supported: true };
    operations['listMediaPartners'] = { supported: true };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'Uses Impact adv_performance_by_media report; sync/async path TODO(verify) — async ResultUri polling unverified against a live tenant.',
      claimStatus: 'experimental',
    };
    operations['listContracts'] = {
      supported: true,
      note: 'Reads brand-partner contracts under a campaign. Endpoint path `/Campaigns/{id}/Contracts` is `// TODO(verify)` against a live agency tenant; the write surface is not enabled.',
      claimStatus: 'experimental',
    };
    operations['getContract'] = {
      supported: true,
      note: 'Reads a single contract by id. Endpoint path and single-contract envelope are `// TODO(verify)` against a live agency tenant.',
      claimStatus: 'experimental',
    };
    operations['proposeContract'] = {
      supported: true,
      note: 'Advisement only: reads current state and returns a reviewable ContractChangePlan + token. Performs no network write. The projected change payload shape is `// TODO(verify)`; applying the plan is gated and not enabled here.',
      claimStatus: 'experimental',
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

export const impactAdvertiserAdapter = new ImpactAdvertiserAdapter();
registerAdapter(impactAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function extractRows(env: ImpactAdvReportEnvelope | ImpactAdvReportRow[]): ImpactAdvReportRow[] {
  if (Array.isArray(env)) return env;
  return env.Records ?? env.Rows ?? env.Data ?? [];
}

function isAsync(env: ImpactAdvReportEnvelope | ImpactAdvReportRow[]): boolean {
  if (Array.isArray(env)) return false;
  if (env.ResultUri) return true;
  const s = String(env.Status ?? '').toLowerCase();
  return s === 'queued' || s === 'running' || s === 'pending';
}

/**
 * IMPACT-WORKAROUND: `@nextpageuri` on the brand surface comes back as a
 * fully-qualified path INCLUDING the tier prefix (`/Advertisers/{BrandSID}` or
 * `/Agencies/{AgencySID}/Advertisers/{BrandSID}`) that `impactAdvRequest` will
 * prepend on its own. Strip everything up to and including the brand segment
 * so we don't double it up — the same concession as the publisher adapter's
 * `stripMediapartnersPrefix`.
 */
function stripAdvertiserPrefix(uri: string, networkBrandId: string): string {
  let path = uri;
  try {
    const parsed = new URL(uri);
    path = parsed.pathname + parsed.search;
  } catch {
    // Already a relative path — use it as-is.
  }
  for (const id of [networkBrandId, encodeURIComponent(networkBrandId)]) {
    const marker = `/Advertisers/${id}`;
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      const rest = path.slice(idx + marker.length);
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
  }
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Work out where the next page lives, honouring both of Impact's pagination
 * signals. `@nextpageuri` wins when present (it already carries the query
 * string); otherwise `@page`/`@numpages` drive an incremented `Page` param
 * against `basePath`. Returns `{}` when the envelope signals no further page.
 */
function nextAdvPageState(
  envelope: unknown,
  basePath: string,
  networkBrandId: string,
): { nextPath?: string; pageParam?: number } {
  const env =
    envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      ? undefined
      : (envelope as ImpactAdvPagedEnvelope);
  const nextUri = env?.['@nextpageuri'];
  if (typeof nextUri === 'string' && nextUri.trim() !== '') {
    return { nextPath: stripAdvertiserPrefix(nextUri, networkBrandId) };
  }
  if (env?.['@page'] !== undefined && env['@numpages'] !== undefined) {
    const current = Number(env['@page']);
    const total = Number(env['@numpages']);
    if (Number.isFinite(current) && Number.isFinite(total) && current < total) {
      return { nextPath: basePath, pageParam: current + 1 };
    }
  }
  return {};
}

/**
 * Fetch every page of a brand-relative Impact list endpoint. When `target` is
 * present (the caller supplied `limit`) the loop stops as soon as enough raw
 * rows are collected; when absent it pulls to completion. `MAX_PAGES` is the
 * backstop against runaway continuation — hitting it logs a stderr warning so
 * a truncated pull is never silent (principle 4.1).
 */
async function collectAdvPages<TRaw>(input: {
  operation: AnyOperation;
  brandPath: string;
  networkBrandId: string;
  baseQuery?: Record<string, string | number | undefined>;
  pageSize: number;
  extract: (envelope: unknown) => TRaw[];
  resilience: ResilienceConfig;
  /** Stop early once this many raw rows are collected (query.limit present). */
  target?: number;
}): Promise<TRaw[]> {
  const collected: TRaw[] = [];
  let nextPath: string | undefined = input.brandPath;
  let pageParam: number | undefined = 1;
  let pages = 0;
  while (nextPath) {
    if (pages >= MAX_PAGES) {
      log.warn(
        { operation: input.operation, cap: MAX_PAGES, fetched: collected.length },
        'impact-advertiser pagination hit MAX_PAGES cap; result may be truncated',
      );
      break;
    }
    pages += 1;
    const envelope: unknown = await impactAdvRequest<unknown>({
      operation: input.operation,
      brandPath: nextPath,
      networkBrandId: input.networkBrandId,
      query:
        pageParam !== undefined
          ? { ...input.baseQuery, Page: pageParam, PageSize: input.pageSize }
          : undefined,
      resilience: input.resilience,
    });
    const list = input.extract(envelope);
    if (list.length === 0) break;
    collected.push(...list);
    if (input.target !== undefined && collected.length >= input.target) break;
    const next = nextAdvPageState(envelope, input.brandPath, input.networkBrandId);
    nextPath = next.nextPath;
    pageParam = next.pageParam;
  }
  return collected;
}

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

function toContractStatusList(
  v?: ImpactContractStatus | ImpactContractStatus[],
): ImpactContractStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// proposeContract helpers — pure; no network call, no mutation.
// ---------------------------------------------------------------------------

function normaliseContractChangeIntent(input: ContractChangeIntent): ContractChangeIntent {
  const action = input?.action;
  const brand = input?.brand?.trim();
  const programmeId = input?.programmeId?.trim();
  const contractId = input?.contractId?.trim() || undefined;
  const payoutTerms = input?.payoutTerms?.trim() || undefined;
  const mediaPartnerId = input?.mediaPartnerId?.trim() || undefined;
  const invalid =
    (action !== 'apply' && action !== 'remove') ||
    !brand ||
    !programmeId ||
    (action === 'remove' && (!contractId || payoutTerms !== undefined || mediaPartnerId !== undefined)) ||
    (action === 'apply' && payoutTerms === undefined && mediaPartnerId === undefined);
  if (invalid) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: 'proposeContract',
        message:
          'Impact advertiser proposeContract requires a valid brand, programmeId, and either an apply change (payoutTerms or mediaPartnerId) or a remove contractId.',
        hint: 'Use action apply with at least one changed field, or action remove with only contractId.',
      }),
    );
  }
  return { action, brand, programmeId, contractId, payoutTerms, mediaPartnerId };
}

/** Project the intended end state. `undefined` for a removal (nothing remains). */
function projectContractAfter(
  before: ImpactContract | undefined,
  input: ContractChangeIntent,
  campaignId: string,
): Partial<ImpactContract> | undefined {
  if (input.action === 'remove') return undefined;
  const base: Partial<ImpactContract> = before
    ? { ...before }
    : { network: SLUG, programmeId: campaignId, status: 'pending' };
  if (input.payoutTerms !== undefined) base.payoutTerms = input.payoutTerms;
  if (input.mediaPartnerId !== undefined) base.mediaPartnerId = input.mediaPartnerId;
  // The `after` is a projection, not a fetched object; drop any carried raw payload.
  delete (base as { rawNetworkData?: unknown }).rawNetworkData;
  return base;
}

/** Human-readable warnings, surfaced before any (gated) apply. */
function buildContractWarnings(
  before: ImpactContract | undefined,
  input: ContractChangeIntent,
  observedContracts: ImpactContract[] = before ? [before] : [],
): string[] {
  const warnings: string[] = [];
  if (input.action === 'remove') {
    warnings.push(
      'Removing a contract is irreversible. The before-state is preserved in this plan, but Impact may not allow re-creating an identical contract.',
    );
  } else if (!before) {
    warnings.push(
      "This creates a new contract; it would start pending, subject to Impact's workflow.",
    );
    if (observedContracts.length > 0) {
      warnings.push(
        `${observedContracts.length} existing contract(s) matched the current campaign${input.mediaPartnerId ? ' and media partner' : ''}; review observedContracts before creating another.`,
      );
    }
    warnings.push(
      'The create current-state check covers the first 100 contracts returned by the unverified Impact list endpoint.',
    );
  } else if (before.status === 'active' && input.payoutTerms !== undefined) {
    warnings.push('Changing payout terms on an active contract affects live partner payouts.');
  }
  warnings.push(
    'Experimental: the contract write payload shape is unverified (TODO(verify)). Applying this plan is gated and not yet enabled in this adapter.',
  );
  return warnings;
}

/** One-line summary of the proposed change for the operator. */
function renderContractSummary(
  before: ImpactContract | undefined,
  input: ContractChangeIntent,
): string {
  const target = input.contractId ? `contract ${input.contractId}` : 'a new contract';
  if (input.action === 'remove') {
    return `Remove ${target} on campaign ${input.programmeId} for brand ${input.brand}.`;
  }
  const terms = input.payoutTerms ? ` with payout terms "${input.payoutTerms}"` : '';
  const verb = before ? 'Update' : 'Create';
  return `${verb} ${target} on campaign ${input.programmeId} for brand ${input.brand}${terms}.`;
}

/**
 * Deterministic token over the normalised intent and the observed before-state.
 * Same intent + same before → identical token; any change of either differs.
 * Advisement boundary only (pins a later reviewed apply to these parameters);
 * NOT a security boundary against the model.
 */
function computeConfirmationToken(
  input: ContractChangeIntent,
  campaignId: string,
  before: ImpactContract | undefined,
  observedContracts: ImpactContract[] = before ? [before] : [],
): string {
  const normalised = normaliseContractChangeIntent(input);
  const canonical = JSON.stringify({
    network: SLUG,
    action: normalised.action,
    brand: normalised.brand,
    programmeId: campaignId,
    contractId: normalised.contractId ?? null,
    payoutTerms: normalised.payoutTerms ?? null,
    mediaPartnerId: normalised.mediaPartnerId ?? null,
    observedContracts: observedContracts
      .map((contract) => ({
        id: contract.id,
        network: contract.network,
        programmeId: contract.programmeId,
        programmeName: contract.programmeName ?? null,
        mediaPartnerId: contract.mediaPartnerId ?? null,
        mediaPartnerName: contract.mediaPartnerName ?? null,
        status: contract.status,
        payoutTerms: contract.payoutTerms ?? null,
        effectiveDate: contract.effectiveDate ?? null,
        expiryDate: contract.expiryDate ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Action capability map — the DOING-surface actions this adapter declares.
// See docs/decisions/2026-06-18-action-capability-map.md. Network-scoped
// identifiers, owned beside the operation. Only proposeContract is declared:
// the write half is not built, and #231 forbids declaring an api action whose
// owned operation does not exist.
// ---------------------------------------------------------------------------

export const impactAdvertiserActionDescriptors: ActionDescriptor[] = [
  {
    id: 'impact-advertiser.proposeContract',
    network: SLUG,
    channel: 'api',
    effect: 'advisement',
    defaultAuthorityTier: 1,
    description:
      'Build a reviewable plan for changing an Impact contract (the brand-partner ' +
      'payment-term relationship) without performing any network write. Reads current ' +
      'state and returns a ContractChangePlan with a confirmation token. Experimental: ' +
      'the change payload shape carries TODO(verify) and applying it is gated, not yet enabled.',
    // proposeContract only READS to build the plan, so it needs no write credential.
    credentialRequirements: [
      { label: 'IMPACT_ADVERTISER_ACCOUNT_SID' },
      { label: 'IMPACT_ADVERTISER_AUTH_TOKEN' },
    ],
  },
];

function canonicalToImpactState(s: TransactionStatus): string | undefined {
  switch (s) {
    case 'pending':
      return 'PENDING';
    case 'approved':
      return 'APPROVED';
    case 'reversed':
      return 'REVERSED';
    case 'paid':
      return 'PAID';
    default:
      return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const _internals = {
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  toContract,
  toDiscoveredBrand,
  mapCampaignStatus,
  mapActionStatus,
  mapMediaPartnerStatus,
  mapContractStatus,
  mapReportRowStatus,
  parseImpactDate,
  computeAgeDays,
  extractRows,
  isAsync,
  stripAdvertiserPrefix,
  nextAdvPageState,
  MAX_PAGES,
  PAGE_SIZE,
  // The module logger, exposed so tests can observe the MAX_PAGES warning.
  log,
  canonicalToImpactState,
  projectContractAfter,
  buildContractWarnings,
  renderContractSummary,
  computeConfirmationToken,
  normaliseContractChangeIntent,
};
