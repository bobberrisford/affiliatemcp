/**
 * Impact adapter — publisher (Mediapartners) surface.
 *
 * READ THIS FIRST:
 *
 * This adapter is NOT a pattern source. Per PRD §9.3 and AGENTS.md, Impact's
 * API is documented to have flakiness (sporadic 5xx storms, inconsistent
 * pagination shapes, occasional null bodies, mixed date formats). Some of the
 * code below is therefore DEFENSIVE in ways that the Awin or CJ adapters are
 * not. Future agents writing other adapters MUST read `src/networks/awin/
 * adapter.ts` for the canonical structure, not this file.
 *
 * Every defensive workaround in this folder is prefixed `// IMPACT-WORKAROUND:`
 * so it is greppable. Do NOT propagate those comments — or the patterns they
 * describe — into other networks.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes      — GET /Mediapartners/{SID}/Campaigns
 *   getProgramme        — GET /Mediapartners/{SID}/Campaigns/{CampaignId}
 *   listTransactions    — GET /Mediapartners/{SID}/Actions (chunked ≤30d)
 *   getEarningsSummary  — derived from listTransactions
 *   listClicks          — GET /Mediapartners/{SID}/Clicks (Impact DOES expose
 *                          click data — unlike Awin)
 *   generateTrackingLink— POST /Mediapartners/{SID}/TrackingValueRequests
 *   verifyAuth          — GET /Mediapartners/{SID}/Campaigns?PageSize=1
 *
 * Admin ops throw `NotImplementedError` at v0.1.
 *
 * --- Status mapping ----------------------------------------------------------
 *
 * Impact statuses → canonical:
 *
 *   PENDING    → pending
 *   APPROVED   → approved
 *   REVERSED   → reversed
 *   LOCKED     → approved   (LOCKED means "approved and queued for payment but
 *                            not yet paid" — semantically the same affordance
 *                            as `approved` from the user's perspective)
 *   PAID       → paid
 *   <other>    → other      (never invent a status the user didn't see)
 *
 * The raw status string is preserved on `rawNetworkData` so the user can
 * inspect the exact upstream value.
 *
 * --- Cardinal rules (identical to every other adapter) ----------------------
 *
 *   1. NEVER call `fetch` directly. Use `impactRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through `NetworkErrorEnvelope` with
 *      `network: 'impact'`, `operation`, `httpStatus`, verbatim `networkErrorBody`.
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums into our canonical set.
 *   5. COMPUTE `ageDays` for every transaction. PRD §15.9 depends on it.
 *   6. UK English in user-visible strings.
 */

import { impactRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate } from './auth.js';
import { setupSteps } from './setup.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type ApiGapResponse,
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

const log = createLogger('impact.adapter');

const SLUG = 'impact';
const NAME = 'Impact';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.impact.com',
  authModel: 'basic',
  docsUrl: 'https://integrations.impact.com/impact-publisher/reference',
  adapterVersion: '0.1.0',
  lastVerified: '2026-05-21',
  // `partial` rather than `production`: the adapter has not been validated
  // against a real account at commit time. Bump to `production` after
  // Chunk 8 acceptance testing.
  claimStatus: 'partial',
  knownLimitations: [
    'Action listings on wide date windows return intermittent 5xx; the adapter chunks ≤30-day slices and bumps retries to absorb upstream flakiness.',
    'Pagination headers are inconsistent across endpoints (some return @nextpageuri, some @page); both are honoured.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 6,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * IMPACT-WORKAROUND: `/Actions` and the derived earnings summary get a longer
 * timeout AND an extra retry on top of the default profile.
 *
 * Why: Impact has well-known intermittent 5xx storms on `/Actions` when the
 * date window is wide or the upstream report engine is warm-loading (PRD
 * §9.3). The default 30s timeout / 2 retries is insufficient for active
 * publishers. 60s timeout + 4 retries (5 attempts total) absorbs the worst
 * observed pattern of "first call 502, second call 502, third call 200"
 * without escalating to the user.
 *
 * Why we don't bump retries everywhere: most Impact endpoints (`/Campaigns`,
 * `/Clicks`, `/TrackingValueRequests`) behave normally. Indiscriminate
 * retries waste budget and slow down failure cases for endpoints that don't
 * benefit.
 */
const ACTIONS_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 4,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: ACTIONS_RESILIENCE,
  getEarningsSummary: ACTIONS_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Impact response shapes (deliberately minimal — see awin/adapter.ts for the
// rationale on not modelling these with strict schemas).
// ---------------------------------------------------------------------------

interface ImpactCampaignRaw {
  CampaignId?: string | number;
  CampaignName?: string;
  AdvertiserId?: string | number;
  AdvertiserName?: string;
  CampaignUrl?: string;
  CampaignDescription?: string;
  ContractStatus?: string;   // "Active" | "Pending" | "Declined" | ...
  ContractCurrency?: string;
  CampaignCurrency?: string;
  PublicTermsUrl?: string;
  // Pagination shape (when wrapped in an envelope).
  Categories?: string[];
}

interface ImpactCampaignsEnvelope {
  Campaigns?: ImpactCampaignRaw[];
  '@page'?: string;
  '@nextpageuri'?: string;
  '@numpages'?: string | number;
}

interface ImpactActionRaw {
  Id?: string | number;
  CampaignId?: string | number;
  CampaignName?: string;
  State?: string; // PENDING|APPROVED|REVERSED|LOCKED|PAID|...
  ActionStatus?: string; // some tenants return ActionStatus instead of State
  EventDate?: string;   // when the user converted (UTC, with offset)
  CreationDate?: string; // when Impact created the row
  LockingDate?: string;  // when status transitioned to LOCKED
  ClearedDate?: string;  // when payment cleared (status transitioned to PAID)
  ReferringDate?: string; // click date
  IntendedAmount?: string | number;
  Amount?: string | number;
  Payout?: string | number;
  Currency?: string;
  CustomerArea?: string;
  ReferralType?: string;
  // Reversal context — Impact populates `ReferralType` and a reason string.
  ReversalReason?: string;
  ActionTrackerName?: string;
}

interface ImpactActionsEnvelope {
  Actions?: ImpactActionRaw[];
  '@page'?: string;
  '@nextpageuri'?: string;
  '@numpages'?: string | number;
}

interface ImpactClickRaw {
  Id?: string | number;
  CampaignId?: string | number;
  CampaignName?: string;
  EventDate?: string;
  ReferringDate?: string;
  LandingPageUrl?: string;
  ReferringUrl?: string;
  TrackedEventStatus?: string;
}

interface ImpactClicksEnvelope {
  Clicks?: ImpactClickRaw[];
  '@page'?: string;
  '@nextpageuri'?: string;
}

interface ImpactTrackingResponse {
  TrackingURL?: string;
  TrackingValue?: string;
  Uri?: string;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireAccountSid(operation: string): string {
  return requireCredential('IMPACT_ACCOUNT_SID', {
    network: SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup impact` to provide IMPACT_ACCOUNT_SID, or set it in ~/.affiliate-mcp/.env. ' +
      'Find it at Impact dashboard → Settings → API → "Account SID and Auth Token".',
  });
}

function requireAuthToken(operation: string): string {
  return requireCredential('IMPACT_AUTH_TOKEN', {
    network: SLUG,
    operation,
    hint: 'Find the Auth Token at Impact dashboard → Settings → API → "Account SID and Auth Token".',
  });
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Map Impact action state → canonical TransactionStatus.
 *
 * See file-level header for the table. LOCKED maps to `approved` because the
 * user-facing intent is the same: "the commission is approved but the money
 * hasn't moved yet". PAID is set off Impact's PAID state directly. We never
 * invent `paid` from a date alone — if Impact doesn't say PAID, we don't.
 *
 * Unknown values map to `other`, preserving the raw upstream string on
 * `rawNetworkData`.
 */
function mapActionStatus(raw: ImpactActionRaw): TransactionStatus {
  const s = String(raw.State ?? raw.ActionStatus ?? '').toUpperCase();
  switch (s) {
    case 'PENDING':
      return 'pending';
    case 'APPROVED':
      return 'approved';
    case 'REVERSED':
      return 'reversed';
    case 'LOCKED':
      // LOCKED == approved-and-queued-for-payment. Surface as `approved`
      // because that's what the user understands; the raw "LOCKED" string
      // remains visible via rawNetworkData.
      return 'approved';
    case 'PAID':
      return 'paid';
    default:
      return 'other';
  }
}

/**
 * Map Impact campaign contract status → canonical ProgrammeStatus.
 *
 * Impact's enum:
 *   - Active   → joined
 *   - Pending  → pending
 *   - Declined → declined
 *   - Available (some tenants use "NotEnrolled") → available
 *   - Paused   → suspended
 *   - <other>  → unknown
 */
function mapCampaignStatus(raw: ImpactCampaignRaw): ProgrammeStatus {
  const s = String(raw.ContractStatus ?? '').toLowerCase();
  if (s === 'active' || s === 'joined') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'notenrolled' || s === 'notjoined') return 'available';
  if (s === 'paused' || s === 'suspended') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * IMPACT-WORKAROUND: Impact's date strings come in several forms, all visible
 * in production responses:
 *   - `YYYY-MM-DDTHH:MM:SS-OFFSET`      (most common)
 *   - `YYYY-MM-DDTHH:MM:SS.fffZ`        (millisecond-precision UTC)
 *   - `YYYY-MM-DDTHH:MM:SS`             (no offset; treat as UTC defensively)
 *
 * `Date.parse` handles the first two natively. For the third we append `Z`
 * before parsing to avoid silent local-timezone interpretation on the host.
 * If parsing still fails we return `undefined` — never fabricate a date.
 */
function parseImpactDate(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  let candidate = input.trim();
  if (candidate === '') return undefined;
  // Heuristic: no `Z` and no `+/-HH:MM` offset → append Z so the parser
  // treats it as UTC rather than the host's local timezone.
  if (!/[Zz]$/.test(candidate) && !/[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString();
}

/**
 * Compute the age (in days) of an action.
 *
 * Anchor priority:
 *   1. `LockingDate` (when LOCKED — i.e. approved-and-awaiting-payment)
 *   2. `EventDate`   (when the conversion happened)
 *
 * This mirrors Awin's "prefer the approval date so the unpaid-age affordance
 * answers 'how long has this been approved-but-unpaid'". For pending
 * transactions LockingDate is absent, so we fall back to EventDate.
 */
function computeAgeDays(raw: ImpactActionRaw, now: Date = new Date()): number {
  const anchor = raw.LockingDate ?? raw.EventDate ?? raw.CreationDate;
  const parsed = parseImpactDate(anchor);
  if (!parsed) return 0;
  const ts = Date.parse(parsed);
  if (Number.isNaN(ts)) return 0;
  const ms = now.getTime() - ts;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: ImpactCampaignRaw): Programme {
  const id = String(raw.CampaignId ?? raw.AdvertiserId ?? '');
  return {
    id,
    name: raw.CampaignName ?? raw.AdvertiserName ?? `Impact campaign ${id}`,
    network: SLUG,
    status: mapCampaignStatus(raw),
    currency: raw.ContractCurrency ?? raw.CampaignCurrency,
    advertiserUrl: raw.CampaignUrl,
    categories: Array.isArray(raw.Categories) ? raw.Categories.filter((c) => typeof c === 'string') : undefined,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: ImpactActionRaw, now: Date = new Date()): Transaction {
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
    programmeName: raw.CampaignName ?? raw.ActionTrackerName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: eventDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — surface a reversal reason where Impact provides one.
    reversalReason:
      status === 'reversed' ? raw.ReversalReason ?? raw.ReferralType ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toClick(raw: ImpactClickRaw): Click {
  return {
    id: String(raw.Id ?? ''),
    network: SLUG,
    programmeId: raw.CampaignId !== undefined ? String(raw.CampaignId) : undefined,
    timestamp: parseImpactDate(raw.EventDate ?? raw.ReferringDate) ?? new Date(0).toISOString(),
    referrer: raw.ReferringUrl,
    destinationUrl: raw.LandingPageUrl,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ImpactAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — GET /Campaigns
  // -------------------------------------------------------------------------

  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const accountSid = requireAccountSid('listProgrammes');
    const authToken = requireAuthToken('listProgrammes');

    // IMPACT-WORKAROUND: paginate explicitly via @nextpageuri / @page.
    // Impact's `/Campaigns` envelope can return either header depending on
    // tenant. We follow `@nextpageuri` when present; otherwise we increment
    // `Page` until the response is empty or `@numpages` is reached. The
    // hard cap of 10 pages prevents runaway loops if a tenant returns a
    // self-referential nextpageuri (observed historically).
    const collected: ImpactCampaignRaw[] = [];
    let pageParam: number | undefined = 1;
    let nextPath: string | undefined = '/Campaigns';
    let safety = 0;
    while (nextPath && safety < 10) {
      safety += 1;
      const envelope: ImpactCampaignsEnvelope | ImpactCampaignRaw[] = await impactRequest<
        ImpactCampaignsEnvelope | ImpactCampaignRaw[]
      >({
        operation: 'listProgrammes',
        path: nextPath,
        accountSid,
        authToken,
        query: pageParam !== undefined ? { Page: pageParam, PageSize: 100 } : undefined,
        resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
      });

      // Normalise both response shapes: bare array OR wrapped envelope.
      const list: ImpactCampaignRaw[] = Array.isArray(envelope)
        ? envelope
        : envelope?.Campaigns ?? [];
      if (list.length === 0) break;
      collected.push(...list);

      const env: ImpactCampaignsEnvelope | undefined = Array.isArray(envelope) ? undefined : envelope;
      const nextUri = env?.['@nextpageuri'];
      if (typeof nextUri === 'string' && nextUri.trim() !== '') {
        // The nextpageuri Impact returns is path-relative to
        // /Mediapartners/{SID}; strip the prefix so impactRequest can re-add it.
        nextPath = stripMediapartnersPrefix(nextUri, accountSid);
        pageParam = undefined;
      } else if (env?.['@page'] !== undefined && env['@numpages'] !== undefined) {
        const current: number = Number(env['@page']);
        const total: number = Number(env['@numpages']);
        if (!Number.isFinite(current) || !Number.isFinite(total) || current >= total) break;
        pageParam = current + 1;
        nextPath = '/Campaigns';
      } else {
        // No pagination signal → assume single page.
        break;
      }
    }

    let programmes = collected.map(toProgramme);

    // Client-side filters mirror Awin's behaviour for consistency.
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
  // getProgramme — GET /Campaigns/{CampaignId}
  // -------------------------------------------------------------------------

  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'Impact requires a CampaignId; received an empty string.',
          hint: 'List programmes first (affiliate_impact_list_programmes) to find the correct id.',
        }),
      );
    }
    const accountSid = requireAccountSid('getProgramme');
    const authToken = requireAuthToken('getProgramme');

    const raw = await impactRequest<ImpactCampaignRaw | { Campaign?: ImpactCampaignRaw }>({
      operation: 'getProgramme',
      path: `/Campaigns/${encodeURIComponent(programmeId)}`,
      accountSid,
      authToken,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // Some Impact tenants wrap single-campaign responses in `{ Campaign: {...} }`;
    // most return the bare object. Handle both.
    const flat = (raw as { Campaign?: ImpactCampaignRaw })?.Campaign ?? (raw as ImpactCampaignRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions — GET /Actions
  // -------------------------------------------------------------------------

  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const accountSid = requireAccountSid('listTransactions');
    const authToken = requireAuthToken('listTransactions');

    // IMPACT-WORKAROUND: chunk windows wider than 30 days. Impact's `/Actions`
    // endpoint is documented to accept arbitrary windows but in practice
    // returns 5xx storms on wide ranges (PRD §9.3). 30-day slices keep each
    // request inside the well-behaved envelope.
    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 30);

    const allRaw: ImpactActionRaw[] = [];
    for (const slice of slices) {
      // Impact wants ActionDateStart/ActionDateEnd as ISO-8601. The endpoint
      // also accepts a `State` filter; we don't apply it server-side because
      // our canonical statuses don't map 1:1 (LOCKED → approved). Filter
      // client-side after transformation.
      const pageRaw = await this.fetchActionsPaginated(
        accountSid,
        authToken,
        slice.start,
        slice.end,
      );
      allRaw.push(...pageRaw);
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
    if (typeof query?.minAgeDays === 'number') {
      const minAge = query.minAgeDays;
      transactions = transactions.filter((t) => t.ageDays >= minAge);
    }
    if (typeof query?.maxAgeDays === 'number') {
      const maxAge = query.maxAgeDays;
      transactions = transactions.filter((t) => t.ageDays <= maxAge);
    }
    if (typeof query?.limit === 'number') {
      transactions = transactions.slice(0, query.limit);
    }
    return transactions;
  }

  /**
   * Internal: fetch one date-slice's worth of /Actions with pagination.
   *
   * IMPACT-WORKAROUND: same dual-pagination concession as listProgrammes —
   * honour `@nextpageuri` when present, fall back to `@page`/`@numpages`,
   * cap at 25 pages so a misbehaving tenant cannot loop indefinitely.
   */
  private async fetchActionsPaginated(
    accountSid: string,
    authToken: string,
    start: Date,
    end: Date,
  ): Promise<ImpactActionRaw[]> {
    const collected: ImpactActionRaw[] = [];
    let pageParam: number | undefined = 1;
    let nextPath: string | undefined = '/Actions';
    let safety = 0;
    while (nextPath && safety < 25) {
      safety += 1;
      const envelope: ImpactActionsEnvelope | ImpactActionRaw[] = await impactRequest<
        ImpactActionsEnvelope | ImpactActionRaw[]
      >({
        operation: 'listTransactions',
        path: nextPath,
        accountSid,
        authToken,
        query:
          pageParam !== undefined
            ? {
                ActionDateStart: formatImpactDate(start),
                ActionDateEnd: formatImpactDate(end),
                Page: pageParam,
                PageSize: 100,
              }
            : undefined,
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      // IMPACT-WORKAROUND: empty-list shape is sometimes `null` (already
      // normalised to `{}` in the client), sometimes `{ Actions: [] }`,
      // sometimes a bare empty array. Read all three.
      const list: ImpactActionRaw[] = Array.isArray(envelope)
        ? envelope
        : envelope?.Actions ?? [];

      if (list.length === 0) break;
      collected.push(...list);

      const env: ImpactActionsEnvelope | undefined = Array.isArray(envelope) ? undefined : envelope;
      const nextUri = env?.['@nextpageuri'];
      if (typeof nextUri === 'string' && nextUri.trim() !== '') {
        nextPath = stripMediapartnersPrefix(nextUri, accountSid);
        pageParam = undefined;
      } else if (env?.['@page'] !== undefined && env['@numpages'] !== undefined) {
        const current: number = Number(env['@page']);
        const total: number = Number(env['@numpages']);
        if (!Number.isFinite(current) || !Number.isFinite(total) || current >= total) break;
        pageParam = current + 1;
        nextPath = '/Actions';
      } else {
        break;
      }
    }
    return collected;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary — derived from listTransactions
  // -------------------------------------------------------------------------

  /**
   * Same rationale as Awin: derive from `listTransactions` rather than
   * Impact's `/Reports/mp_action_listing_sku_fast`. Single source of truth;
   * the user can recompute totals from the per-transaction list.
   *
   * If a future requirement demands faster summaries for large publishers we
   * can add a reports-backed path as an optimisation while keeping the
   * derived calculation as the canonical answer.
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
      currency: 'USD',
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
          programmeName: t.programmeName || `Impact campaign ${key}`,
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
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks — GET /Clicks (Impact DOES expose this)
  // -------------------------------------------------------------------------

  /**
   * Impact exposes click-level data via `/Mediapartners/{SID}/Clicks` —
   * unlike Awin. This adapter implements it as a real operation rather than
   * a NotImplementedError stub.
   *
   * Pagination uses the same dual `@nextpageuri` / `@page` pattern as the
   * other list endpoints.
   */
  async listClicks(query?: ClickQuery): Promise<Click[]> {
    const accountSid = requireAccountSid('listClicks');
    const authToken = requireAuthToken('listClicks');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 30);

    const collected: ImpactClickRaw[] = [];
    for (const slice of slices) {
      let pageParam: number | undefined = 1;
      let nextPath: string | undefined = '/Clicks';
      let safety = 0;
      while (nextPath && safety < 25) {
        safety += 1;
        const envelope: ImpactClicksEnvelope | ImpactClickRaw[] = await impactRequest<
          ImpactClicksEnvelope | ImpactClickRaw[]
        >({
          operation: 'listClicks',
          path: nextPath,
          accountSid,
          authToken,
          query:
            pageParam !== undefined
              ? {
                  EventDateStart: formatImpactDate(slice.start),
                  EventDateEnd: formatImpactDate(slice.end),
                  Page: pageParam,
                  PageSize: 100,
                }
              : undefined,
          resilience: RESILIENCE.listClicks ?? RESILIENCE.default,
        });

        const list: ImpactClickRaw[] = Array.isArray(envelope)
          ? envelope
          : envelope?.Clicks ?? [];
        if (list.length === 0) break;
        collected.push(...list);

        const env: ImpactClicksEnvelope | undefined = Array.isArray(envelope) ? undefined : envelope;
        const nextUri = env?.['@nextpageuri'];
        if (typeof nextUri === 'string' && nextUri.trim() !== '') {
          nextPath = stripMediapartnersPrefix(nextUri, accountSid);
          pageParam = undefined;
        } else if (env?.['@page'] !== undefined) {
          // /Clicks sometimes omits `@numpages`; if the page came back with
          // less than PageSize results, stop after this iteration.
          if (list.length < 100) break;
          pageParam = Number(env['@page']) + 1;
          nextPath = '/Clicks';
        } else {
          break;
        }
      }
    }

    let clicks = collected.map(toClick);

    if (query?.programmeId) {
      clicks = clicks.filter((c) => c.programmeId === query.programmeId);
    }
    if (typeof query?.limit === 'number') {
      clicks = clicks.slice(0, query.limit);
    }
    return clicks;
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — POST /TrackingValueRequests
  // -------------------------------------------------------------------------

  /**
   * Impact does NOT support deterministic deep-link construction — every
   * tracking link is minted server-side and tied to a `TrackingValueRequest`
   * record. We POST to /TrackingValueRequests and surface the returned URL.
   *
   * The request body is form-urlencoded (Impact's POST endpoints reject JSON
   * here — see `client.ts`).
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Impact tracking links require the CampaignId (programmeId).',
          hint:
            'Pass `programmeId` from listProgrammes. Impact mints a per-link tracking record so the ' +
            'CampaignId is required.',
        }),
      );
    }
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full URL of the merchant page you want to link to.',
        }),
      );
    }

    const accountSid = requireAccountSid('generateTrackingLink');
    const authToken = requireAuthToken('generateTrackingLink');

    const response = await impactRequest<ImpactTrackingResponse>({
      operation: 'generateTrackingLink',
      path: '/TrackingValueRequests',
      accountSid,
      authToken,
      method: 'POST',
      body: {
        ProgramId: String(input.programmeId),
        Type: 'vanity',
        DeepLink: input.destinationUrl,
      },
      formEncoded: true,
      resilience: RESILIENCE.generateTrackingLink ?? RESILIENCE.default,
    });

    const trackingUrl = response.TrackingURL ?? response.TrackingValue;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Impact returned 2xx for the tracking-link request but the response did not include a TrackingURL.',
          hint: 'Inspect the raw response; the campaign may not be approved for deep linking.',
          networkErrorBody: JSON.stringify(response),
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: response,
    };
  }

  // -------------------------------------------------------------------------
  // applyToProgram — API gap demo
  //
  // Impact's publisher API exposes no endpoint for applying to a campaign;
  // the flow only exists in app.impact.com. This method NEVER throws — it
  // returns an `ApiGapResponse` describing the gap and (when possible) a
  // browser handoff a Claude-for-Chrome-style agent can drive in the user's
  // own authenticated session. See CONTRIBUTING.md → "API gaps and browser
  // handoffs" for the phrasing rules `userMessage` must follow.
  //
  // This method is intentionally NOT on `NetworkAdapter` — extending the
  // canonical interface waits until at least two networks emit handoffs for
  // the same goal, per the "two networks first" rule in shared/types.ts.
  // -------------------------------------------------------------------------

  async applyToProgram(input: {
    campaignId: string;
    promotionalMethods?: string[];
    notes?: string;
  }): Promise<ApiGapResponse> {
    return {
      kind: 'api-gap',
      network: SLUG,
      operation: 'applyToProgram',
      reason: "Impact's publisher API does not expose programme applications.",
      userMessage:
        "Impact's API doesn't support applying to programmes — that flow only " +
        'exists in their publisher portal. I can try to drive it with a browser ' +
        "agent instead (you'll need Claude for Chrome and to be logged in to " +
        "app.impact.com). I'll show you what's about to be submitted before " +
        'anything is clicked. Want me to try?',
      browserFallback: {
        goal: `Apply to Impact campaign ${input.campaignId}`,
        startingUrl: `https://app.impact.com/secure/mediapartner/campaign/${encodeURIComponent(input.campaignId)}.ihtml`,
        inputs: {
          campaignId: input.campaignId,
          promotionalMethods: input.promotionalMethods ?? [],
          notes: input.notes ?? '',
        },
        constraints: [
          'Stop and report if the active account is not a Publisher account.',
          'Stop if the apply button is missing or already reads Pending/Approved.',
          'Do not modify any field outside the application modal.',
          'Show the user a summary of what will be submitted and wait for explicit confirmation before clicking submit.',
          'Never accept new ToS or compliance checkboxes the user has not seen.',
        ],
        mutates: true,
        verify: {
          url: 'https://app.impact.com/secure/mediapartner/myprograms/pending.ihtml',
          expect: `Campaign ${input.campaignId} appears in the Pending list.`,
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      const identityStr = result.identity ? `impact/${result.identity.accountSid}` : undefined;
      return identityStr ? { ok: true, identity: identityStr } : { ok: true };
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
    await probe('listClicks', () => this.listClicks({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Requires a known CampaignId; not probed automatically (would create a real tracking record).',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known CampaignId; not probed automatically.',
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
// Module-level registration (mirrors Awin's pattern).
// ---------------------------------------------------------------------------

export const impactAdapter = new ImpactAdapter();
registerAdapter(impactAdapter);

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
 * Split `[from, to]` into ≤`maxDays`-day chunks. Impact rejects nothing in
 * the path of wide windows — but the upstream report engine throws 5xx
 * storms when overloaded. Chunking keeps each request inside the
 * well-behaved envelope.
 */
function chunkDateRange(from: Date, to: Date, maxDays: number): DateSlice[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return [{ start: from, end: to }];
  }
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
 * Format a Date for Impact's `ActionDateStart`/`ActionDateEnd` /
 * `EventDateStart`/`EventDateEnd` query params.
 *
 * Impact accepts ISO-8601 to the second. We strip milliseconds because
 * Impact's parser is known to reject the millisecond suffix on certain
 * endpoints (parser quirk, observed during chunk 5 work).
 */
function formatImpactDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * IMPACT-WORKAROUND: `@nextpageuri` is returned as a fully-qualified path
 * INCLUDING the `/Mediapartners/{SID}` prefix that `impactRequest` will
 * prepend on its own. Strip the prefix so we don't double it up.
 */
function stripMediapartnersPrefix(uri: string, accountSid: string): string {
  const prefix = `/Mediapartners/${accountSid}`;
  if (uri.startsWith(prefix)) {
    const rest = uri.slice(prefix.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  // Some tenants return a fully-qualified URL (with host). Pull just the path.
  try {
    const parsed = new URL(uri);
    const path = parsed.pathname + parsed.search;
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
    return path;
  } catch {
    // Already a relative path that doesn't carry the prefix — pass through.
    return uri.startsWith('/') ? uri : `/${uri}`;
  }
}

// Internal helpers exported for tests under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapActionStatus,
  mapCampaignStatus,
  computeAgeDays,
  parseImpactDate,
  toTransaction,
  toProgramme,
  toClick,
  chunkDateRange,
  formatImpactDate,
  stripMediapartnersPrefix,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
