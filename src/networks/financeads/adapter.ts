/**
 * financeAds adapter — publisher side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * (the canonical reference) and `src/networks/everflow/client.ts` (custom,
 * non-Bearer auth). Read the Awin file header before modifying this one.
 *
 * --- What financeAds is -----------------------------------------------------
 *
 * financeAds is a DACH (Germany / Austria / Switzerland) premium affiliate
 * network for the finance vertical (banks, insurance, real estate, tax). The
 * publisher API exposes, per public sources, three access areas:
 *   - sales / leads  (transactions)
 *   - merchants      (programmes / advertisers, a.k.a. "partnerships")
 *   - daily statistics
 * plus product data feeds (out of scope for this adapter).
 *
 * Auth:    API key + numeric user (publisher) ID, both sent as query params.
 * Base:    https://www.financeads.net
 * Amounts: EUR (the network is finance-vertical DACH; see ASSUMED_CURRENCY).
 * Docs:    https://strackr.com/docs/financeads (third-party; the canonical
 *          financeAds docs are gated behind the publisher dashboard).
 *
 * --- UNVERIFIED SHAPE WARNING -----------------------------------------------
 *
 * The exact endpoint paths, parameter names, response envelope, and response
 * format (JSON vs XML vs CSV) of the financeAds API could not be confirmed
 * against a live account at commit time — the documentation is dashboard-gated.
 * This adapter is written defensively from public descriptions:
 *   - every endpoint path carries a `// TODO(verify)` note;
 *   - every transformer reads keys defensively and preserves the verbatim
 *     payload on `rawNetworkData`;
 *   - the client surfaces a non-JSON body verbatim rather than guessing.
 * The adapter ships `experimental` until a live acceptance test is run.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `financeadsRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. The user-visible noun is "programme" not "program".
 */

import { financeadsRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireCredentials,
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

const log = createLogger('financeads.adapter');

const SLUG = 'financeads';
const NAME = 'financeAds';

/**
 * financeAds is a DACH finance-vertical network and reports in EUR. The API
 * response is not yet confirmed to carry a per-row currency code, so we assume
 * EUR and document the assumption. If a live account shows a currency field we
 * read it preferentially and drop this assumption.
 */
const ASSUMED_CURRENCY = 'EUR';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://www.financeads.net',
  // financeAds threads the API key + user ID through query params, not a
  // standard Authorization header. That is `custom` in our auth taxonomy.
  authModel: 'custom',
  docsUrl: 'https://strackr.com/docs/financeads',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public, partly dashboard-gated docs; not
  // verified against a live account. Bump to `partial`/`production` after a
  // live acceptance test.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public documentation; not yet verified against a live financeAds account.',
    'The financeAds API shape (endpoint paths, parameter names, JSON vs XML/CSV response) is partly dashboard-gated and needs live verification.',
    'Amounts are assumed to be in EUR; financeAds is a DACH finance-vertical network and the per-row currency field is not yet confirmed.',
    'Click-level data is not exposed via the financeAds publisher API; listClicks is unsupported.',
    'API access may require the publisher to request the "Leads & Sales API" from financeAds support before reporting calls succeed.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // Some accounts must have API access enabled by financeAds support before
  // reporting calls work. Flagged so the wizard warns up front.
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 2,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

/**
 * Reporting endpoints (sales/leads, statistics) can be slow over wide windows.
 * Match the Awin/Everflow pattern: 60s timeout, 3 retries.
 */
const REPORTING_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORTING_RESILIENCE,
  getEarningsSummary: REPORTING_RESILIENCE,
};

// ---------------------------------------------------------------------------
// financeAds raw response shapes (deliberately minimal — see Awin adapter for
// the rationale. All fields optional; transformers read defensively.)
// ---------------------------------------------------------------------------

/**
 * One merchant / programme record from the merchants endpoint.
 *
 * UNVERIFIED field names — best-effort from public descriptions. Common German
 * affiliate-network field aliases (`programm_id`, `programmname`) are read as
 * fallbacks alongside the English ones.
 */
interface FinanceadsProgrammeRaw {
  program_id?: number | string;
  programm_id?: number | string;
  id?: number | string;
  program_name?: string;
  programm_name?: string;
  programmname?: string;
  name?: string;
  status?: string; // e.g. active | paused | pending | rejected
  partnership?: string; // e.g. active | pending | rejected | open
  currency?: string;
  commission?: string | number;
  provision?: string | number; // German for "commission"
  category?: string;
  kategorie?: string;
  url?: string;
  website?: string;
}

/**
 * One sale or lead record from the sales/leads endpoint.
 *
 * UNVERIFIED field names. financeAds distinguishes "sales" and "leads"; both
 * are normalised into the canonical Transaction. Status values seen in public
 * descriptions: open, confirmed, cancelled (German: offen, bestätigt, storniert).
 */
interface FinanceadsTransactionRaw {
  transaction_id?: number | string;
  sale_id?: number | string;
  lead_id?: number | string;
  id?: number | string;
  program_id?: number | string;
  programm_id?: number | string;
  program_name?: string;
  programmname?: string;
  name?: string;
  // Status: open | confirmed | cancelled (and German equivalents).
  status?: string;
  // Money. financeAds amounts are assumed EUR (see ASSUMED_CURRENCY).
  amount?: number | string; // basket / order value
  order_value?: number | string;
  commission?: number | string; // publisher payout
  provision?: number | string; // German alias
  currency?: string;
  // Dates. UNVERIFIED format — could be ISO or `YYYY-MM-DD HH:mm:ss`.
  click_date?: string;
  date_click?: string;
  transaction_date?: string;
  date?: string;
  sale_date?: string;
  confirmed_date?: string;
  date_confirmed?: string;
  paid_date?: string;
  date_paid?: string;
  // Reversal context.
  cancel_reason?: string;
  reason?: string;
}

/** Envelope wrappers the API might use. We accept array or wrapped forms. */
interface FinanceadsProgrammesEnvelope {
  programs?: FinanceadsProgrammeRaw[];
  programme?: FinanceadsProgrammeRaw[];
  merchants?: FinanceadsProgrammeRaw[];
  data?: FinanceadsProgrammeRaw[];
}

interface FinanceadsTransactionsEnvelope {
  sales?: FinanceadsTransactionRaw[];
  leads?: FinanceadsTransactionRaw[];
  transactions?: FinanceadsTransactionRaw[];
  data?: FinanceadsTransactionRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstString(...vals: Array<string | number | undefined>): string | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return undefined;
}

function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // German number formats sometimes use a comma decimal separator.
    const normalised = v.replace(/\./g, '').replace(',', '.');
    const n = Number(normalised);
    if (Number.isFinite(n)) return n;
    const n2 = Number(v);
    return Number.isFinite(n2) ? n2 : 0;
  }
  return 0;
}

/**
 * Status normalisation: financeAds programme status → canonical ProgrammeStatus.
 *
 * UNVERIFIED enum. We map the partnership status preferentially (it describes
 * THIS publisher's relationship to the programme), falling back to the
 * programme's own status. German aliases are accepted:
 *   active / aktiv / confirmed / bestätigt           → 'joined'
 *   pending / wartend / requested / angefragt        → 'pending'
 *   rejected / abgelehnt / declined                  → 'declined'
 *   open / offen / available / verfügbar             → 'available'
 *   paused / pausiert / inactive / inaktiv / suspended → 'suspended'
 *   anything else                                    → 'unknown'
 */
function mapProgrammeStatus(raw: FinanceadsProgrammeRaw): ProgrammeStatus {
  const s = (raw.partnership ?? raw.status ?? '').toLowerCase();
  if (['active', 'aktiv', 'confirmed', 'bestätigt', 'joined', 'accepted'].includes(s)) {
    return 'joined';
  }
  if (['pending', 'wartend', 'requested', 'angefragt', 'review'].includes(s)) return 'pending';
  if (['rejected', 'abgelehnt', 'declined', 'refused'].includes(s)) return 'declined';
  if (['open', 'offen', 'available', 'verfügbar', 'notjoined'].includes(s)) return 'available';
  if (['paused', 'pausiert', 'inactive', 'inaktiv', 'suspended'].includes(s)) return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: financeAds sale/lead status → canonical TransactionStatus.
 *
 * financeAds reports sales and leads with an open / confirmed / cancelled
 * lifecycle (German: offen / bestätigt / storniert). We normalise:
 *   open / offen / pending / new            → 'pending'
 *   confirmed / bestätigt / approved / accepted → 'approved'
 *   cancelled / canceled / storniert / rejected / declined → 'reversed'
 *   paid / bezahlt / payed                   → 'paid'
 *   anything else                            → 'other'
 *
 * Why no direct 'paid' assumption: financeAds' lifecycle centres on confirmation;
 * a separate paid state may or may not be exposed. We map it when present and
 * otherwise leave confirmed-but-unpaid as 'approved' (the unpaid-age affordance
 * treats pending + approved as "unpaid").
 */
function mapTransactionStatus(raw: FinanceadsTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (['open', 'offen', 'pending', 'new', 'neu'].includes(s)) return 'pending';
  if (['confirmed', 'bestätigt', 'approved', 'accepted', 'akzeptiert'].includes(s)) {
    return 'approved';
  }
  if (['cancelled', 'canceled', 'storniert', 'rejected', 'declined', 'abgelehnt'].includes(s)) {
    return 'reversed';
  }
  if (['paid', 'bezahlt', 'payed', 'ausgezahlt'].includes(s)) return 'paid';
  return 'other';
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age in days of a transaction at the moment the adapter responded
 * (PRD §15.9). We anchor on the confirmation date when present, else the
 * conversion/sale date. UNVERIFIED date field names; read several candidates.
 */
function computeAgeDays(raw: FinanceadsTransactionRaw, now: Date = new Date()): number {
  const anchor =
    raw.confirmed_date ??
    raw.date_confirmed ??
    raw.transaction_date ??
    raw.sale_date ??
    raw.date;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: FinanceadsProgrammeRaw): Programme {
  const id = firstString(raw.program_id, raw.programm_id, raw.id) ?? '';
  const name =
    firstString(raw.program_name, raw.programm_name, raw.programmname, raw.name) ??
    `financeAds programme ${id}`;
  const commission = raw.commission ?? raw.provision;
  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? ASSUMED_CURRENCY,
    commissionRate:
      commission !== undefined
        ? { type: 'unknown', description: String(commission) }
        : undefined,
    categories: [raw.category ?? raw.kategorie].filter((c): c is string => typeof c === 'string'),
    advertiserUrl: raw.url ?? raw.website,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: FinanceadsTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.commission ?? raw.provision);
  const amount = toNumber(raw.amount ?? raw.order_value);
  const currency = raw.currency ?? ASSUMED_CURRENCY;

  const dateConverted =
    nullableIso(raw.transaction_date ?? raw.sale_date ?? raw.date) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.click_date ?? raw.date_click);
  const dateApproved = nullableIso(raw.confirmed_date ?? raw.date_confirmed);
  const datePaid = nullableIso(raw.paid_date ?? raw.date_paid);

  return {
    id: firstString(raw.transaction_id, raw.sale_id, raw.lead_id, raw.id) ?? '',
    network: SLUG,
    programmeId: firstString(raw.program_id, raw.programm_id) ?? '',
    programmeName: firstString(raw.program_name, raw.programmname, raw.name) ?? '',
    status,
    amount,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — surface a reversal reason where financeAds provides one.
    reversalReason:
      status === 'reversed' ? (raw.cancel_reason ?? raw.reason ?? undefined) : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date for financeAds reporting date params.
 *
 * UNVERIFIED: we send `YYYY-MM-DD` (date-only), the most widely accepted form
 * across affiliate reporting APIs. A future contributor confirming a
 * timestamped form can adjust here.
 */
function formatFinanceadsDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. financeAds is not documented to
 * cap the reporting window, but we chunk defensively (mirroring Awin) so a wide
 * window does not silently truncate if an undocumented cap exists. Returns at
 * least one slice.
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

function extractProgrammes(env: FinanceadsProgrammesEnvelope | FinanceadsProgrammeRaw[]): FinanceadsProgrammeRaw[] {
  if (Array.isArray(env)) return env;
  return env.programs ?? env.programme ?? env.merchants ?? env.data ?? [];
}

function extractTransactions(
  env: FinanceadsTransactionsEnvelope | FinanceadsTransactionRaw[],
): FinanceadsTransactionRaw[] {
  if (Array.isArray(env)) return env;
  return [
    ...(env.sales ?? []),
    ...(env.leads ?? []),
    ...(env.transactions ?? []),
    ...(env.data ?? []),
  ];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class FinanceadsAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List financeAds merchants / programmes (a.k.a. partnerships) visible to
   * this publisher.
   *
   * UNVERIFIED endpoint: `/api/merchant`. We fetch the full list and apply
   * client-side search / status / category / limit filters, mirroring Awin.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const { apiKey, userId } = requireCredentials('listProgrammes');

    const raw = await financeadsRequest<FinanceadsProgrammesEnvelope | FinanceadsProgrammeRaw[]>({
      operation: 'listProgrammes',
      // TODO(verify): confirm the merchants endpoint path against a live account.
      path: '/api/merchant',
      apiKey,
      userId,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = extractProgrammes(raw).map(toProgramme);

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
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Fetch a single programme by ID.
   *
   * financeAds is not documented to expose a single-programme endpoint
   * distinct from the merchants list, so we fetch the list and select the
   * matching id client-side. An unknown id surfaces as a network_api_error
   * envelope rather than a fabricated stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `financeAds programme IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_financeads_list_programmes to discover valid programme IDs.',
        }),
      );
    }

    const { apiKey, userId } = requireCredentials('getProgramme');

    const raw = await financeadsRequest<FinanceadsProgrammesEnvelope | FinanceadsProgrammeRaw[]>({
      operation: 'getProgramme',
      // TODO(verify): confirm whether financeAds supports a single-merchant
      // lookup (e.g. `?program_id=`). For now we filter the list defensively.
      path: '/api/merchant',
      apiKey,
      userId,
      query: { program_id: programmeId },
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const match = extractProgrammes(raw)
      .map(toProgramme)
      .find((p) => p.id === programmeId);

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `financeAds returned no programme matching id "${programmeId}".`,
          hint: 'Confirm the id with affiliate_financeads_list_programmes; you may not have a partnership with this merchant.',
        }),
      );
    }

    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List sales and leads across a date window with optional status / age /
   * programme filters.
   *
   * UNVERIFIED endpoint: `/api/sale`. Default window is the last 30 days. We
   * chunk into ≤90-day slices defensively (financeAds is not documented to cap
   * the window, but an undocumented cap would otherwise truncate silently).
   *
   * --- PRD §15.9: unpaid-age filter ---
   * `query.minAgeDays` returns only transactions whose computed `ageDays` is
   * >= the threshold; applied AFTER status filtering.
   *
   * --- PRD §15.10: reversed-sale visibility ---
   * Cancelled sales/leads (status `cancelled`/`storniert`) are returned with
   * `reversalReason` populated where financeAds provides one.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const { apiKey, userId } = requireCredentials('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 90);

    const allRaw: FinanceadsTransactionRaw[] = [];
    for (const slice of slices) {
      const env = await financeadsRequest<
        FinanceadsTransactionsEnvelope | FinanceadsTransactionRaw[]
      >({
        operation: 'listTransactions',
        // TODO(verify): confirm the sales/leads endpoint path and date param
        // names against a live account.
        path: '/api/sale',
        apiKey,
        userId,
        query: {
          date_start: formatFinanceadsDate(slice.start),
          date_end: formatFinanceadsDate(slice.end),
          // financeAds may scope sales to a single programme server-side; pass
          // it where supplied. Client-side filter below covers the rest.
          program_id: query?.programmeId,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...extractTransactions(env));
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status);
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
   * Aggregate sales/leads into an earnings summary, derived from
   * `listTransactions` for the same reason as Awin: the per-transaction
   * `ageDays` is not available from a summary endpoint, and deriving keeps the
   * figures auditable (the user can recompute from listTransactions).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    const txns = await this.listTransactions({
      ...query,
      from,
      to,
      limit: undefined, // never apply a limit inside a summary — would undercount
    });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: ASSUMED_CURRENCY,
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
          programmeName: t.programmeName || `financeAds programme ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved).
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
      currency: firstCurrency ?? ASSUMED_CURRENCY,
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
   * financeAds does not expose click-level data via its publisher API. We
   * throw `NotImplementedError` deliberately rather than returning an empty
   * array — "financeAds returned no clicks" and "financeAds has no click API"
   * are different facts (principle 4.1).
   *
   * If financeAds adds a click endpoint later this becomes a real
   * implementation and we drop the corresponding `knownLimitations` line.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'financeAds does not expose click-level data via the publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a financeAds deep link.
   *
   * Documented format (confirmed via public sources, e.g. strackr.com/subid):
   *
   *   https://www.financeads.net/tc.php
   *     ?t={trackingId}          ← per-programme tracking token (e.g. "123C123T")
   *     &subid={subId}           ← optional
   *     &deep={destinationUrl}   ← target URL (URL-encoded)
   *
   * IMPORTANT / UNVERIFIED: the `t=` value is NOT a plain numeric programme id.
   * financeAds issues a per-programme tracking token (the `123C123T` shape) that
   * encodes publisher + programme. We pass `input.programmeId` through as the
   * `t` value, which is correct only if the caller supplies that token. A
   * future contributor with live access should confirm whether the token can be
   * derived from (userId, programmeId) or must be read from the dashboard, and
   * adjust the validation/derivation accordingly.
   *
   * Deterministic construction (no API call) is preferred where the scheme is
   * documented and stable, mirroring Awin.
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
          message:
            'financeAds tracking links require the programme tracking token (the `t` value).',
          hint:
            'Pass `programmeId` as the financeAds tracking token (e.g. "123C123T") shown for the ' +
            'programme in the financeAds platform. This token is not the same as a plain numeric programme id.',
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

    // Sanity-check that credentials are configured so a half-configured
    // environment fails at link-generation time, not at first click.
    requireCredentials('generateTrackingLink');

    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl =
      `https://www.financeads.net/tc.php` +
      `?t=${encodeURIComponent(input.programmeId)}` +
      `&deep=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'financeads.net/tc.php deterministic construction (UNVERIFIED token shape)',
        t: input.programmeId,
        deep: input.destinationUrl,
      },
    };
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
  // Admin operations (NotImplementedError — v0.2 scaffolds)
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
          claimStatus: 'experimental',
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
      note: 'financeAds does not expose click-level data via the publisher API',
    };

    // generateTrackingLink is deterministic but needs the programme tracking
    // token; getProgramme needs a known id. Record without probing.
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Deterministic URL construction; requires the programme tracking token. Not probed.',
    };
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known programme id; not probed automatically.',
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

export const financeadsAdapter = new FinanceadsAdapter();
registerAdapter(financeadsAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported under `_internals` so they do not appear on
// the public adapter surface.
// ---------------------------------------------------------------------------

export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  chunkDateRange,
  formatFinanceadsDate,
  toNumber,
  extractProgrammes,
  extractTransactions,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
