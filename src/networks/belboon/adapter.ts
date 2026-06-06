/**
 * Belboon adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * and `src/networks/everflow/adapter.ts`. Read those (and their header
 * comments) before modifying this one. The non-obvious Belboon-specific
 * decisions are documented inline with "why" comments.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Belboon runs on the Ingenious Technologies platform. The publisher API is the
 * "export file" interface, NOT a JSON REST API:
 *
 *   Auth:    Magic Key (UUID) in the URL path + numeric user id in the file
 *            name. No Authorization header. See `client.ts`.
 *   Base:    https://export.net.belboon.com  (per-tenant; overridable via
 *            BELBOON_EXPORT_HOST).
 *   Format:  CSV (also XLS/XML). No JSON. The client parses CSV to row objects.
 *   Docs:    https://faq.belboon.com/en/knowledge-base/tag/api/
 *
 * --- Export (endpoint) map --------------------------------------------------
 *
 *   GET  /<key>/adm-merchantexport_<userId>.csv[?products=true]
 *     → advertisers / programmes the partner can work with (partnerships).
 *   GET  /<key>/adm-conversionexport_<userId>.csv?filter[from_date]=DD.MM.YYYY&filter[to_date]=DD.MM.YYYY
 *     → conversions (sales + leads). status open|confirmed|rejected.
 *   GET  /<key>/statsdaily_<userId>.csv?filter[...]
 *     → aggregated daily stats (clicks/views/sales totals — NOT click-level).
 *
 * --- Status mapping ---------------------------------------------------------
 *
 *   Conversion status (per FAQ "Conversions export file", 2026-06-05):
 *     open      → pending
 *     confirmed → approved
 *     rejected / cancelled → reversed
 *   The platform also encodes status numerically in some exports
 *   (1=open, 2=confirmed, 3=rejected); we read both.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `belboonRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to canonical set. Prefer `unknown`/`other` over
 *      a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Honesty note -----------------------------------------------------------
 *
 * The export-URL SHAPE is verified from public sources, but the exact COLUMN
 * NAMES of each export are dashboard-gated and have NOT been confirmed against
 * a live account. Every transformer therefore reads several candidate column
 * names and falls back to `unknown`/`0` rather than guessing. The verbatim CSV
 * row is preserved on `rawNetworkData` so an operator can correct the mapping.
 */

import { belboonRequest, type BelboonRow } from './client.js';
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('belboon.adapter');

const SLUG = 'belboon';
const NAME = 'Belboon';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  // Per-tenant export host; overridable via BELBOON_EXPORT_HOST. See client.ts.
  baseUrl: 'https://export.net.belboon.com',
  // Magic Key in the URL path + user id in the file name; no header scheme.
  authModel: 'custom',
  docsUrl: 'https://faq.belboon.com/en/knowledge-base/tag/api/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: built from public docs; the export column shapes are
  // dashboard-gated and unverified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Belboon exposes only aggregated daily stats, not click-level events, via the publisher export API; listClicks is unsupported.',
    'Monetary amounts are assumed to be major currency units (e.g. euros), as the export interface does not document a minor-unit encoding; verify against a live account.',
    'The export API serves CSV/XLS/XML (no JSON), and the exact export column names are dashboard-gated and unverified; transformers read candidate column names defensively and preserve the raw row.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Export endpoints generate a file server-side and can be slow for wide date
 * windows. Give the reporting ops a 60s timeout and 3 retries, matching the
 * pattern established by Awin's and Everflow's reporting calls.
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
// Belboon export name constants
// ---------------------------------------------------------------------------

const EXPORT_MERCHANTS = 'adm-merchantexport';
const EXPORT_CONVERSIONS = 'adm-conversionexport';

// ---------------------------------------------------------------------------
// Conversion window cap
// ---------------------------------------------------------------------------
//
// The export interface does not document a hard per-call date cap, but very
// wide windows risk server-side timeouts on the file generation. We chunk into
// 92-day (~quarter) slices so a year-long query stays responsive without the
// caller hitting an opaque timeout. This mirrors the chunking affordance Awin
// needs for its hard 31-day cap.
const CONVERSION_CHUNK_DAYS = 92;

// ---------------------------------------------------------------------------
// Helpers — credential reads
// ---------------------------------------------------------------------------

function requireMagicKey(operation: string): string {
  return requireCredential('BELBOON_MAGIC_KEY', {
    network: SLUG,
    operation,
    hint: 'Find the Magic Key in the Belboon dashboard under Settings → API, then set BELBOON_MAGIC_KEY.',
  });
}

function requireUserId(operation: string): string {
  return requireCredential('BELBOON_USER_ID', {
    network: SLUG,
    operation,
    hint: 'Set BELBOON_USER_ID to your numeric Belboon partner/user id (shown in the dashboard under Account).',
  });
}

// ---------------------------------------------------------------------------
// Helpers — defensive CSV field reads
// ---------------------------------------------------------------------------

/**
 * Read the first non-empty value among several candidate column names.
 *
 * The export column set is dashboard-gated and unverified, so we never assume a
 * single canonical header. Candidate names are matched case-insensitively and
 * ignoring non-alphanumeric characters, so `advertiser_id`, `AdvertiserID`, and
 * `advertiser id` all match the candidate `advertiserid`.
 */
function readField(row: BelboonRow, candidates: string[]): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(candidates.map(norm));
  for (const [k, v] of Object.entries(row)) {
    if (wanted.has(norm(k)) && v !== undefined && v.trim() !== '') {
      return v.trim();
    }
  }
  return undefined;
}

/**
 * Parse a Belboon money string into a number.
 *
 * Ingenious CSV exports commonly use German number formatting ("1.234,56").
 * We strip thousands separators and normalise the decimal comma. ASSUMPTION:
 * the value is in MAJOR currency units (euros), not minor units — the export
 * interface does not document a minor-unit encoding. Flagged as a known
 * limitation; verify against a live account.
 */
function parseAmount(value: string | undefined): number {
  if (value === undefined) return 0;
  let s = value.trim();
  if (s === '') return 0;
  // If both separators are present, the LAST one is the decimal separator.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // German: dot = thousands, comma = decimal.
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // English: comma = thousands, dot = decimal.
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Only commas — treat the last as decimal.
    s = s.replace(/,/g, '.');
  }
  // Strip any remaining non-numeric characters (currency symbols, spaces).
  s = s.replace(/[^0-9.-]/g, '');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a Belboon date string to an ISO timestamp.
 *
 * Ingenious exports use `DD.MM.YYYY` or `DD.MM.YYYY HH:mm:ss`; some columns may
 * be ISO already. We handle both and return undefined for anything unparseable
 * rather than fabricating a date.
 */
function parseBelboonDateIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (s === '') return undefined;

  // DD.MM.YYYY [HH:mm[:ss]]
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const iso = `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}T${(hh ?? '00').padStart(2, '0')}:${mi ?? '00'}:${ss ?? '00'}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Format a Date as Belboon's `DD.MM.YYYY` filter value. */
function formatBelboonDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/**
 * Conversion status: Belboon → canonical TransactionStatus.
 *
 * Belboon conversions are open | confirmed | rejected (FAQ "Conversions export
 * file", 2026-06-05). The platform also encodes the status numerically in some
 * exports: 1 = open, 2 = confirmed, 3 = rejected. We read both. "cancelled" is
 * accepted as an alias for rejected.
 *
 *   open / 1                  → pending
 *   confirmed / 2             → approved
 *   rejected / cancelled / 3  → reversed
 *   anything else             → other
 */
function mapTransactionStatus(rawStatus: string | undefined): TransactionStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (s === 'open' || s === '1') return 'pending';
  if (s === 'confirmed' || s === 'accepted' || s === '2') return 'approved';
  if (s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'declined' || s === '3')
    return 'reversed';
  return 'other';
}

/**
 * Programme/partnership status: Belboon → canonical ProgrammeStatus.
 *
 * The merchant/partnership export encodes the partner's relationship to each
 * programme. The exact values are dashboard-gated; we map the documented and
 * commonly-seen Ingenious states and fall back to `unknown`.
 *
 *   active / accepted / confirmed / partnership → joined
 *   pending / requested / waiting               → pending
 *   rejected / declined / cancelled             → declined
 *   open / available / not member               → available
 *   paused / suspended / inactive               → suspended
 *   anything else                               → unknown
 */
function mapProgrammeStatus(rawStatus: string | undefined): ProgrammeStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (['active', 'accepted', 'confirmed', 'partnership', 'joined', 'member'].includes(s))
    return 'joined';
  if (['pending', 'requested', 'waiting', 'applied'].includes(s)) return 'pending';
  if (['rejected', 'declined', 'cancelled', 'canceled', 'refused'].includes(s)) return 'declined';
  if (['open', 'available', 'notmember', 'not_member', 'free'].includes(s)) return 'available';
  if (['paused', 'suspended', 'inactive', 'stopped', 'closed'].includes(s)) return 'suspended';
  return 'unknown';
}

function computeAgeDays(anchorIso: string | undefined, now: Date = new Date()): number {
  if (!anchorIso) return 0;
  const t = Date.parse(anchorIso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers (Belboon CSV row → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(row: BelboonRow): Programme {
  const id =
    readField(row, [
      'advertiser_program_id',
      'program_id',
      'programid',
      'programme_id',
      'advertiser_id',
      'advertiserid',
      'merchant_id',
      'id',
    ]) ?? '';
  const name =
    readField(row, ['advertiser_name', 'program_name', 'programme_name', 'merchant_name', 'name', 'advertiser']) ??
    (id ? `Belboon programme ${id}` : 'Belboon programme');
  const status = mapProgrammeStatus(
    readField(row, ['partnership_status', 'status', 'relationship', 'program_status', 'membership_status']),
  );
  const currency = readField(row, ['currency', 'currencycode', 'currency_code']);
  const categories = readField(row, ['category', 'categories', 'sector', 'industry']);
  const url = readField(row, ['url', 'advertiser_url', 'homepage', 'website', 'target_url']);
  const commission = readField(row, ['commission', 'commission_text', 'payment', 'payout', 'commission_rate']);

  return {
    id,
    name,
    network: SLUG,
    status,
    currency,
    commissionRate: commission ? { type: 'unknown', description: commission } : undefined,
    categories: categories ? [categories] : [],
    advertiserUrl: url,
    rawNetworkData: row,
  };
}

function toTransaction(row: BelboonRow, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(
    readField(row, ['status', 'conversion_status', 'commission_status', 'state']),
  );

  const commission = parseAmount(
    readField(row, ['commission', 'commission_amount', 'payout', 'partner_commission', 'commission_value']),
  );
  const amount = parseAmount(
    readField(row, ['amount', 'order_value', 'basket_value', 'sale_amount', 'turnover', 'net_value', 'value']),
  );
  const currency = readField(row, ['currency', 'currencycode', 'currency_code']) ?? 'EUR';

  const programmeId =
    readField(row, [
      'advertiser_program_id',
      'program_id',
      'programid',
      'advertiser_id',
      'advertiserid',
      'merchant_id',
    ]) ?? '';
  const programmeName =
    readField(row, ['advertiser_name', 'program_name', 'programme_name', 'merchant_name', 'advertiser']) ??
    (programmeId ? `Belboon programme ${programmeId}` : '');

  const dateConvertedIso =
    parseBelboonDateIso(
      readField(row, ['conversion_date', 'event_date', 'transaction_date', 'date', 'created', 'tracking_date']),
    ) ?? new Date(0).toISOString();
  const dateClickedIso = parseBelboonDateIso(readField(row, ['click_date', 'click_time', 'clickdate']));
  const dateApprovedIso = parseBelboonDateIso(
    readField(row, ['confirmation_date', 'confirmed_date', 'modification_date', 'status_date']),
  );

  const id = readField(row, ['conversion_id', 'event_id', 'transaction_id', 'tracking_id', 'id']) ?? '';

  return {
    id,
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount,
    currency,
    commission,
    dateClicked: dateClickedIso,
    dateConverted: dateConvertedIso,
    dateApproved: status === 'approved' ? dateApprovedIso ?? dateConvertedIso : dateApprovedIso,
    // The export interface does not expose a publisher-payment date on the
    // conversion record; leave undefined rather than fabricating.
    datePaid: undefined,
    ageDays: computeAgeDays(dateApprovedIso ?? dateConvertedIso, now),
    reversalReason:
      status === 'reversed'
        ? readField(row, ['reason', 'rejection_reason', 'cancellation_reason', 'status_reason'])
        : undefined,
    rawNetworkData: row,
  };
}

// ---------------------------------------------------------------------------
// Date chunking
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

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

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class BelboonAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the advertiser programmes (partnerships) visible to this partner.
   *
   * Belboon export: GET /<key>/adm-merchantexport_<userId>.csv
   *   Returns one row per advertiser/programme. The export interface does not
   *   offer a server-side free-text search, so search/status/category filters
   *   are applied client-side after parsing the CSV.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const magicKey = requireMagicKey('listProgrammes');
    const userId = requireUserId('listProgrammes');

    const rows = await belboonRequest({
      operation: 'listProgrammes',
      exportName: EXPORT_MERCHANTS,
      magicKey,
      userId,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = rows.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.advertiserUrl ?? '').toLowerCase().includes(needle),
      );
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
   * Fetch a single programme by id.
   *
   * The Belboon merchant export does not expose a per-programme endpoint, so we
   * fetch the merchant export and select the matching row client-side. This is
   * the same export `listProgrammes` uses; correctness first, optimise later.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A programme id is required.',
          hint: 'Use affiliate_belboon_list_programmes to discover valid programme ids.',
        }),
      );
    }

    const magicKey = requireMagicKey('getProgramme');
    const userId = requireUserId('getProgramme');

    const rows = await belboonRequest({
      operation: 'getProgramme',
      exportName: EXPORT_MERCHANTS,
      magicKey,
      userId,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    const programmes = rows.map(toProgramme);
    const match = programmes.find((p) => p.id === programmeId.trim());

    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Belboon programme with id "${programmeId}" was found in the merchant export.`,
          hint: 'Use affiliate_belboon_list_programmes to confirm the id; the partner may not have a partnership with this advertiser.',
        }),
      );
    }

    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversions (sales + leads) over a date window.
   *
   * Belboon export: GET /<key>/adm-conversionexport_<userId>.csv
   *   ?filter[from_date]=DD.MM.YYYY&filter[to_date]=DD.MM.YYYY
   *
   * Default window: last 30 days. Wide windows are chunked into ~quarter slices
   * (see CONVERSION_CHUNK_DAYS) to avoid opaque server-side timeouts on large
   * file generation. Status / age / programme filters are applied client-side
   * (PRD §15.9 unpaid-age affordance; §15.10 reversed visibility).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const magicKey = requireMagicKey('listTransactions');
    const userId = requireUserId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, CONVERSION_CHUNK_DAYS);

    const allRows: BelboonRow[] = [];
    for (const slice of slices) {
      const rows = await belboonRequest({
        operation: 'listTransactions',
        exportName: EXPORT_CONVERSIONS,
        magicKey,
        userId,
        filters: {
          from_date: formatBelboonDate(slice.start),
          to_date: formatBelboonDate(slice.end),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRows.push(...rows);
    }

    let transactions = allRows.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status as TransactionStatus | TransactionStatus[]);
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
   * Aggregate the conversion export into an earnings summary.
   *
   * Derived from `listTransactions` for the same reason as Awin/Everflow: the
   * per-transaction `ageDays` is needed for `oldestUnpaidAgeDays`, so deriving
   * from the conversions keeps the summary auditable (the user can recompute it
   * from `listTransactions`).
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
      // Belboon is a DACH network; default EUR until a transaction tells us otherwise.
      currency: 'EUR',
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
          programmeName: t.programmeName || `Belboon programme ${key}`,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid (pending or approved-but-not-paid).
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
      currency: firstCurrency ?? 'EUR',
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
   * Belboon's publisher export API exposes only AGGREGATED daily stats (the
   * `statsdaily` export reports click/view/sale TOTALS per day), not individual
   * click events with timestamp/referrer/destination. There is no documented
   * click-level export for publishers.
   *
   * We throw `NotImplementedError` rather than returning aggregate totals shaped
   * as fake per-click rows — the difference between "no click events available"
   * and "here are some invented rows" is exactly the honesty principle (4.1).
   * If a click-level export is confirmed against a live account, this becomes a
   * real implementation and the known-limitation line is dropped.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Belboon exposes only aggregated daily stats, not click-level events, via the publisher export API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Belboon deep-link.
   *
   * Belboon's tracking links follow the documented form (public sources,
   * 2026-06-05):
   *
   *   https://www1.belboon.de/tracking/<programmeId>.html?deeplink=<encoded URL>
   *
   * where `<programmeId>` is the tracking/ad id for the partnership and
   * `deeplink` carries the URL-encoded merchant target. (Belboon also supports a
   * `subid=` form inserted as a path segment; we omit the sub-id here.)
   *
   * Why deterministic construction rather than an API call: the deep-link scheme
   * is documented and stable, and the export interface offers no link-generation
   * endpoint. Every property of the resulting URL is known at call time.
   *
   * NOTE (unverified): the host and exact path shape are dashboard-gated and not
   * confirmed against a live account. The construction context is preserved on
   * `rawNetworkData` so an operator can see and correct it.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.programmeId || input.programmeId.trim() === '') {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'Belboon tracking links require the programme (tracking) id.',
          hint: 'Pass `programmeId`. Use affiliate_belboon_list_programmes to discover programme ids.',
        }),
      );
    }
    if (!input.destinationUrl || input.destinationUrl.trim() === '') {
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

    // We do not call Belboon here (deterministic construction), but we require
    // the credentials so a half-configured environment fails at link-build time
    // rather than at first click.
    requireMagicKey('generateTrackingLink');
    requireUserId('generateTrackingLink');

    const programmeId = input.programmeId.trim();
    const encoded = encodeURIComponent(input.destinationUrl);
    const trackingUrl = `https://www1.belboon.de/tracking/${encodeURIComponent(programmeId)}.html?deeplink=${encoded}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'belboon.de/tracking deterministic construction (unverified against a live account)',
        programmeId,
        deeplink: input.destinationUrl,
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
      note: 'Belboon exposes only aggregated daily stats, not click-level events, via the publisher export API',
    };

    // getProgramme + generateTrackingLink need a known programme id — record as
    // supported-without-probe to keep the diagnostic fast.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Selects from the merchant export by id; requires a known programme id, not probed automatically.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Deterministic URL construction (unverified against a live account); no live probe.',
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

export const belboonAdapter = new BelboonAdapter();
registerAdapter(belboonAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
// ---------------------------------------------------------------------------

export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  parseAmount,
  parseBelboonDateIso,
  formatBelboonDate,
  toProgramme,
  toTransaction,
  chunkDateRange,
  readField,
};

// Silence unused-import lint for the logger.
void log;
