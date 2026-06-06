/**
 * Effiliation adapter — publisher side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`.
 * Read that file and its header comments before modifying this one.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Effiliation is the long-standing French network operated by Effinity. The
 * legacy publisher API lives at host `apiv2.effiliation.com` under `/apiv2/`.
 *
 * Auth:   single API key on the `key` query-string parameter (no header).
 * Base:   https://apiv2.effiliation.com
 * Docs:   https://apiv2.effiliation.com/apiv2/doc/home.htm
 *
 * --- Endpoint map -----------------------------------------------------------
 *
 *   GET /apiv2/programs.json?key=...
 *     → programmes the publisher works with (the publisher's affiliations).
 *   GET /apiv2/transaction.json?key=...&start=DD/MM/YYYY&end=DD/MM/YYYY&type=date
 *     → transactions (sales / leads). The data is refreshed roughly every two
 *       hours upstream, so very recent conversions may not yet appear.
 *
 * Each resource is also available as `.xml` / `.csv`; we only ask for JSON.
 * Endpoints support a `fields=` mask to choose columns — we do not use it, so
 * we receive the default column set and read it defensively.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `effiliationRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * Effiliation is a euro-denominated French network and the transaction
 * endpoint returns amounts as plain decimal numbers (major units, e.g. 12.50
 * meaning €12.50), NOT integer minor units. We treat them as major units and
 * default the currency to EUR when the payload omits it. This is an assumption
 * pending live verification — the verbatim payload is always on rawNetworkData
 * so a user can confirm.
 *
 * --- Known limitations ------------------------------------------------------
 *
 *   - Adapter built from public API documentation; not yet verified against a
 *     live account.
 *   - Click-level data is not exposed via the publisher transaction/programme
 *     API; listClicks is unsupported.
 *   - Tracking-link (deeplink) construction is not deterministically documented
 *     for the publisher; generateTrackingLink is unsupported.
 *   - Transaction data is refreshed roughly every two hours upstream, so very
 *     recent conversions may be missing.
 */

import { effiliationRequest } from './client.js';
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

const log = createLogger('effiliation.adapter');

const SLUG = 'effiliation';
const NAME = 'Effiliation';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://apiv2.effiliation.com',
  // Effiliation uses an API key on the query string, not a standard scheme.
  authModel: 'custom',
  docsUrl: 'https://apiv2.effiliation.com/apiv2/doc/home.htm',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Click-level data is not exposed via the publisher API; listClicks is unsupported.',
    'Tracking-link (deeplink) construction is not deterministically documented for the publisher; generateTrackingLink is unsupported.',
    'Transaction amounts are assumed to be major currency units (e.g. 12.50 = €12.50) in EUR; not yet confirmed against a live account.',
    'Transaction data is refreshed roughly every two hours upstream, so very recent conversions may be missing.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * The transaction report can be slow for a wide date window. Give the
 * transaction-backed ops a 60s timeout and 3 retries, matching the pattern
 * established by Awin's listTransactions.
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
// Effiliation raw response shapes (deliberately minimal — see Awin for rationale)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of one programme record from GET /apiv2/programs.json.
 *
 * Effiliation field names are not strictly documented for JSON; we read the
 * common identifier/name/status keys defensively and keep the verbatim payload
 * on rawNetworkData. The endpoint returns programmes the publisher works with,
 * so `status` typically reflects the affiliation state.
 */
interface EffiliationProgrammeRaw {
  id?: number | string;
  id_programme?: number | string;
  programme_id?: number | string;
  // Merchant identifier ("affilieur") — present on some column sets.
  id_affilieur?: number | string;
  name?: string;
  nom?: string;
  // Affiliation / programme status. French and English variants both appear.
  status?: string;
  statut?: string;
  // Commission descriptor — free text or a numeric rate depending on column set.
  commission?: string | number;
  remuneration?: string | number;
  devise?: string;
  currency?: string;
  url?: string;
  site_url?: string;
  category?: string;
  categorie?: string;
}

/**
 * Minimal shape of one transaction record from GET /apiv2/transaction.json.
 *
 * Effiliation reports sales and leads. Field names vary with the `fields=`
 * mask; we read both French and English candidates. Amounts are decimal major
 * units (see the file-level amount-unit note).
 */
interface EffiliationTransactionRaw {
  id?: number | string;
  id_transaction?: number | string;
  transaction_id?: number | string;
  // Programme / merchant identity.
  id_programme?: number | string;
  programme_id?: number | string;
  id_affilieur?: number | string;
  programme?: string;
  programme_nom?: string;
  // Status of the transaction (en attente / valide / refuse / paye, or English).
  status?: string;
  statut?: string;
  etat?: string;
  // Sale amount and commission. `montant` is the order value; `commission` the
  // publisher's earnings. Both are decimal major units.
  montant?: number | string;
  amount?: number | string;
  commission?: number | string;
  montant_commission?: number | string;
  devise?: string;
  currency?: string;
  // Dates. Effiliation uses DD/MM/YYYY (sometimes with HH:mm:ss). Field names
  // vary; we read click/transaction/validation candidates.
  date?: string;
  date_transaction?: string;
  date_clic?: string;
  date_click?: string;
  date_validation?: string;
  date_paiement?: string;
  // Reversal context for refused/cancelled transactions.
  motif?: string;
  raison?: string;
  reason?: string;
}

/**
 * The programmes / transaction endpoints may return either a bare array or an
 * envelope wrapping the rows under a named key. We accept both.
 */
type EffiliationProgrammesResponse =
  | EffiliationProgrammeRaw[]
  | { programs?: EffiliationProgrammeRaw[]; programmes?: EffiliationProgrammeRaw[] };

type EffiliationTransactionsResponse =
  | EffiliationTransactionRaw[]
  | { transactions?: EffiliationTransactionRaw[]; transaction?: EffiliationTransactionRaw[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(operation: string): string {
  return requireCredential('EFFILIATION_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Effiliation API key under My account → Personal data → Credentials, ' +
      'then set EFFILIATION_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

/** Coerce a number-or-string field to a finite number, defaulting to 0. */
function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // Effiliation occasionally uses a comma decimal separator (FR locale).
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Status normalisation: Effiliation programme status → canonical ProgrammeStatus.
 *
 * Effiliation programme/affiliation statuses appear in French and English. We
 * collapse to our enum, preferring `unknown` over a wrong guess:
 *
 *   valide / validee / active / open / joined → 'joined'
 *   en attente / attente / pending            → 'pending'
 *   refuse / refusee / declined / rejected    → 'declined'
 *   ferme / closed / inactive / available     → 'available' (closed-to-new vs open)
 *   suspendu / paused / suspended             → 'suspended'
 *   anything else                             → 'unknown'
 *
 * Note: Effiliation does not cleanly distinguish "joined" from "available to
 * join" in the JSON column set we read; the programmes endpoint returns the
 * publisher's affiliations, so a present, valid programme maps to 'joined'.
 */
function mapProgrammeStatus(raw: EffiliationProgrammeRaw): ProgrammeStatus {
  const s = (raw.statut ?? raw.status ?? '').toString().toLowerCase().trim();
  if (!s) return 'unknown';
  if (s.startsWith('valid') || s === 'active' || s === 'open' || s === 'joined' || s === 'ouvert') {
    return 'joined';
  }
  if (s.includes('attente') || s === 'pending') return 'pending';
  if (s.startsWith('refus') || s === 'declined' || s === 'rejected' || s === 'rejete') {
    return 'declined';
  }
  if (s.startsWith('suspend') || s === 'paused' || s === 'pause') return 'suspended';
  if (s.startsWith('ferm') || s === 'closed' || s === 'inactive' || s === 'available') {
    return 'available';
  }
  return 'unknown';
}

/**
 * Status normalisation: Effiliation transaction status → canonical TransactionStatus.
 *
 * Effiliation marks transactions in French (and sometimes English):
 *
 *   en attente / attente / pending / open  → 'pending'
 *   valide / validee / approved / confirme → 'approved'
 *   refuse / annule / declined / cancelled → 'reversed'  (publisher not paid)
 *   paye / payee / paid                    → 'paid'
 *   anything else                          → 'other'
 *
 * Why "refuse/annule" → 'reversed': the sale did not pay out, which is exactly
 * what every other network calls "reversed". Keep the raw value on
 * rawNetworkData so the original word is never lost.
 */
function mapTransactionStatus(raw: EffiliationTransactionRaw): TransactionStatus {
  const s = (raw.etat ?? raw.statut ?? raw.status ?? '').toString().toLowerCase().trim();
  if (!s) return 'other';
  if (s.startsWith('pay')) return 'paid';
  if (s.startsWith('valid') || s === 'approved' || s.startsWith('confirm')) return 'approved';
  if (s.startsWith('refus') || s.startsWith('annul') || s === 'declined' || s === 'cancelled') {
    return 'reversed';
  }
  if (s.includes('attente') || s === 'pending' || s === 'open') return 'pending';
  return 'other';
}

/**
 * Parse an Effiliation date string into epoch milliseconds.
 *
 * Effiliation emits dates as `DD/MM/YYYY` or `DD/MM/YYYY HH:mm:ss`. The native
 * `Date.parse` does not understand the `DD/MM/YYYY` order, so we parse it
 * explicitly. ISO strings (used by callers/fixtures) fall through to
 * `Date.parse`.
 */
function parseEffiliationDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = m;
    const ms = Date.UTC(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss),
    );
    return Number.isNaN(ms) ? undefined : ms;
  }
  const ts = Date.parse(trimmed);
  return Number.isNaN(ts) ? undefined : ts;
}

function nullableIso(value: string | undefined): string | undefined {
  const ms = parseEffiliationDate(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/**
 * Compute the age (in days) of a transaction at the moment the adapter
 * responded. We anchor on the validation date when present (the point the
 * commission was approved), falling back to the transaction date — mirroring
 * Awin's reasoning for the unpaid-age affordance (PRD §15.9).
 */
function computeAgeDays(raw: EffiliationTransactionRaw, now: Date = new Date()): number {
  const ms =
    parseEffiliationDate(raw.date_validation) ??
    parseEffiliationDate(raw.date_transaction ?? raw.date);
  if (ms === undefined) return 0;
  const diff = now.getTime() - ms;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

/** Format a Date for Effiliation's `start`/`end` params: `DD/MM/YYYY`. */
function formatEffiliationDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function programmeRows(resp: EffiliationProgrammesResponse): EffiliationProgrammeRaw[] {
  if (Array.isArray(resp)) return resp;
  return resp?.programs ?? resp?.programmes ?? [];
}

function transactionRows(resp: EffiliationTransactionsResponse): EffiliationTransactionRaw[] {
  if (Array.isArray(resp)) return resp;
  return resp?.transactions ?? resp?.transaction ?? [];
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: EffiliationProgrammeRaw): Programme {
  const id = String(raw.id ?? raw.id_programme ?? raw.programme_id ?? raw.id_affilieur ?? '');
  const commissionRaw = raw.commission ?? raw.remuneration;
  return {
    id,
    name: raw.name ?? raw.nom ?? `Effiliation programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.devise ?? raw.currency,
    // Effiliation does not expose a reliably structured commission rate in the
    // default JSON column set; surface whatever descriptor is present as a
    // free-text description rather than guessing a numeric type.
    commissionRate:
      commissionRaw !== undefined
        ? { type: 'unknown', description: String(commissionRaw) }
        : undefined,
    categories: (raw.category ?? raw.categorie) ? [String(raw.category ?? raw.categorie)] : [],
    advertiserUrl: raw.url ?? raw.site_url,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: EffiliationTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toNumber(raw.commission ?? raw.montant_commission);
  const sale = toNumber(raw.montant ?? raw.amount);
  // Amount-unit assumption: decimal major units, EUR default (see file header).
  const currency = raw.devise ?? raw.currency ?? 'EUR';

  const programmeId = String(raw.id_programme ?? raw.programme_id ?? raw.id_affilieur ?? '');
  const dateConverted =
    nullableIso(raw.date_transaction ?? raw.date) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.date_clic ?? raw.date_click);
  const dateApproved = nullableIso(raw.date_validation);
  const datePaid = nullableIso(raw.date_paiement);

  return {
    id: String(raw.id ?? raw.id_transaction ?? raw.transaction_id ?? ''),
    network: SLUG,
    programmeId,
    programmeName: raw.programme ?? raw.programme_nom ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — surface the reversal reason where Effiliation provides one.
    reversalReason:
      status === 'reversed' ? raw.motif ?? raw.raison ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EffiliationAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the programmes the publisher works with.
   *
   * Effiliation endpoint: GET /apiv2/programs.json
   *   Returns the publisher's programmes. The endpoint has no documented
   *   server-side free-text search, so we apply search / status / category /
   *   limit filters client-side, mirroring Awin.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');

    const resp = await effiliationRequest<EffiliationProgrammesResponse>({
      operation: 'listProgrammes',
      path: '/apiv2/programs.json',
      apiKey,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = programmeRows(resp).map(toProgramme);

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
   * Effiliation's JSON programmes endpoint returns the full list rather than a
   * single-programme resource we can address by path, so we fetch the list and
   * select the matching row. This keeps the operation honest: if the programme
   * is not among the publisher's affiliations, we surface a clear error rather
   * than fabricating a stub.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'A programme id is required.',
          hint: 'Use affiliate_effiliation_list_programmes to discover valid programme IDs.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Effiliation programme found with id "${programmeId}".`,
          hint:
            'The programmes endpoint returns the programmes you are affiliated with. ' +
            'Confirm the id via affiliate_effiliation_list_programmes.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions (sales / leads) across a date window.
   *
   * Effiliation endpoint:
   *   GET /apiv2/transaction.json?start=DD/MM/YYYY&end=DD/MM/YYYY&type=date
   *
   * Date params use the `DD/MM/YYYY` form and `type=date` selects filtering on
   * the transaction date. The default window is the last 30 days when the
   * caller supplies none.
   *
   * Note: upstream transaction data is refreshed roughly every two hours, so a
   * conversion that happened minutes ago may not appear yet.
   *
   * The endpoint has no documented per-call window cap, so we issue a single
   * call and apply programme / status / age / limit filters client-side. If a
   * cap is discovered against a live account, replicate Awin's `chunkDateRange`
   * here.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const resp = await effiliationRequest<EffiliationTransactionsResponse>({
      operation: 'listTransactions',
      path: '/apiv2/transaction.json',
      apiKey,
      query: {
        start: formatEffiliationDate(from),
        end: formatEffiliationDate(to),
        type: 'date',
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    let transactions = transactionRows(resp).map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9. Applied after status filtering.
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
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` for the same reasons as Awin: per-
   * transaction `ageDays` is needed for `oldestUnpaidAgeDays`, so we fetch the
   * raw records anyway and deriving keeps the summary auditable (the user can
   * recompute it from listTransactions).
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
      // Default EUR until we see a real transaction; overwritten by the first one.
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
          programmeName: t.programmeName || `Effiliation programme ${key}`,
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
   * Effiliation does not expose click-level data to the publisher via the
   * programme / transaction API.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "no clicks" and "no click API" is the
   * difference between an actionable observation and a wild goose chase
   * (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Effiliation does not expose click-level data via the publisher API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Tracking-link (deeplink) construction is not implemented.
   *
   * The Effiliation publisher deeplink format is not deterministically
   * documented for this API (link generation is done in the dashboard, and the
   * `links` resource is geared at editorial links / feeds rather than an
   * addressable deeplink-builder with a stable contract). Rather than guess a
   * URL scheme that might silently produce untracked links, we throw
   * `NotImplementedError`. This becomes a real implementation once the deeplink
   * contract is confirmed against a live account.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Effiliation deeplink construction is not deterministically documented for the publisher API',
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
    ): Promise<void> => {
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

    // getProgramme requires a known programme id — record without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Selected from the programmes list by id; not probed automatically.',
    };

    // listClicks: structurally unsupported — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Effiliation does not expose click-level data via the publisher API',
    };

    // generateTrackingLink: deeplink contract not confirmed — unsupported.
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Effiliation deeplink construction is not deterministically documented for the publisher API',
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

export const effiliationAdapter = new EffiliationAdapter();
registerAdapter(effiliationAdapter);

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  parseEffiliationDate,
  formatEffiliationDate,
  toProgramme,
  toTransaction,
  toNumber,
};

// Silence unused-import lint for the logger.
void log;
