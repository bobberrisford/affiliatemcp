/**
 * 2Performant adapter — publisher (affiliate) side, single-brand credentials.
 *
 * Pattern source: src/networks/awin/adapter.ts (read that file first for the
 * cardinal rules and the "why" behind status normalisation, ageDays, date
 * chunking, deterministic link construction, and the aggregator import).
 *
 * 2Performant is a Romanian (RO) affiliate network. The notable deviation from
 * Awin is AUTH: there is no static API key. The adapter signs in with the
 * account email + password to obtain a rotating session (`access-token` /
 * `client` / `uid` headers), caches it (see `auth.ts`, modelled on Rakuten's
 * token cache), and re-logs-in once on a 401 before retrying.
 *
 * --- The seven publisher operations -----------------------------------------
 *
 *   listProgrammes       — GET /affiliate/programs        (affiliate programmes)
 *   getProgramme         — GET /affiliate/programs/{id}
 *   listTransactions     — GET /affiliate/commissions     (the workhorse)
 *   getEarningsSummary   — client-side aggregation over listTransactions
 *   listClicks           — NotImplementedError (no click-list endpoint exposed)
 *   generateTrackingLink — deterministic quicklink construction (documented)
 *   verifyAuth           — perform the session login; success ⇒ valid creds
 *
 * Two admin ops (`listPublishers`, `listPublisherSectors`) are scaffolded for
 * v0.2 and throw `NotImplementedError` at v0.1.
 *
 * --- 2Performant API map (verify against https://doc.2performant.com/ and the
 *     PHP reference wrapper https://github.com/2Parale/2Performant-php) -------
 *
 *   POST /users/sign_in            → session headers (access-token/client/uid).
 *   GET  /affiliate/programs       → { programs: [...], metadata: {...} }
 *   GET  /affiliate/programs/{id}  → { program: {...} }
 *   GET  /affiliate/commissions    → { commissions: [...], metadata: {...} }
 *        ?page= &perpage= &filter[status]= &filter[date]= &filter[query]= &sort[date]=
 *   Quicklink (tracking link): {eventHost}/events/click?ad_type=quicklink
 *        &aff_code={affiliate uniqueCode}&unique={programme uniqueCode}&redirect_to={url}
 */

import {
  twoPerformantRequest,
  type TwoPerformantSession,
  TWOPERFORMANT_BASE_URL,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  getSession,
  getCachedAffiliateCode,
  updateSession,
} from './auth.js';
import { setupSteps } from './setup.js';
import { HttpStatusError } from '../../shared/resilience.js';
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

const log = createLogger('2performant.adapter');

const SLUG = '2performant';
const NAME = '2Performant';

/**
 * 2Performant affiliates settle in EUR or RON depending on the advertiser.
 * Commissions carry their own `currency`; this default is only used when a row
 * omits it. RON is the home currency of the Romanian network, so it is the
 * least-surprising fallback.
 */
const FALLBACK_CURRENCY = 'RON';

const EXPERIMENTAL_LIMITATION =
  'Adapter built from public API documentation and the 2Performant PHP reference wrapper; ' +
  'not yet verified against a live 2Performant account.';

const AMOUNT_UNIT_LIMITATION =
  'Commission amounts are assumed to be in major currency units (e.g. RON / EUR, not bani / cents); ' +
  'not yet confirmed against a live account.';

const SESSION_AUTH_LIMITATION =
  '2Performant uses credential/session authentication (email + password sign-in returning rotating ' +
  'access-token / client / uid headers), not a static API key. The session is cached in memory and ' +
  're-established on a 401; cached sessions are lost on process restart and credentials must be ' +
  'updated here if the account password changes.';

const CLICKS_LIMITATION =
  'Click-level data is not exposed as a list endpoint by the public 2Performant affiliate API; listClicks is unsupported.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: TWOPERFORMANT_BASE_URL,
  authModel: 'custom',
  docsUrl: 'https://doc.2performant.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    EXPERIMENTAL_LIMITATION,
    CLICKS_LIMITATION,
    AMOUNT_UNIT_LIMITATION,
    SESSION_AUTH_LIMITATION,
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
 * Commissions can return many rows over a wide window; give listTransactions a
 * longer timeout and an extra retry, mirroring Awin's transactions profile.
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
// 2Performant response shapes (deliberately minimal; transformers read keys
// defensively and preserve the raw payload — see Awin client.ts for the why).
// 2Performant serialises in snake_case; we read both camelCase (as the PHP
// wrapper exposes) and snake_case to be tolerant of either.
// ---------------------------------------------------------------------------

interface TwoPfProgrammeRaw {
  id?: number | string;
  slug?: string;
  name?: string;
  unique_code?: string;
  uniqueCode?: string;
  status?: string;
  currency?: string;
  main_url?: string;
  mainUrl?: string;
  base_url?: string;
  category?: { name?: string } | string | null;
  default_sale_commission_rate?: number | string;
  defaultSaleCommissionRate?: number | string;
  default_sale_commission_type?: string;
  defaultSaleCommissionType?: string;
  // The affiliate request embedded on /affiliate/programs/{id}/me-style payloads.
  affrequest?: { status?: string } | null;
}

interface TwoPfProgrammesEnvelope {
  programs?: TwoPfProgrammeRaw[];
  metadata?: TwoPfMetadata;
}

interface TwoPfProgrammeEnvelope {
  program?: TwoPfProgrammeRaw;
}

interface TwoPfCommissionRaw {
  id?: number | string;
  amount?: number | string;
  currency?: string;
  status?: string;
  reason?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  program_id?: number | string;
  programId?: number | string;
  amount_in_working_currency?: number | string;
  amountInWorkingCurrency?: number | string;
  working_currency_code?: string;
  workingCurrencyCode?: string;
  program?: { id?: number | string; name?: string } | null;
  // Embedded click/action context, when present.
  public_action_data?: { transaction_date?: string; order_id?: string } | null;
  publicActionData?: { transactionDate?: string; orderId?: string } | null;
  public_click_data?: { created_at?: string } | null;
  publicClickData?: { createdAt?: string } | null;
}

interface TwoPfCommissionsEnvelope {
  commissions?: TwoPfCommissionRaw[];
  metadata?: TwoPfMetadata;
}

interface TwoPfMetadata {
  totalpages?: number;
  total?: number;
  page?: number;
  perpage?: number;
  currentpage?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: 2Performant commission status → canonical.
 *
 * 2Performant commission lifecycle (per the help centre):
 *   pending  — temporary, before the advertiser finalises  → 'pending'
 *   accepted — final, order valid                           → 'approved'
 *   rejected — final, order invalid (the affiliate is not paid) → 'reversed'
 *   paid     — advertiser has paid; value is withdrawable    → 'paid'
 *
 * We map 'rejected' to 'reversed' for the same reason Awin maps 'declined':
 * the user-facing intent is identical (the sale did not pay out) and 'reversed'
 * is the cross-network word for it. Any unrecognised value maps to 'other' —
 * we never invent a status the user did not see on 2Performant's side.
 */
function mapCommissionStatus(raw: TwoPfCommissionRaw): TransactionStatus {
  switch ((raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'accepted':
    case 'approved':
      return 'approved';
    case 'rejected':
    case 'declined':
      return 'reversed';
    case 'paid':
      return 'paid';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: 2Performant programme status → canonical ProgrammeStatus.
 *
 * The affiliate's relationship to a programme is carried either by the
 * programme `status` (the programme's own active/inactive state) or by an
 * embedded affiliate-request status (`accepted` / `pending` / `rejected`) when
 * the payload includes one. We prefer the affiliate-request status because it
 * answers the user's real question ("am I in?"); we fall back to programme
 * status. Unrecognised values map to 'unknown' rather than guessing.
 */
function mapProgrammeStatus(raw: TwoPfProgrammeRaw): ProgrammeStatus {
  const rel = (raw.affrequest?.status ?? '').toLowerCase();
  if (rel === 'accepted' || rel === 'approved') return 'joined';
  if (rel === 'pending') return 'pending';
  if (rel === 'rejected' || rel === 'declined') return 'declined';

  const s = (raw.status ?? '').toLowerCase();
  if (s === 'accepted' || s === 'approved' || s === 'active') return 'joined';
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'refused') return 'declined';
  if (s === 'available' || s === 'inactive' || s === 'open') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'stopped') return 'suspended';
  return 'unknown';
}

/** Coerce a value that may be a number or a numeric string to a number. */
function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age (in days) of a commission at response time. PRD §15.9 — the
 * unpaid-age affordance depends on this.
 *
 * We anchor on the conversion (created_at), the moment the commission was
 * registered. 2Performant does not expose a separate validation date on the
 * affiliate commission payload, so created_at is the honest anchor for "how
 * long has this been outstanding".
 */
function computeAgeDays(raw: TwoPfCommissionRaw, now: Date = new Date()): number {
  const anchor = raw.created_at ?? raw.createdAt;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers (2Performant raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: TwoPfProgrammeRaw): Programme {
  const id = String(raw.id ?? raw.slug ?? '');
  const rate = raw.default_sale_commission_rate ?? raw.defaultSaleCommissionRate;
  const rateType = (raw.default_sale_commission_type ?? raw.defaultSaleCommissionType ?? '').toLowerCase();
  const categories: string[] = [];
  if (typeof raw.category === 'string') categories.push(raw.category);
  else if (raw.category && typeof raw.category.name === 'string') categories.push(raw.category.name);

  return {
    id,
    name: raw.name ?? `2Performant programme ${id}`,
    slug: raw.slug,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency,
    commissionRate:
      rate !== undefined
        ? {
            // 2Performant's sale commission is a percentage rate when the type
            // says so; otherwise we keep it as unknown and describe the value.
            type: rateType === 'percent' || rateType === 'percentage' ? 'percent' : 'unknown',
            value: toNumber(rate),
            currency: raw.currency,
          }
        : undefined,
    categories,
    advertiserUrl: raw.main_url ?? raw.mainUrl ?? raw.base_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: TwoPfCommissionRaw, now: Date = new Date()): Transaction {
  const status = mapCommissionStatus(raw);
  const commission = toNumber(raw.amount);
  const currency = raw.currency ?? raw.working_currency_code ?? raw.workingCurrencyCode ?? FALLBACK_CURRENCY;

  const action = raw.public_action_data ?? raw.publicActionData ?? undefined;
  const click = raw.public_click_data ?? raw.publicClickData ?? undefined;

  const createdAt =
    nullableIso(raw.created_at ?? raw.createdAt) ?? new Date(0).toISOString();
  const dateConverted =
    nullableIso(
      (action as { transaction_date?: string } | undefined)?.transaction_date ??
        (action as { transactionDate?: string } | undefined)?.transactionDate,
    ) ?? createdAt;
  const dateClicked = nullableIso(
    (click as { created_at?: string } | undefined)?.created_at ??
      (click as { createdAt?: string } | undefined)?.createdAt,
  );

  const programmeId = String(raw.program_id ?? raw.programId ?? raw.program?.id ?? '');

  return {
    id: String(raw.id ?? ''),
    network: SLUG,
    programmeId,
    programmeName: raw.program?.name ?? '',
    status,
    // 2Performant's affiliate commission payload reports the commission amount,
    // not the gross sale value, so we surface the commission as the amount and
    // mirror it in `commission`. There is no separate sale-amount field to read.
    amount: commission,
    currency,
    commission,
    dateClicked,
    dateConverted,
    // No distinct approval/payment dates are exposed on the affiliate commission
    // payload; leave undefined rather than fabricating (PRD §4.1).
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // 2Performant populates `reason` on rejected commissions.
    reversalReason: status === 'reversed' ? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class TwoPerformantAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Issue an authenticated request, re-logging-in once on a 401.
   *
   * This is the single place the session/credential auth model is enforced for
   * data calls. We fetch the cached session (logging in if absent), make the
   * call, and fold any rotated session headers back into the cache. If the call
   * fails with a 401 (classified `auth_error`), we clear the session, log in
   * once more, and retry exactly once — never looping. A second 401 surfaces as
   * a NetworkError so the user sees the verbatim upstream body.
   */
  private async authedRequest<T>(args: {
    operation: string;
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    query?: Record<string, unknown>;
    body?: unknown;
    resilience: ResilienceConfig;
  }): Promise<T> {
    const attempt = async (session: TwoPerformantSession): Promise<T> => {
      const res = await twoPerformantRequest<T>({
        operation: args.operation,
        path: args.path,
        method: args.method,
        query: args.query,
        body: args.body,
        session,
        resilience: args.resilience,
      });
      if (res.rotatedSession) updateSession(res.rotatedSession);
      return res.body;
    };

    const session = await getSession();
    try {
      return await attempt(session);
    } catch (err) {
      if (isAuthError(err)) {
        log.debug({ operation: args.operation }, '2performant 401 — re-login and retry once');
        const fresh = await getSession({ forceRefresh: true });
        return attempt(fresh);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the affiliate's programmes.
   *
   * 2Performant's `/affiliate/programs` returns `{ programs: [...], metadata }`.
   * `search` maps to the API `filter[query]`; status is filtered client-side
   * after normalisation because the API's programme status vocabulary does not
   * map cleanly onto our enum. `limit` becomes `perpage` so we don't over-fetch.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const params: Record<string, unknown> = {};
    const filter: Record<string, unknown> = {};
    if (query?.search) filter['query'] = query.search;
    if (Object.keys(filter).length > 0) params['filter'] = filter;
    if (typeof query?.limit === 'number') params['perpage'] = query.limit;

    const env = await this.authedRequest<TwoPfProgrammesEnvelope>({
      operation: 'listProgrammes',
      path: '/affiliate/programs',
      query: params,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = (Array.isArray(env.programs) ? env.programs : []).map(toProgramme);

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
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single programme by id or slug.
   *
   * `/affiliate/programs/{id}` returns `{ program: {...} }`. 2Performant accepts
   * either the numeric id or the slug as the path segment, so we do not enforce
   * a numeric format here (unlike Awin).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A programme id or slug is required.',
          hint: 'List programmes first (affiliate_2performant_list_programmes) to find the id.',
        }),
      );
    }

    const env = await this.authedRequest<TwoPfProgrammeEnvelope>({
      operation: 'getProgramme',
      path: `/affiliate/programs/${encodeURIComponent(programmeId)}`,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });
    return toProgramme(env.program ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List commissions across a date window with optional status / age / programme filters.
   *
   * 2Performant endpoint:
   *   GET /affiliate/commissions
   *     ?page= &perpage=
   *     &filter[status]=pending|accepted|rejected|paid
   *     &filter[date]=YYYY-MM-DD,YYYY-MM-DD   (comma range; verify per tenant)
   *     &sort[date]=desc
   *
   * Pagination is cursor-free: `metadata.totalpages` tells us how many pages
   * exist. We walk pages until we have them all (capped) so a caller asking for
   * a wide window gets every commission rather than just the first page.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   * `query.minAgeDays` returns only commissions whose computed `ageDays` is >=
   * the threshold (anchored on created_at). Applied after status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   * Reversed (rejected) commissions are returned unless excluded via `status`;
   * the transformer populates `reversalReason` from 2Performant's `reason`.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const now = new Date();

    // Map a single canonical status filter to the API status when exactly one
    // is requested (server-side narrowing); otherwise filter client-side.
    const statusFilter = toTransactionStatusList(query?.status);
    const apiStatus =
      statusFilter && statusFilter.length === 1 && statusFilter[0] !== undefined
        ? toApiStatus(statusFilter[0])
        : undefined;

    const dateFilter = buildDateFilter(query?.from, query?.to);

    const perpage = 100;
    const allRaw: TwoPfCommissionRaw[] = [];
    let page = 1;
    // Hard cap on pages to avoid an unbounded walk on a huge account; 50 pages
    // × 100 rows = 5000 commissions, plenty for the workflows this serves.
    const MAX_PAGES = 50;

    while (page <= MAX_PAGES) {
      const filter: Record<string, unknown> = {};
      if (apiStatus) filter['status'] = apiStatus;
      if (dateFilter) filter['date'] = dateFilter;

      const env = await this.authedRequest<TwoPfCommissionsEnvelope>({
        operation: 'listTransactions',
        path: '/affiliate/commissions',
        query: {
          page,
          perpage,
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
          sort: { date: 'desc' },
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      const chunk = Array.isArray(env.commissions) ? env.commissions : [];
      allRaw.push(...chunk);

      const totalPages = env.metadata?.totalpages;
      if (chunk.length === 0) break;
      if (typeof totalPages === 'number' && page >= totalPages) break;
      // Defensive: if the API ignores pagination and returns a short page,
      // stop rather than re-fetching the same rows forever.
      if (chunk.length < perpage) break;
      page += 1;
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

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
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate commissions into an earnings summary.
   *
   * Derived from `listTransactions` (the same rationale as Awin): the
   * transactions are the canonical record, the derivation is auditable, and we
   * need per-commission ageDays for `oldestUnpaidAgeDays` regardless. We ignore
   * `limit` here because a limit on a summary would silently undercount.
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
      currency: FALLBACK_CURRENCY,
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
          programmeName: t.programmeName || `2Performant programme ${key}`,
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
      currency: firstCurrency ?? FALLBACK_CURRENCY,
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
   * 2Performant does not expose a click-list endpoint to affiliates via the
   * public API. Click context is only available embedded on a commission
   * (`public_click_data`), not as a standalone list.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "no clicks" and "clicks are not exposed" is
   * the difference between an actionable observation and a wild goose chase
   * (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      '2Performant does not expose click-level data as a list endpoint via the public affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a 2Performant quicklink (deep link).
   *
   * Documented, deterministic format (per the PHP reference wrapper):
   *
   *   {eventHost}/events/click
   *     ?ad_type=quicklink
   *     &aff_code={affiliate unique code}
   *     &unique={programme unique code}
   *     &redirect_to={destinationUrl, URL-encoded}
   *
   * `eventHost` is the API host with the `api` sub-domain rewritten to `event`
   * (api.2performant.com → event.2performant.com), matching the wrapper.
   *
   * Why deterministic rather than an API call: the scheme is documented and
   * stable, so an API round-trip would add latency and a failure mode for no
   * benefit (same reasoning as Awin's cread.php construction).
   *
   * `programmeId` here must be the programme's UNIQUE CODE (not its numeric id);
   * the affiliate unique code is captured at login. We log in (cheaply, cached)
   * to obtain the affiliate code if it is not already cached.
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
          message: '2Performant quicklinks require the programme unique code.',
          hint:
            'Pass `programmeId` as the programme unique code. Use affiliate_2performant_list_programmes ' +
            'and read the unique code from rawNetworkData for the merchant you want to link to.',
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

    // Ensure we have the affiliate unique code; the session login captures it.
    let affCode = getCachedAffiliateCode();
    if (!affCode) {
      await getSession();
      affCode = getCachedAffiliateCode();
    }
    if (!affCode) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'auth_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: '2Performant sign-in did not return an affiliate unique code; cannot build a quicklink.',
          hint: 'Confirm the account is an affiliate (publisher) account, then retry.',
        }),
      );
    }

    // Rewrite the `api` host segment to `event` (api.2performant.com →
    // event.2performant.com), matching the PHP reference wrapper's quicklink host.
    const eventHost = TWOPERFORMANT_BASE_URL.replace(
      /^(https?:\/\/)api(\.[^/]*2performant\.com)/,
      '$1event$2',
    );
    const trackingUrl =
      `${eventHost}/events/click` +
      `?ad_type=quicklink` +
      `&aff_code=${encodeURIComponent(affCode)}` +
      `&unique=${encodeURIComponent(input.programmeId)}` +
      `&redirect_to=${encodeURIComponent(input.destinationUrl)}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: '2performant events/click quicklink deterministic construction',
        ad_type: 'quicklink',
        aff_code: affCode,
        unique: input.programmeId,
        redirect_to: input.destinationUrl,
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth`, which performs the session login. A
   * successful sign-in proves the credentials and caches the session.
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

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>, note?: string): Promise<void> => {
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

    operations['listClicks'] = {
      supported: false,
      note: CLICKS_LIMITATION,
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic quicklink construction; requires the programme unique code.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Requires a known programme id or slug; not probed automatically.',
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
// Module-level registration (see Awin adapter.ts for the aggregator rationale).
// ---------------------------------------------------------------------------

export const twoPerformantAdapter = new TwoPerformantAdapter();
registerAdapter(twoPerformantAdapter);

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
 * Map a canonical transaction status to the 2Performant API `filter[status]`
 * value. Only used when exactly one status is requested (server-side narrowing).
 * 'other' has no API equivalent, so we return undefined and let the client-side
 * filter handle it.
 */
function toApiStatus(s: TransactionStatus): string | undefined {
  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'accepted';
    case 'reversed':
      return 'rejected';
    case 'paid':
      return 'paid';
    default:
      return undefined;
  }
}

/**
 * Build the `filter[date]` value from an ISO from/to window.
 *
 * 2Performant expects a `YYYY-MM-DD,YYYY-MM-DD` comma range on the commission
 * date filter (verify per tenant — flagged in known_limitations as part of the
 * "built from docs" caveat). Returns undefined when neither bound is supplied.
 */
function buildDateFilter(from?: string, to?: string): string | undefined {
  const f = isoDateOnly(from);
  const t = isoDateOnly(to);
  if (!f && !t) return undefined;
  return `${f ?? ''},${t ?? ''}`;
}

function isoDateOnly(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString().slice(0, 10);
}

/** True when the error is (or wraps) a 401 — the re-login trigger. */
function isAuthError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status === 401;
  if (err instanceof NetworkError) {
    return err.envelope.type === 'auth_error' && err.envelope.httpStatus === 401;
  }
  return false;
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapCommissionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  buildDateFilter,
  toApiStatus,
  isAuthError,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
