/**
 * GrowSurf adapter (advertiser / merchant side).
 *
 * GrowSurf is a SaaS referral platform used by the merchant: the API is the
 * merchant's view of their own referral programme — the campaign, the
 * participants enrolled in it, and the referral credit those participants have
 * earned. There is no publisher side and one API key + campaign id pair scopes
 * one programme, so this adapter is `advertiser` + `single-brand` (mirroring
 * Rewardful).
 *
 * Read `src/networks/rewardful/adapter.ts` first — it is the closest reference
 * (advertiser-side, single-brand SaaS-referral, ctx threading, client-side
 * earnings derivation). This file mirrors that shape.
 *
 * --- Referral-vs-commission mapping ----------------------------------------
 *
 * GrowSurf is referral-credit oriented, not classic CPS. The public REST API
 * does not expose a uniform monetary commission amount per referral event:
 * participants carry a `referralCount` (how many successful referrals they have
 * made) and a `referralStatus` (e.g. CREDIT_AWARDED). Reward fulfilment
 * (coupons, account credit, gift cards) is configured per campaign and is not
 * returned as a per-event monetary value on the participant.
 *
 * We therefore map each participant that has earned at least one referral
 * credit to one Transaction whose `commission` and `amount` are the referral
 * COUNT (not money) and whose `currency` is the sentinel `'CREDIT'`. The
 * verbatim participant payload is preserved on `rawNetworkData`. This is called
 * out in known_limitations so no consumer mistakes a credit count for revenue.
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * Built against the documented REST contract (bearer auth, campaign-scoped
 * routes, cursor pagination via `nextId`/`more`, epoch-millisecond timestamps).
 * The participants list wrapper key and the exact campaign reward fields have
 * not been confirmed against a live account; transformers read fields
 * defensively, preserve verbatim payloads on `rawNetworkData`, and carry
 * `// TODO(verify)` where unconfirmed.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes          GET /campaign/:id → one Programme (the campaign).
 *   getProgramme            GET /campaign/:id → Programme.
 *   listTransactions        GET /campaign/:id/participants → Transaction[]
 *                           (one per participant with referral credit).
 *   getEarningsSummary      derived from listTransactions (referral-credit sums).
 *   listClicks              NotImplementedError — GrowSurf exposes impression
 *                           counts on participants, not raw click records.
 *   generateTrackingLink    NotImplementedError — share URLs belong to
 *                           individual participants and are not derivable from
 *                           a destination URL via the merchant API.
 *   verifyAuth              cheap GET /campaign/:id probe (see auth.ts).
 */

import { growsurfRequest, SLUG } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireApiKey,
  requireCampaignId,
} from './auth.js';
import { setupSteps } from './setup.js';
import { configErrorFor, requireCtx } from './internal.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CommissionRateStructured,
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

const log = createLogger('growsurf.adapter');
const NAME = 'GrowSurf';

/**
 * Sentinel "currency" for the referral-credit mapping. GrowSurf referral events
 * carry no monetary amount via this API, so Transaction.amount / .commission
 * hold the referral COUNT, and currency makes that explicit rather than
 * implying e.g. USD. Documented in known_limitations.
 */
const CREDIT_UNIT = 'CREDIT';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.growsurf.com',
  authModel: 'bearer',
  docsUrl: 'https://docs.growsurf.com/developer-tools/rest-api',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'GrowSurf is referral-credit oriented, not classic CPS. The API exposes no monetary commission per referral event, so each participant with referral credit is mapped to one Transaction whose amount/commission is the referral COUNT (not money) and whose currency is the sentinel "CREDIT". Reward fulfilment (coupons, credit, gift cards) is configured per campaign and not returned per event.',
    'advertiser + single-brand: one API key + campaign id pair scopes one GrowSurf programme. Bind your single brand in brands.json manually.',
    'listClicks is unsupported: GrowSurf exposes impression counts on participants, not raw click records.',
    'generateTrackingLink is unsupported: a participant share URL (e.g. shareUrl) is minted per participant, not derivable from a destination URL via the merchant API.',
    'The participants list wrapper key and the campaign reward field names have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).',
    'Participant list pagination is cursor-based (nextId / more); wide pulls are capped at MAX_PAGES with a warning rather than a silent truncation.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'single-brand',
  // GrowSurf timestamps are epoch milliseconds; normalised to ISO at the edge.
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getEarningsSummary: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// GrowSurf response shapes (defensive)
// ---------------------------------------------------------------------------

interface GrowSurfCampaignRewardRaw {
  id?: string;
  type?: string; // e.g. COUPON, DOUBLE_SIDED — TODO(verify)
  value?: string | number;
  trigger?: string;
}

interface GrowSurfCampaignRaw {
  id?: string;
  name?: string;
  status?: string;
  url?: string;
  referralCount?: number;
  participantCount?: number;
  rewards?: GrowSurfCampaignRewardRaw[];
}

interface GrowSurfParticipantRaw {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  shareUrl?: string;
  referralCount?: number;
  monthlyReferralCount?: number;
  rank?: number;
  isWinner?: boolean;
  referralSource?: string;
  referralStatus?: string;
  createdAt?: number; // epoch milliseconds
}

/**
 * The participants-list response. Documented as cursor-paginated with `nextId`
 * (null when exhausted) and a `more` boolean. The array key is read defensively
 * (`participants` then `data`) since it has not been confirmed live.
 */
interface GrowSurfParticipantsEnvelope {
  participants?: GrowSurfParticipantRaw[];
  data?: GrowSurfParticipantRaw[];
  nextId?: string | null;
  more?: boolean;
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

function extractParticipants(body: unknown): GrowSurfParticipantRaw[] {
  if (Array.isArray(body)) return body as GrowSurfParticipantRaw[];
  if (body && typeof body === 'object') {
    const obj = body as GrowSurfParticipantsEnvelope;
    if (Array.isArray(obj.participants)) return obj.participants;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function nextCursor(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const obj = body as GrowSurfParticipantsEnvelope;
    if (obj.more === false) return null;
    if (typeof obj.nextId === 'string' && obj.nextId.trim() !== '') return obj.nextId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GrowSurf timestamps are epoch milliseconds. Normalise to ISO. */
function epochMsToIso(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Map GrowSurf participant `referralStatus` → canonical TransactionStatus.
 * The referral credit lifecycle, not a money lifecycle:
 *   CREDIT_AWARDED                       → 'paid'     (credit granted / fulfilled)
 *   CREDIT_PENDING / PENDING / QUALIFIED → 'pending'
 *   CREDIT_EARNED / EARNED               → 'approved' (earned, not yet fulfilled)
 *   FRAUD / VOID / REVOKED / EXPIRED     → 'reversed'
 *   else                                 → 'other'
 */
function mapTransactionStatus(raw: GrowSurfParticipantRaw): TransactionStatus {
  switch (String(raw.referralStatus ?? '').toUpperCase()) {
    case 'CREDIT_AWARDED':
    case 'AWARDED':
      return 'paid';
    case 'CREDIT_EARNED':
    case 'EARNED':
      return 'approved';
    case 'CREDIT_PENDING':
    case 'PENDING':
    case 'QUALIFIED':
      return 'pending';
    case 'FRAUD':
    case 'VOID':
    case 'REVOKED':
    case 'EXPIRED':
      return 'reversed';
    default:
      return 'other';
  }
}

function participantName(raw: GrowSurfParticipantRaw): string {
  const full = [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim();
  return full || raw.email || '';
}

function computeAgeDays(raw: GrowSurfParticipantRaw, now: Date = new Date()): number {
  const iso = epochMsToIso(raw.createdAt);
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: GrowSurfCampaignRaw): Programme {
  const id = String(raw.id ?? '');
  let commissionRate: CommissionRateStructured | undefined;
  const reward = raw.rewards?.[0];
  if (reward) {
    const value = typeof reward.value === 'number' ? reward.value : undefined;
    commissionRate = {
      type: 'unknown',
      value,
      description:
        `Referral reward (type: ${reward.type ?? 'unknown'}` +
        (reward.trigger ? `, trigger: ${reward.trigger}` : '') +
        '). GrowSurf rewards are referral credit, not a monetary commission rate.',
    };
  }
  return {
    id,
    name: raw.name ?? `GrowSurf campaign ${id}`,
    network: SLUG,
    // A campaign the merchant owns is an active programme by definition; if the
    // upstream status says otherwise, reflect a sensible canonical value.
    status: mapProgrammeStatus(raw.status),
    currency: CREDIT_UNIT,
    commissionRate,
    advertiserUrl: raw.url,
    rawNetworkData: raw,
  };
}

/**
 * Map a campaign `status` to a canonical ProgrammeStatus. GrowSurf campaigns
 * the merchant owns are normally live; an explicitly disabled campaign maps to
 * 'suspended'. Unknown upstream values fall back to 'joined' (the merchant owns
 * it) rather than guessing 'unknown'.
 */
function mapProgrammeStatus(status?: string): ProgrammeStatus {
  switch (String(status ?? '').toUpperCase()) {
    case 'DISABLED':
    case 'PAUSED':
    case 'INACTIVE':
      return 'suspended';
    default:
      return 'joined';
  }
}

function toTransaction(
  raw: GrowSurfParticipantRaw,
  campaignId: string,
  campaignName: string,
  now: Date = new Date(),
): Transaction {
  // Referral COUNT used as the credit amount — NOT money. See file header.
  const credit = typeof raw.referralCount === 'number' ? raw.referralCount : 0;
  return {
    id: String(raw.id ?? raw.email ?? ''),
    network: SLUG,
    programmeId: campaignId,
    programmeName: campaignName,
    status: mapTransactionStatus(raw),
    amount: credit,
    currency: CREDIT_UNIT,
    commission: credit,
    dateConverted: epochMsToIso(raw.createdAt) ?? new Date(0).toISOString(),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class GrowSurfAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  private async getCampaign(operation: string, apiKey: string, campaignId: string): Promise<GrowSurfCampaignRaw> {
    return growsurfRequest<GrowSurfCampaignRaw>({
      operation,
      path: `/campaign/${encodeURIComponent(campaignId)}`,
      apiKey,
      resilience: RESILIENCE.default,
    });
  }

  /**
   * Fetch every page of the campaign's participants. Loops while the response
   * carries a `nextId` cursor (and `more` is not false), capped at `MAX_PAGES`
   * — the cap is a backstop logged so a truncated pull is never silent
   * (principle 4.1).
   */
  private async fetchAllParticipants(
    operation: string,
    apiKey: string,
    campaignId: string,
    resilience = RESILIENCE.default,
  ): Promise<GrowSurfParticipantRaw[]> {
    const out: GrowSurfParticipantRaw[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const query: Record<string, string | number | undefined> = { limit: PAGE_SIZE };
      if (cursor) query['nextId'] = cursor;
      const body = await growsurfRequest<GrowSurfParticipantsEnvelope>({
        operation,
        path: `/campaign/${encodeURIComponent(campaignId)}/participants`,
        apiKey,
        query,
        resilience,
      });
      out.push(...extractParticipants(body));
      const next = nextCursor(body);
      if (next === null || next === cursor) return out;
      cursor = next;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'growsurf participant pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]> {
    requireCtx('listProgrammes', ctx);
    const apiKey = requireApiKey('listProgrammes');
    const campaignId = requireCampaignId('listProgrammes');
    const raw = await this.getCampaign('listProgrammes', apiKey, campaignId);
    let programmes = [toProgramme(raw)];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  async getProgramme(programmeId: string, ctx?: AdapterCallContext): Promise<Programme> {
    requireCtx('getProgramme', ctx);
    if (!programmeId || programmeId.trim() === '') {
      throw configErrorFor('getProgramme', 'A GrowSurf campaign id is required.', {
        hint: 'List programmes first (affiliate_growsurf_list_programmes) to find the id.',
      });
    }
    const apiKey = requireApiKey('getProgramme');
    const raw = await this.getCampaign('getProgramme', apiKey, programmeId);
    if (!raw || !raw.id) {
      throw configErrorFor('getProgramme', `No GrowSurf campaign found with id "${programmeId}".`, {
        hint: 'Use affiliate_growsurf_list_programmes to see the configured campaign id.',
      });
    }
    return toProgramme(raw);
  }

  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    requireCtx('listTransactions', ctx);
    const apiKey = requireApiKey('listTransactions');
    const campaignId = requireCampaignId('listTransactions');
    const now = new Date();

    // Programme name for the transaction rows; failure to fetch it is not fatal.
    let campaignName = `GrowSurf campaign ${campaignId}`;
    try {
      const campaign = await this.getCampaign('listTransactions', apiKey, campaignId);
      if (campaign?.name) campaignName = campaign.name;
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'growsurf campaign name lookup failed; using fallback');
    }

    const raw = await this.fetchAllParticipants(
      'listTransactions',
      apiKey,
      campaignId,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    );

    // Only participants who have earned referral credit represent a referral
    // event; participants with no referrals are not transactions.
    let transactions = raw
      .filter((p) => typeof p.referralCount === 'number' && p.referralCount > 0)
      .map((p) => toTransaction(p, campaignId, campaignName, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
    if (query?.from) {
      const fromMs = Date.parse(query.from);
      if (!Number.isNaN(fromMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) >= fromMs);
      }
    }
    if (query?.to) {
      const toMs = Date.parse(query.to);
      if (!Number.isNaN(toMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) <= toMs);
      }
    }
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    if (typeof query?.minAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);
    return transactions;
  }

  async getEarningsSummary(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<EarningsSummary> {
    requireCtx('getEarningsSummary', ctx);
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({ ...query, from, to, limit: undefined }, ctx);

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      // Referral credit, not money — see known_limitations.
      currency: CREDIT_UNIT,
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
          programmeName: t.programmeName || `GrowSurf campaign ${key}`,
          total: t.commission,
          currency: CREDIT_UNIT,
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
      currency: CREDIT_UNIT,
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // Ops not implemented.
  // -------------------------------------------------------------------------

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(
      'GrowSurf exposes impression counts on participants, not raw click records, via this API; listClicks is unsupported.',
    );
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(
      'generateTrackingLink is unsupported: GrowSurf share URLs are minted per participant (participant.shareUrl), not derivable from a destination URL via the merchant API.',
    );
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Not implemented for GrowSurf at v0.1.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for GrowSurf at v0.1.');
  }

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const r = await authVerify();
    if (r.ok) return r.identity ? { ok: true, identity: r.identity } : { ok: true };
    return { ok: false, reason: r.reason };
  }

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {
      verifyAuth: {
        supported: true,
        note: 'GET /campaign/:id probe; not re-probed here to avoid hitting the network during diagnostic.',
        claimStatus: 'experimental',
      },
      listProgrammes: { supported: true, note: 'GET /campaign/:id modelled as one programme.', claimStatus: 'experimental' },
      getProgramme: { supported: true, note: 'GET /campaign/:id.', claimStatus: 'experimental' },
      listTransactions: {
        supported: true,
        note: 'GET /campaign/:id/participants; one Transaction per participant with referral credit (amount/commission = referral COUNT, currency = "CREDIT").',
        claimStatus: 'experimental',
      },
      getEarningsSummary: { supported: true, note: 'Derived from listTransactions (referral-credit sums, not money).', claimStatus: 'experimental' },
      listClicks: { supported: false, note: 'GrowSurf exposes impression counts on participants, not raw clicks.' },
      generateTrackingLink: { supported: false, note: 'Share URLs are per-participant; not derivable from a destination URL via the merchant API.' },
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

export const growsurfAdapter = new GrowSurfAdapter();
registerAdapter(growsurfAdapter);

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

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  participantName,
  computeAgeDays,
  epochMsToIso,
  toProgramme,
  toTransaction,
  extractParticipants,
  nextCursor,
  CREDIT_UNIT,
};
