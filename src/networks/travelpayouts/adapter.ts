/**
 * Travelpayouts adapter — publisher side, single-brand.
 *
 * Travelpayouts is a global travel affiliate network. A partner promotes many
 * connected travel brands (Aviasales, Hotellook, and others) and is paid a
 * commission per confirmed booking. There is no separate per-brand login: one
 * personal API token (`X-Access-Token`) addresses the whole account.
 *
 * This adapter follows the Awin reference (`src/networks/awin/adapter.ts`) —
 * read that file for the six cardinal rules and the "why" behind status
 * normalisation, `computeAgeDays`, and the derive-summary-from-transactions
 * pattern. The notable deviations are documented inline below.
 *
 * --- Travelpayouts API map (verify against the docs in network.json) --------
 *
 *   GET /finance/v2/get_user_balance
 *     → { balance: { usd, eur, rub } } — cheap auth check (see auth.ts).
 *
 *   GET /finance/v2/get_user_actions_affecting_balance
 *     ?currency=usd|eur|rub &from=YYYY-MM-DD &until=YYYY-MM-DD
 *     &campaign_id=<id> &action_state=paid|processing|cancelled
 *     &offset=<n> &limit=<=300
 *     → { actions: [{ action_id, campaign_id, action_state, price, profit,
 *         description, booked_at, updated_at }], total_price, total_profit,
 *         available_campaigns, count, currency }
 *     This is the publisher's per-booking record — the basis for
 *     listTransactions, getEarningsSummary, and the synthesised programmes.
 *
 *   GET /statistics/v1/get_fields_list  /  POST /statistics/v1/execute_query
 *     → aggregated booking statistics (clicks/searches/redirects counts). Used
 *       for dashboards, not per-booking records; not consumed here (see
 *       listClicks for why click-level data is not surfaced).
 *
 * --- Programmes are synthesised --------------------------------------------
 *
 * Travelpayouts has no publisher-facing "programme catalogue" endpoint on this
 * API surface. What it does expose is the set of connected travel brands the
 * partner has earned against, via `available_campaigns` (and the distinct
 * `campaign_id` values) on the actions response. We therefore SYNTHESISE
 * programmes from those campaign ids: each becomes a `Programme` with status
 * `joined` (the partner is already transacting against it). When no `limit` is
 * given, the synthesis pages through the offset-paginated actions endpoint to
 * completion (capped at `MAX_PAGES` with a logged warning), so a campaign that
 * only appears deep in the actions history is not missed. We cannot
 * determine commission rates or "available but not joined" programmes from
 * this surface, so those fields are left undefined and the operation carries a
 * per-op `claimStatus: 'experimental'`. The mapping is documented in
 * `synthesiseProgrammes`.
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * `price` (booking value) and `profit` (the partner's commission) are reported
 * in WHOLE units of the selected `currency`, matching the balance response
 * which returns decimal strings such as "1794.34" (not minor units / cents).
 * We pass them through verbatim. If a future Travelpayouts change moves to
 * minor units this assumption, and `toTransaction`, are the only things to
 * revisit.
 */

import { travelpayoutsRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireAccessToken,
  TRAVELPAYOUTS_SLUG,
} from './auth.js';
import { setupSteps } from './setup.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
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

const log = createLogger('travelpayouts.adapter');

const SLUG = TRAVELPAYOUTS_SLUG;
const NAME = 'Travelpayouts';

/** Travelpayouts finance amounts are reported in this default currency. */
const DEFAULT_CURRENCY = 'USD';

/** Travelpayouts caps `get_user_actions_affecting_balance` at 300 rows per page. */
const ACTIONS_PAGE_LIMIT = 300;

/**
 * Backstop for the offset-pagination loop: a misbehaving upstream that always
 * returns a full page must not spin forever. 100 pages * 300 rows = 30k
 * bookings is plenty; hitting the cap logs a warning so a truncated pull is
 * never silent (principle 4.1).
 */
const MAX_PAGES = 100;

const KNOWN_LIMITATIONS = [
  'Experimental: implemented from public documentation and not yet validated against a live Travelpayouts account.',
  'Amounts (price, profit) are assumed to be whole units of the selected currency, matching the balance response (e.g. "1794.34"); not minor units.',
  'Programmes are synthesised from the connected travel brands (campaign ids) that appear in the balance-actions response; Travelpayouts exposes no publisher programme-catalogue endpoint, so commission rates and not-yet-joined programmes are unavailable.',
  'Pagination is offset-based (max 300 rows per page); when no limit is given, listProgrammes and listTransactions page to completion, capped at MAX_PAGES with a warning rather than a silent truncation.',
  'Click-level data is not exposed per booking; the statistics API reports only aggregated click/redirect counts, so listClicks is unsupported.',
  'Tracking links are created in the dashboard with a partner marker; Travelpayouts publishes no deterministic deep-link URL formula, so generateTrackingLink is unsupported.',
];

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.travelpayouts.com',
  // Custom `X-Access-Token` header, not an HTTP Bearer token (see client.ts).
  authModel: 'custom',
  docsUrl:
    'https://support.travelpayouts.com/hc/en-us/articles/360019864079-API-of-affiliate-programs-booking-statistics',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: implemented from docs, not yet run against a live account.
  claimStatus: 'experimental',
  knownLimitations: KNOWN_LIMITATIONS,
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Travelpayouts response shapes (deliberately minimal — see client.ts)
// ---------------------------------------------------------------------------

interface TravelpayoutsActionRaw {
  action_id?: number | string;
  campaign_id?: number | string;
  action_state?: string; // paid | processing | cancelled
  price?: number | string;
  profit?: number | string;
  description?: string;
  booked_at?: string;
  updated_at?: string;
}

interface TravelpayoutsCampaignRaw {
  campaign_id?: number | string;
  id?: number | string;
  name?: string;
  title?: string;
}

interface TravelpayoutsActionsResponse {
  actions?: TravelpayoutsActionRaw[];
  total_price?: number | string;
  total_profit?: number | string;
  available_campaigns?: TravelpayoutsCampaignRaw[];
  count?: number;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Travelpayouts `action_state` → canonical.
 *
 * Travelpayouts uses three action states:
 *   processing → 'pending'  (booking confirmed by the brand, not yet payable)
 *   paid       → 'paid'     (settled and counted towards a payout)
 *   cancelled  → 'reversed' (the booking did not stand; no commission paid)
 *
 * There is no distinct "approved-but-unpaid" state on this surface, so we do
 * not emit 'approved'. Any unknown state maps to 'other' — by design we never
 * invent a status the partner did not see on Travelpayouts' side. The raw
 * value is preserved on `rawNetworkData`.
 */
function mapActionStatus(state?: string): TransactionStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'processing':
      return 'pending';
    case 'paid':
      return 'paid';
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Compute the age (in days) of a booking at the moment this adapter responded.
 *
 * We anchor on `booked_at` (the conversion date). Travelpayouts' `updated_at`
 * moves whenever the state changes, so it is not a stable conversion anchor;
 * `booked_at` is. PRD §15.9 — the unpaid-age affordance depends on this.
 */
function computeAgeDays(raw: TravelpayoutsActionRaw, now: Date = new Date()): number {
  const anchor = raw.booked_at;
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

function toDateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value.slice(0, 10);
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toTransaction(
  raw: TravelpayoutsActionRaw,
  currency: string,
  now: Date = new Date(),
): Transaction {
  const status = mapActionStatus(raw.action_state);
  const programmeId = raw.campaign_id !== undefined ? String(raw.campaign_id) : '';
  const bookedAt = nullableIso(raw.booked_at) ?? new Date(0).toISOString();
  const updatedAt = nullableIso(raw.updated_at);

  return {
    id: String(raw.action_id ?? ''),
    network: SLUG,
    programmeId,
    programmeName: programmeId ? `Travelpayouts campaign ${programmeId}` : '',
    status,
    // `price` is the booking value; `profit` is the partner's commission.
    // Both are in whole units of `currency` (see file-level assumption).
    amount: toNumber(raw.price),
    currency,
    commission: toNumber(raw.profit),
    dateConverted: bookedAt,
    // `updated_at` is the last state change — the closest signal Travelpayouts
    // gives for "approved/settled at". We surface it as both dateApproved and,
    // when the booking is paid, datePaid; otherwise datePaid stays undefined
    // rather than being fabricated.
    dateApproved: updatedAt,
    datePaid: status === 'paid' ? updatedAt : undefined,
    ageDays: computeAgeDays(raw, now),
    // Travelpayouts gives no per-booking reversal reason; `description` is the
    // only free-text field, so use it where the booking is reversed.
    reversalReason: status === 'reversed' ? raw.description : undefined,
    rawNetworkData: raw,
  };
}

/**
 * Synthesise programmes from the campaigns observed on the actions response.
 *
 * Travelpayouts exposes no publisher programme-catalogue endpoint. The actions
 * response carries `available_campaigns` (and distinct `campaign_id`s on each
 * action), which are the connected travel brands the partner has earned
 * against. We map each to a `Programme` with status `joined` because the
 * partner is already transacting against it. Names come from `available_campaigns`
 * where present, falling back to a synthetic "Travelpayouts campaign <id>"
 * label. Commission rate and not-yet-joined status are unavailable on this
 * surface and left undefined.
 */
function synthesiseProgrammes(response: TravelpayoutsActionsResponse): Programme[] {
  const names = new Map<string, string>();
  for (const c of response.available_campaigns ?? []) {
    const id = c.campaign_id ?? c.id;
    if (id === undefined) continue;
    const name = c.name ?? c.title;
    if (name) names.set(String(id), name);
    else if (!names.has(String(id))) names.set(String(id), '');
  }
  // Include campaigns seen only on action rows (not in available_campaigns).
  for (const a of response.actions ?? []) {
    if (a.campaign_id === undefined) continue;
    const id = String(a.campaign_id);
    if (!names.has(id)) names.set(id, '');
  }

  const programmes: Programme[] = [];
  for (const [id, name] of names) {
    programmes.push({
      id,
      name: name || `Travelpayouts campaign ${id}`,
      network: SLUG,
      status: 'joined' as ProgrammeStatus,
      rawNetworkData: { campaign_id: id, name: name || undefined, source: 'synthesised' },
    });
  }
  return programmes;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class TravelpayoutsAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — synthesised (see file-level comment)
  // -------------------------------------------------------------------------

  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    // Synthesised programmes are always `joined`. Apply the client-side filters
    // the contract supports; a status filter that excludes 'joined' yields none.
    const statusFilter = toStatusList(query?.status);
    const applyFilters = (input: Programme[]): Programme[] => {
      let programmes = input;
      if (query?.search) {
        const needle = query.search.toLowerCase();
        programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
      }
      if (statusFilter && statusFilter.length > 0) {
        const set = new Set(statusFilter);
        programmes = programmes.filter((p) => set.has(p.status));
      }
      return programmes;
    };

    // No `limit`: page the actions endpoint to completion so campaigns that
    // only appear deep in the history are synthesised too. With a `limit`,
    // stop as soon as enough filtered programmes have been seen — the first
    // page is always pulled, so this never returns less than the previous
    // single-page behaviour.
    const limit = typeof query?.limit === 'number' ? query.limit : undefined;
    const pull = await this.fetchActionsToCompletion(
      'listProgrammes',
      {},
      limit === undefined
        ? undefined
        : (acc) =>
            applyFilters(
              synthesiseProgrammes({ actions: acc.actions, available_campaigns: acc.campaigns }),
            ).length >= limit,
    );

    let programmes = applyFilters(
      synthesiseProgrammes({ actions: pull.actions, available_campaigns: pull.campaigns }),
    );
    if (limit !== undefined) {
      programmes = programmes.slice(0, limit);
    }
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme — synthesised single lookup
  // -------------------------------------------------------------------------

  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Travelpayouts campaign ids are numeric; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_travelpayouts_list_programmes) to find the correct id.',
        }),
      );
    }

    // No single-programme endpoint exists; we scope the actions response to the
    // requested campaign and synthesise from it. If the partner has no actions
    // for that campaign, we still return a minimal joined programme rather than
    // inventing data we cannot confirm.
    const response = await this.fetchActionsPage({
      limit: ACTIONS_PAGE_LIMIT,
      offset: 0,
      campaign_id: programmeId,
    });
    const programmes = synthesiseProgrammes(response);
    const found = programmes.find((p) => p.id === programmeId);
    if (found) return found;

    return {
      id: programmeId,
      name: `Travelpayouts campaign ${programmeId}`,
      network: SLUG,
      status: 'joined',
      rawNetworkData: { campaign_id: programmeId, source: 'synthesised', note: 'no actions in window' },
    };
  }

  // -------------------------------------------------------------------------
  // listTransactions — booking records from the finance API
  // -------------------------------------------------------------------------

  /**
   * List bookings (actions affecting balance) across a date window with
   * optional status / age / programme filters.
   *
   * Travelpayouts paginates with `offset`/`limit` (max 300 per page) rather
   * than a date-window cap, so we page through `offset` until a short page is
   * returned — the analogue of Awin's date chunking — capped at `MAX_PAGES`
   * with a logged warning. `from`/`until` filter on the booking `created_at`
   * date (YYYY-MM-DD). `currency` selects the unit; we default to USD and
   * surface it on every row.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();
    const from = toDateOnly(query?.from);
    const until = toDateOnly(query?.to);

    // Server-side status filter where the caller asked for a single canonical
    // status that maps cleanly to one Travelpayouts state; otherwise fetch all
    // and filter client-side (keeps multi-status queries correct).
    const statusFilter = toTransactionStatusList(query?.status);
    const soleStatus = statusFilter && statusFilter.length === 1 ? statusFilter[0] : undefined;
    const serverState = soleStatus ? canonicalToActionState(soleStatus) : undefined;

    // No early stop on `limit` here: the age/status filters below run
    // client-side, so a partial pull could under-return. `limit` stays a
    // final slice, as in the Awin reference.
    const { actions: rows, currency } = await this.fetchActionsToCompletion('listTransactions', {
      from,
      until,
      campaign_id: query?.programmeId,
      action_state: serverState,
      currency: DEFAULT_CURRENCY.toLowerCase(),
    });

    let transactions = rows.map((r) => toTransaction(r, currency, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
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
  // getEarningsSummary — derived from listTransactions (Awin pattern)
  // -------------------------------------------------------------------------

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
          programmeName: t.programmeName || `Travelpayouts campaign ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // Unpaid here means a booking still in 'processing' (canonical 'pending').
      // Travelpayouts has no separate approved-but-unpaid state on this surface.
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
  // listClicks — unsupported (see file-level comment + known limitations)
  // -------------------------------------------------------------------------

  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Travelpayouts does not expose click-level data; the statistics API reports only aggregated click/redirect counts',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — unsupported (no deterministic URL formula)
  // -------------------------------------------------------------------------

  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Travelpayouts tracking links are created in the dashboard with a partner marker; no deterministic deep-link URL formula is documented',
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
          // Synthesised / experimental surface; not yet validated live.
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
      note: 'Synthesised from the campaigns on the balance-actions response; requires a known campaign id.',
      claimStatus: 'experimental',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Travelpayouts does not expose click-level data via the publisher API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'No deterministic deep-link URL formula is documented; links are created in the dashboard.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: page the actions endpoint to completion
  // -------------------------------------------------------------------------

  /**
   * Fetch pages of the actions endpoint until a short page is returned,
   * accumulating action rows and the `available_campaigns` seen on every page.
   * An optional `isSatisfied` callback lets a caller with an explicit `limit`
   * stop early once the accumulated pull already answers the query; the first
   * page is always fetched. Capped at `MAX_PAGES` — the cap is a backstop
   * logged so a truncated pull is never silent (principle 4.1).
   */
  private async fetchActionsToCompletion(
    operation: string,
    params: {
      from?: string;
      until?: string;
      campaign_id?: string;
      action_state?: string;
      currency?: string;
    },
    isSatisfied?: (accumulated: {
      actions: TravelpayoutsActionRaw[];
      campaigns: TravelpayoutsCampaignRaw[];
    }) => boolean,
  ): Promise<{
    actions: TravelpayoutsActionRaw[];
    campaigns: TravelpayoutsCampaignRaw[];
    currency: string;
  }> {
    const actions: TravelpayoutsActionRaw[] = [];
    const campaigns: TravelpayoutsCampaignRaw[] = [];
    let currency = DEFAULT_CURRENCY;
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.fetchActionsPage({
        limit: ACTIONS_PAGE_LIMIT,
        offset,
        ...params,
      });
      if (typeof response.currency === 'string' && response.currency.length > 0) {
        currency = response.currency.toUpperCase();
      }
      campaigns.push(...(response.available_campaigns ?? []));
      const pageActions = Array.isArray(response.actions) ? response.actions : [];
      actions.push(...pageActions);
      if (pageActions.length < ACTIONS_PAGE_LIMIT) return { actions, campaigns, currency };
      if (isSatisfied?.({ actions, campaigns })) return { actions, campaigns, currency };
      offset += ACTIONS_PAGE_LIMIT;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: actions.length },
      'travelpayouts pagination hit MAX_PAGES cap; result may be truncated',
    );
    return { actions, campaigns, currency };
  }

  // -------------------------------------------------------------------------
  // Internal: one page of the actions endpoint
  // -------------------------------------------------------------------------

  private async fetchActionsPage(params: {
    limit: number;
    offset: number;
    from?: string;
    until?: string;
    campaign_id?: string;
    action_state?: string;
    currency?: string;
  }): Promise<TravelpayoutsActionsResponse> {
    const token = requireAccessToken('listTransactions');
    return travelpayoutsRequest<TravelpayoutsActionsResponse>({
      operation: 'listTransactions',
      path: '/finance/v2/get_user_actions_affecting_balance',
      token,
      query: {
        limit: params.limit,
        offset: params.offset,
        from: params.from,
        until: params.until,
        campaign_id: params.campaign_id,
        action_state: params.action_state,
        currency: params.currency,
      },
      resilience: RESILIENCE.default,
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin adapter for the rationale).
// ---------------------------------------------------------------------------

export const travelpayoutsAdapter = new TravelpayoutsAdapter();
registerAdapter(travelpayoutsAdapter);

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

/**
 * Map a canonical status to the Travelpayouts `action_state` query value, for
 * the single-status fast path. Returns undefined when the canonical status has
 * no clean Travelpayouts equivalent (e.g. 'approved' / 'other'), in which case
 * the caller fetches all rows and filters client-side.
 */
function canonicalToActionState(status: TransactionStatus): string | undefined {
  switch (status) {
    case 'pending':
      return 'processing';
    case 'paid':
      return 'paid';
    case 'reversed':
      return 'cancelled';
    default:
      return undefined;
  }
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapActionStatus,
  computeAgeDays,
  toTransaction,
  synthesiseProgrammes,
  canonicalToActionState,
  toDateOnly,
  log,
  ACTIONS_PAGE_LIMIT,
  MAX_PAGES,
};
