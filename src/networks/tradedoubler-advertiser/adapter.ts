/**
 * Tradedoubler advertiser (brand-side) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the defensive style of the impact-advertiser adapter.
 * Use the Awin adapter (src/networks/awin/adapter.ts) as the canonical template
 * for new networks — this file documents the Tradedoubler-specific divergences.
 *
 * Auth model: key-in-query-string ("custom"). Tradedoubler's legacy reporting
 * API authenticates via a key= query parameter (NOT token=) and an organizationId=
 * that scopes data to the operator's advertiser account. See ./auth.ts for details.
 * Confirmed: github.com/jongotlin/TradedoublerReportsWrapper (key=%s in URL)
 *
 * API surface used:
 *   reports.tradedoubler.com/pan/aReport3Key.action
 *     Endpoint accepts a `reportName` parameter to switch between report types:
 *       aAffiliateMyProgramsReport  → programme/brand list
 *       aAffiliateEventBreakdownReport → event/conversion data by publisher
 *
 * Operations implemented:
 *   listBrands             → programmes in the advertiser's account
 *   verifyAuth             → lightweight report probe (see auth.ts)
 *   listProgrammes         → aAffiliateMyProgramsReport filtered to this org
 *   listMediaPartners      → derived from aAffiliateEventBreakdownReport:
 *                            publisher IDs/names extracted from the breakdown
 *   getProgrammePerformance→ aAffiliateEventBreakdownReport with date filters
 *
 * Operations NOT implemented at v0.1 (throw NotImplementedError):
 *   getProgramme, listTransactions, getEarningsSummary, listClicks,
 *   generateTrackingLink, listPublishers, listPublisherSectors.
 *
 * Cardinal rules (same as every adapter):
 *   1. NEVER call fetch directly. Use `tdAdvRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on every domain object's `rawNetworkData`.
 *   4. UK English in user-visible strings.
 *   5. NEVER issue a non-GET request. The client enforces this.
 *
 * ctx usage:
 *   The adapter is `side: 'advertiser'` and `credential_scope: 'multi-brand'`.
 *   For ops that scope to a specific programme (brand), `ctx.networkBrandId`
 *   carries the Tradedoubler programId. Operations such as listProgrammes and
 *   listMediaPartners work across the whole account (no ctx required) but will
 *   filter when ctx is provided.
 *
 * Endpoint shapes and column names are confirmed against the reference PHP
 * implementation at github.com/jongotlin/TradedoublerReportsWrapper and the
 * XML mock data at github.com/denodell/tradedoubler. Auth parameter confirmed
 * as `key=` (not `token=`) from both community sources. XML format confirmed
 * as named child elements in `<row>` (not positional `<col>` elements).
 */

import { tdAdvRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, SLUG, getCredentials } from './auth.js';
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
} from '../../shared/types.js';
import type { TdAdvRow } from './client.js';

const log = createLogger('tradedoubler-advertiser.adapter');
const NAME = 'Tradedoubler (Advertiser)';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://reports.tradedoubler.com',
  authModel: 'custom',
  docsUrl: 'https://dev.tradedoubler.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-28',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public documentation; column names confirmed from community ' +
      'wrappers but not yet verified against a live account.',
    'Read-only at v0.1. The client refuses any non-GET request.',
    'Uses the Tradedoubler legacy reports API (reports.tradedoubler.com) with ' +
      'key= query-parameter auth. XML format uses named child elements per row. ' +
      'Column names confirmed from jongotlin/TradedoublerReportsWrapper and ' +
      'denodell/tradedoubler mock data.',
    'listMediaPartners extracts unique publishers from the event breakdown report ' +
      'rather than a dedicated publishers endpoint. Only publishers with at least one ' +
      'event in the query window are returned.',
    'getProgrammePerformance returns event-level rows (one per conversion); ' +
      'no click data is available in this report surface.',
    'generateTrackingLink, listTransactions, getEarningsSummary, and listClicks ' +
      'are not implemented at v0.1.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  getProgrammePerformance: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
  listMediaPartners: {
    ...DEFAULT_RESILIENCE,
    timeoutMs: 60_000,
    retries: 3,
  },
};

// ---------------------------------------------------------------------------
// Helpers — ctx, status mapping
// ---------------------------------------------------------------------------

/**
 * Require a brand context on ops that address a single programme.
 * Optional: returns null when ctx is absent (caller may proceed without it).
 */
function optionalCtx(ctx?: AdapterCallContext): string | undefined {
  return ctx?.networkBrandId;
}

/**
 * Map Tradedoubler programme status strings to canonical ProgrammeStatus.
 *
 * Status values confirmed from community implementations and XML mock data:
 *   A / ACTIVE  → joined (active programme relationship)
 *   P / PENDING → pending application
 *   D / DECLINED → declined
 *   S / SUSPENDED → suspended (inferred; not in mock data but in common use)
 *   (empty) → unknown
 *
 * Sources:
 *   github.com/denodell/tradedoubler/test/mock-data/advertisers.xml (A, S)
 *   github.com/wp-plugins/affiliate-power/apis/tradedoubler.php (A, P, D)
 */
function mapProgrammeStatus(raw: string): ProgrammeStatus {
  const s = raw.trim().toUpperCase();
  if (s === 'A' || s === 'ACTIVE') return 'joined';
  if (s === 'P' || s === 'PENDING') return 'pending';
  if (s === 'D' || s === 'DECLINED') return 'declined';
  if (s === 'S' || s === 'SUSPENDED') return 'suspended';
  return 'unknown';
}

/**
 * Map Tradedoubler event `pendingStatus` to canonical MediaPartner status.
 *
 * pendingStatus values confirmed from community implementations:
 *   A / APPROVED / ACTIVE → active (confirmed conversion)
 *   P / PENDING           → pending
 *   D / DECLINED          → inactive (reversed/declined conversion)
 *
 * Sources:
 *   github.com/wp-plugins/affiliate-power/apis/tradedoubler.php
 *   (maps P → 'Open', A → 'Confirmed', D → 'Cancelled')
 */
function mapMediaPartnerStatus(rawStatus: string): MediaPartner['status'] {
  const s = rawStatus.trim().toUpperCase();
  if (s === 'A' || s === 'APPROVED' || s === 'ACTIVE') return 'active';
  if (s === 'P' || s === 'PENDING') return 'pending';
  if (s === 'D' || s === 'DECLINED' || s === 'INACTIVE') return 'inactive';
  return 'unknown';
}

/**
 * Map Tradedoubler pendingStatus to ProgrammePerformanceRow status.
 *
 * A/P/D values confirmed from community implementations.
 * Source: github.com/wp-plugins/affiliate-power/apis/tradedoubler.php
 */
function mapPerformanceRowStatus(
  rawStatus: string,
): ProgrammePerformanceRow['status'] {
  const s = rawStatus.trim().toUpperCase();
  if (s === 'A' || s === 'APPROVED') return 'approved';
  if (s === 'D' || s === 'DECLINED' || s === 'CANCELLED') return 'reversed';
  return 'pending';
}

function toNumber(v: string | undefined): number {
  if (!v || v.trim() === '') return 0;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a Tradedoubler date string to ISO.
 *
 * Response date format: d.m.Y (e.g. "01.05.2026") confirmed from community
 * XML mock data (denodell/tradedoubler) and the Denormalizer.php which reads
 * timeOfEvent as a string. The adapter handles both d.m.Y and d.m.y (2-digit
 * year) for robustness.
 *
 * Request date format: Y-m-d (e.g. "2026-05-01") confirmed from jongotlin/
 * TradedoublerReportsWrapper Tradedoubler.php which uses DateTime::format('Y-m-d').
 *
 * Sources:
 *   github.com/jongotlin/TradedoublerReportsWrapper (Tradedoubler.php — Y-m-d)
 *   github.com/denodell/tradedoubler/test/mock-data/advertisers.xml (d.m.Y in data)
 */
function parseTdDate(input?: string): string | undefined {
  if (!input || input.trim() === '') return undefined;
  const v = input.trim();
  // Tradedoubler legacy: d.m.y  e.g. 01.05.26 or d.m.Y e.g. 01.05.2026
  const dotMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(v);
  if (dotMatch) {
    const day = (dotMatch[1] ?? '01').padStart(2, '0');
    const month = (dotMatch[2] ?? '01').padStart(2, '0');
    let year = dotMatch[3] ?? '2000';
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}T00:00:00.000Z`;
  }
  // ISO-ish YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const ts = Date.parse(v);
    return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
  }
  const ts = Date.parse(v);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute ageDays from a parsed ISO date string.
 * Anchored on the event date (or today if unavailable).
 */
function computeAgeDays(isoDate: string | undefined, now: Date = new Date()): number {
  if (!isoDate) return 0;
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return 0;
  const ms = now.getTime() - ts;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

/**
 * Transform an aAffiliateMyProgramsReport row to Programme.
 *
 * Column names confirmed from community sources:
 *   programId              — Tradedoubler programme identifier (integer)
 *   programName            — programme name (string); present in denodell mock data
 *   siteName               — publisher site name; kept as fallback (different context)
 *   status                 — A/P/D/S (string)
 *   programTariffPercentage— commission percentage (percentage type)
 *   programTariffAmount    — flat commission amount (decimal)
 *   programTariffCurrency  — currency code (string)
 *
 * Sources:
 *   github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml
 *   github.com/jongotlin/TradedoublerReportsWrapper (Denormalizer.php)
 */
function toProgramme(row: TdAdvRow): Programme {
  const id = row['programId'] ?? '';
  const name = row['programName'] ?? row['siteName'] ?? `Tradedoubler programme ${id}`;
  const status = mapProgrammeStatus(row['status'] ?? '');
  const commissionPct = toNumber(row['programTariffPercentage']);
  const commissionFlat = toNumber(row['programTariffAmount']);
  const currency = row['programTariffCurrency'];

  let commissionRate: Programme['commissionRate'];
  if (commissionPct > 0) {
    commissionRate = {
      type: 'percent',
      value: commissionPct,
      currency,
      description: `${commissionPct}%`,
    };
  } else if (commissionFlat > 0) {
    commissionRate = {
      type: 'flat',
      value: commissionFlat,
      currency,
      description: `${commissionFlat} ${currency ?? ''}`.trim(),
    };
  }

  return {
    id,
    name,
    network: SLUG,
    status,
    currency,
    commissionRate,
    rawNetworkData: row,
  };
}

/**
 * Transform a row from aAffiliateEventBreakdownReport to MediaPartner.
 *
 * Column names confirmed from community sources:
 *   siteId        — publisher site identifier (integer)
 *   siteName      — publisher site name (string)
 *   pendingStatus — A / P / D (string)
 *
 * Source: github.com/jongotlin/TradedoublerReportsWrapper (Denormalizer.php)
 */
function toMediaPartner(row: TdAdvRow): MediaPartner {
  const id = row['siteId'] ?? row['affiliateId'] ?? '';
  const name = row['siteName'] ?? row['affiliateName'] ?? `Tradedoubler publisher ${id}`;
  const status = mapMediaPartnerStatus(row['pendingStatus'] ?? '');
  return {
    id,
    name,
    status,
    rawNetworkData: row,
  };
}

/**
 * Transform a row from aAffiliateEventBreakdownReport to ProgrammePerformanceRow.
 *
 * Column names confirmed from community sources:
 *   timeOfEvent        — event date (d.m.Y in responses, e.g. "01.05.2026")
 *   siteId             — publisher site identifier
 *   siteName           — publisher site name
 *   pendingStatus      — A / P / D
 *   orderValue         — gross order value
 *   affiliateCommission— commission paid to publisher
 *   programId          — programme identifier
 *   eventName          — event type (e.g. "Sale", "Lead")
 *   currencyId         — currency code (ISO)
 *
 * The report is event-level (one row per conversion), not rolled-up per day.
 * Clicks are not present in this report type (CONFIRMED: event-breakdown is
 * conversion-only; no click column exists).
 *
 * Sources:
 *   github.com/jongotlin/TradedoublerReportsWrapper (Denormalizer.php)
 *   github.com/wp-plugins/affiliate-power/apis/tradedoubler.php (columns list)
 */
function toPerformanceRow(row: TdAdvRow, _now: Date = new Date()): ProgrammePerformanceRow {
  const rawDate = row['timeOfEvent'] ?? row['dateOfEvent'] ?? '';
  const parsedDate = parseTdDate(rawDate);
  const dateStr = parsedDate ? parsedDate.slice(0, 10) : rawDate.slice(0, 10);

  const grossSale = toNumber(row['orderValue'] ?? row['productValue']);
  const commission = toNumber(row['affiliateCommission']);
  const currency = row['currencyId'] ?? row['currency'] ?? 'EUR';

  // CONFIRMED: the aAffiliateEventBreakdownReport is conversion-level only.
  // There is no click column in this report type; the reference implementation
  // (jongotlin/TradedoublerReportsWrapper) has no click field in its column list.
  // Clicks are set to 0; listClicks throws NotImplementedError.
  const clicks = 0;
  const conversions = 1; // each row is one conversion event

  return {
    date: dateStr,
    publisherId: row['siteId'] ?? row['affiliateId'] ?? '',
    publisherName: row['siteName'] ?? row['affiliateName'] ?? '',
    clicks,
    conversions,
    grossSale,
    commission,
    currency,
    status: mapPerformanceRowStatus(row['pendingStatus'] ?? ''),
    rawNetworkData: row,
  };
}

/**
 * Transform a programmes-report row into a DiscoveredBrand.
 *
 * For Tradedoubler advertiser, each programme corresponds to one brand
 * on the network. `networkBrandId` = programId.
 */
function toDiscoveredBrand(row: TdAdvRow): DiscoveredBrand {
  const id = row['programId'] ?? '';
  const name = row['programName'] ?? row['siteName'] ?? `Tradedoubler programme ${id}`;
  return {
    networkBrandId: id,
    displayName: name,
    // aAffiliateMyProgramsReport has no explicit "API-enabled" flag column.
    // All returned programmes are presumed API-accessible (they are already
    // accessible via this report). Confirmed: no such column in the reference
    // implementation (jongotlin/TradedoublerReportsWrapper getPrograms columns).
    apiEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class TradedoublerAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate brands (programmes) in the advertiser's account by calling
   * aAffiliateMyProgramsReport. Each programme is returned as a DiscoveredBrand.
   *
   * Column names confirmed from jongotlin/TradedoublerReportsWrapper and the
   * XML mock data at github.com/denodell/tradedoubler.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const { token, organizationId } = getCredentials('listBrands');
    const rows = await tdAdvRequest({
      operation: 'verifyAuth',
      token,
      params: {
        reportName: 'aAffiliateMyProgramsReport',
        format: 'XML',
        columns: 'programId,programName,status',
        organizationId,
      },
      resilience: RESILIENCE.default,
    });
    return rows.map(toDiscoveredBrand);
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    return authVerify();
  }

  // -------------------------------------------------------------------------
  // listProgrammes — the advertiser's programmes.
  // -------------------------------------------------------------------------

  /**
   * List programmes in the advertiser's account via aAffiliateMyProgramsReport.
   *
   * Column names confirmed from jongotlin/TradedoublerReportsWrapper and
   * denodell/tradedoubler mock data. ctx is optional: if provided, filter
   * results to ctx.networkBrandId only.
   */
  async listProgrammes(
    query?: ProgrammeQuery,
    ctx?: AdapterCallContext,
  ): Promise<Programme[]> {
    const { token, organizationId } = getCredentials('listProgrammes');
    const brandId = optionalCtx(ctx);

    const rows = await tdAdvRequest({
      operation: 'listProgrammes',
      token,
      params: {
        reportName: 'aAffiliateMyProgramsReport',
        format: 'XML',
        columns:
          'programId,programName,status,programTariffPercentage,' +
          'programTariffAmount,programTariffCurrency',
        organizationId,
        ...(brandId ? { programId: brandId } : {}),
      },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = rows.map(toProgramme);

    // ctx filter (belt-and-braces).
    if (brandId) {
      programmes = programmes.filter((p) => p.id === brandId);
    }

    // query.search: client-side filter on programme name.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }

    // query.status filter.
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
  // listMediaPartners — publishers with events on the programme.
  // -------------------------------------------------------------------------

  /**
   * Extract unique publishers from the aAffiliateEventBreakdownReport.
   *
   * There is no dedicated publisher roster endpoint in the Tradedoubler
   * reporting API. Publishers are identified by the siteId/siteName columns
   * in the event breakdown. Only publishers who have generated at least one
   * event within a recent window are returned.
   *
   * Default window: last 90 days. Callers should pass query dates for a
   * longer look-back if they need inactive publishers.
   *
   * siteId/siteName column names confirmed from jongotlin/TradedoublerReportsWrapper
   * Denormalizer.php ($row->siteId, $row->siteName property access).
   */
  async listMediaPartners(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]> {
    const { token, organizationId } = getCredentials('listMediaPartners');
    const brandId = optionalCtx(ctx);

    // Default to last 90 days.
    const now = new Date();
    const defaultEnd = toTdDateStr(now);
    const defaultStart = toTdDateStr(
      new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    );

    const rows = await tdAdvRequest({
      operation: 'listMediaPartners',
      token,
      params: {
        reportName: 'aAffiliateEventBreakdownReport',
        format: 'XML',
        columns: 'siteId,siteName,pendingStatus',
        startDate: defaultStart,
        endDate: defaultEnd,
        organizationId,
        event_id: 0,
        ...(brandId ? { programId: brandId } : {}),
      },
      resilience: RESILIENCE.listMediaPartners ?? RESILIENCE.default,
    });

    // Deduplicate by siteId.
    const seen = new Set<string>();
    let partners: MediaPartner[] = [];
    for (const row of rows) {
      const id = row['siteId'] ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      partners.push(toMediaPartner(row));
    }

    // Status filter.
    if (query?.status) {
      const wanted = Array.isArray(query.status) ? query.status : [query.status];
      const set = new Set(wanted);
      partners = partners.filter((p) => set.has(p.status));
    }

    // Search filter on name.
    if (query?.search) {
      const needle = query.search.toLowerCase();
      partners = partners.filter((p) => p.name.toLowerCase().includes(needle));
    }

    if (typeof query?.limit === 'number') {
      partners = partners.slice(0, query.limit);
    }

    return partners;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher event breakdown.
  // -------------------------------------------------------------------------

  /**
   * Return event-level rows from aAffiliateEventBreakdownReport.
   *
   * Each row represents one conversion event. Callers can aggregate over the
   * result for rolled-up performance views.
   *
   * Column names confirmed from jongotlin/TradedoublerReportsWrapper.
   * Date format: YYYY-MM-DD for requests (confirmed), d.m.Y in responses.
   * currencyId: present in the event breakdown report column list (confirmed).
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const { token, organizationId } = getCredentials('getProgrammePerformance');
    const brandId = optionalCtx(ctx) ?? query?.programmeId;

    const now = new Date();
    const defaultEnd = toTdDateStr(now);
    const defaultStart = toTdDateStr(
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    );

    const rows = await tdAdvRequest({
      operation: 'getProgrammePerformance',
      token,
      params: {
        reportName: 'aAffiliateEventBreakdownReport',
        format: 'XML',
        columns:
          'timeOfEvent,siteId,siteName,pendingStatus,' +
          'orderValue,affiliateCommission,programId,eventName,currencyId',
        startDate: query?.from ? toTdDateStrFromIso(query.from) : defaultStart,
        endDate: query?.to ? toTdDateStrFromIso(query.to) : defaultEnd,
        organizationId,
        event_id: 0,
        pending_status: 1,
        metric1_summaryType: 'NONE',
        sortBy: 'timeOfEvent',
        ...(brandId ? { programId: brandId } : {}),
        ...(query?.publisherId ? { siteId: query.publisherId } : {}),
      },
      resilience: RESILIENCE.getProgrammePerformance ?? RESILIENCE.default,
    });

    let perfRows = rows.map((r) => toPerformanceRow(r, now));

    if (query?.publisherId) {
      perfRows = perfRows.filter((r) => r.publisherId === query.publisherId);
    }

    if (typeof query?.limit === 'number') {
      perfRows = perfRows.slice(0, query.limit);
    }

    return perfRows;
  }

  // -------------------------------------------------------------------------
  // Ops not implemented at v0.1
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(
      'Tradedoubler advertiser adapter does not implement getProgramme at v0.1; ' +
        'use listProgrammes and filter client-side.',
    );
  }

  async listTransactions(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<Transaction[]> {
    throw new NotImplementedError(
      'Tradedoubler advertiser adapter does not implement listTransactions at v0.1; ' +
        'use getProgrammePerformance for event/conversion data.',
    );
  }

  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(
      'Tradedoubler advertiser adapter does not implement getEarningsSummary at v0.1; ' +
        'use getProgrammePerformance for per-publisher performance data.',
    );
  }

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'Tradedoubler advertiser adapter does not implement listClicks at v0.1; ' +
        'click data is not available in the aAffiliateEventBreakdownReport surface.',
    );
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Tradedoubler advertiser adapter does not generate tracking links — ' +
        'that is a publisher-side operation.',
    );
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use listMediaPartners for the advertiser-side publisher roster.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError(
      'Not implemented for Tradedoubler advertiser at v0.1.',
    );
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
      claimStatus: 'experimental',
      note:
        'Uses aAffiliateMyProgramsReport. Column names confirmed from community wrappers; ' +
        'live-account verification still pending.',
    };
    operations['listProgrammes'] = {
      supported: true,
      claimStatus: 'experimental',
      note:
        'Uses aAffiliateMyProgramsReport. Column names confirmed from community wrappers; ' +
        'live-account verification still pending.',
    };
    operations['listMediaPartners'] = {
      supported: true,
      claimStatus: 'experimental',
      note:
        'Derived from aAffiliateEventBreakdownReport; only publishers with events in the last ' +
        '90 days are returned. Column names confirmed from jongotlin/TradedoublerReportsWrapper.',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      claimStatus: 'experimental',
      note:
        'Uses aAffiliateEventBreakdownReport. Event-level rows; no click data in this report. ' +
        'Column names confirmed from jongotlin/TradedoublerReportsWrapper.',
    };

    for (const op of [
      'getProgramme',
      'listTransactions',
      'getEarningsSummary',
      'listClicks',
      'generateTrackingLink',
    ]) {
      operations[op] = { supported: false, note: 'Not implemented at v0.1.' };
    }

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

export const tradedoublerAdvertiserAdapter = new TradedoublerAdvertiserAdapter();
registerAdapter(tradedoublerAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date to Tradedoubler's request date format: YYYY-MM-DD.
 *
 * Confirmed from jongotlin/TradedoublerReportsWrapper Tradedoubler.php which
 * uses $from->format('Y-m-d') for startDate/endDate parameters.
 *
 * Source: https://github.com/jongotlin/TradedoublerReportsWrapper
 */
function toTdDateStr(d: Date): string {
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert an ISO date string (YYYY-MM-DD or full ISO) to Tradedoubler format.
 */
function toTdDateStrFromIso(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso; // passthrough on parse failure
  return toTdDateStr(d);
}

// Silence unused-import lint when noUnusedLocals is on.
void log;
void buildErrorEnvelope;
void NetworkError;

export const _internals = {
  toProgramme,
  toMediaPartner,
  toPerformanceRow,
  toDiscoveredBrand,
  mapProgrammeStatus,
  mapMediaPartnerStatus,
  mapPerformanceRowStatus,
  parseTdDate,
  computeAgeDays,
  toTdDateStr,
  toTdDateStrFromIso,
};
