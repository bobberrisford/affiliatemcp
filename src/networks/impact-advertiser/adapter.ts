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

import { impactAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG } from './auth.js';
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

const log = createLogger('impact-advertiser.adapter');
const NAME = 'Impact (advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.impact.com',
  authModel: 'basic',
  docsUrl: 'https://integrations.impact.com/impact-brand/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-23',
  claimStatus: 'experimental',
  knownLimitations: [
    'Read-only at v0.1. The HTTP client refuses non-GET methods.',
    'Two credential tiers auto-detected at runtime: agency-passthrough and brand-direct.',
    'getProgrammePerformance uses Impact pre-built `adv_performance_by_media` report; sync vs async behaviour `// TODO(verify)` until a live agency tenant is available.',
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

interface ImpactAdvReportEnvelope {
  Records?: ImpactAdvReportRow[];
  Rows?: ImpactAdvReportRow[];
  Data?: ImpactAdvReportRow[];
  ResultUri?: string;
  Status?: string;
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
    const envelope = await impactAdvRequest<
      | { Campaigns?: ImpactAdvCampaignRaw[] }
      | ImpactAdvCampaignRaw[]
    >({
      operation: 'listProgrammes',
      brandPath: '/Campaigns',
      networkBrandId: c.networkBrandId,
      query: { PageSize: query?.limit ?? 100 },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });
    const list: ImpactAdvCampaignRaw[] = Array.isArray(envelope)
      ? envelope
      : envelope?.Campaigns ?? [];
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

    const envelope = await impactAdvRequest<
      | { Actions?: ImpactAdvActionRaw[] }
      | ImpactAdvActionRaw[]
    >({
      operation: 'listTransactions',
      brandPath: '/Actions',
      networkBrandId: c.networkBrandId,
      query: {
        ActionDateStart: query?.from,
        ActionDateEnd: query?.to,
        State: stateParam,
        PageSize: query?.limit ?? 100,
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });
    const list: ImpactAdvActionRaw[] = Array.isArray(envelope)
      ? envelope
      : envelope?.Actions ?? [];
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
    const envelope = await impactAdvRequest<
      | { MediaPartners?: ImpactAdvMediaPartnerRaw[] }
      | ImpactAdvMediaPartnerRaw[]
    >({
      operation: 'listMediaPartners',
      brandPath: '/MediaPartners',
      networkBrandId: c.networkBrandId,
      query: { PageSize: query?.limit ?? 100 },
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });
    const list: ImpactAdvMediaPartnerRaw[] = Array.isArray(envelope)
      ? envelope
      : envelope?.MediaPartners ?? [];
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
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);

    const q: Record<string, string | number | undefined> = {
      START_DATE: query?.from,
      END_DATE: query?.to,
      MEDIA_PARTNER_ID: query?.publisherId,
      CAMPAIGN_ID: query?.programmeId,
      PageSize: query?.limit ?? 1000,
    };

    const first = await impactAdvRequest<ImpactAdvReportEnvelope | ImpactAdvReportRow[]>({
      operation: 'getProgrammePerformance',
      brandPath: '/Reports/adv_performance_by_media',
      networkBrandId: c.networkBrandId,
      query: q,
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    // Sync shape: rows came back inline.
    const inlineRows = extractRows(first);
    if (inlineRows.length > 0 || !isAsync(first)) {
      let rows = inlineRows.map(toPerformanceRow);
      if (typeof query?.limit === 'number') rows = rows.slice(0, query.limit);
      return rows;
    }

    // Async shape: poll the ResultUri. We bound polling at 60s; each iteration
    // sleeps 2s. TODO(verify): exact path of ResultUri vs the brand prefix.
    const resultUri = (first as ImpactAdvReportEnvelope).ResultUri ?? '';
    if (!resultUri) return [];
    const startedAt = Date.now();
    const timeoutMs = 60_000;
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(2_000);
      const poll = await impactAdvRequest<ImpactAdvReportEnvelope | ImpactAdvReportRow[]>({
        operation: 'getProgrammePerformance',
        brandPath: resultUri.startsWith('/') ? resultUri : `/${resultUri}`,
        networkBrandId: c.networkBrandId,
        resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
      });
      const rows = extractRows(poll);
      if (rows.length > 0 || !isAsync(poll)) {
        let mapped = rows.map(toPerformanceRow);
        if (typeof query?.limit === 'number') mapped = mapped.slice(0, query.limit);
        return mapped;
      }
    }
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

// Silence unused-import lint when noUnusedLocals is on.
void log;

export const _internals = {
  toProgramme,
  toTransaction,
  toMediaPartner,
  toPerformanceRow,
  toDiscoveredBrand,
  mapCampaignStatus,
  mapActionStatus,
  mapMediaPartnerStatus,
  mapReportRowStatus,
  parseImpactDate,
  computeAgeDays,
  extractRows,
  isAsync,
  canonicalToImpactState,
};
