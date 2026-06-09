/**
 * Adcell adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`
 * (the canonical reference) and `src/networks/everflow/adapter.ts` (custom-auth
 * key + account id). Read those first.
 *
 * Adcell is a DACH (Germany / Austria / Switzerland) performance network. It is
 * now part of the mrge holding group, but THIS ADAPTER IS STANDALONE and
 * intentionally distinct from `src/networks/mrge` — Adcell has its own API,
 * host, and credentials.
 *
 * --- API overview (UNVERIFIED — see below) ---------------------------------
 *
 * Auth:    Custom — API key/password + publisher (affiliate) account id.
 *          See `auth.ts` and `client.ts` for the header scheme.
 * Base:    https://api.adcell.com
 * Docs:    https://strackr.com/docs/adcell (public, third-party)
 *
 * The Adcell publisher API reference is DASHBOARD-GATED: the authoritative
 * documentation is only reachable from inside an authenticated account. Every
 * endpoint path, field name, and status value below is reconstructed from
 * public third-party integrations (Strackr, wecantrack, affiliatetheme) and
 * the legacy CSV interface. Treat the shapes as unverified — the transformers
 * read every field defensively and preserve the verbatim payload under
 * `rawNetworkData`, so a wrong field name degrades gracefully rather than
 * throwing. Confirm everything against a live account before promoting the
 * `claim_status` past `experimental`.
 *
 * --- Endpoint map (best-effort) --------------------------------------------
 *
 *   GET  /v2/publisher/programs            → programmes (advertisers) the
 *                                            publisher can see / has joined.
 *   GET  /v2/publisher/programs/{id}       → single programme detail.
 *   GET  /v2/publisher/statistics/transactions
 *        ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *                                          → sales + leads with status.
 *
 * Clicks: no documented publisher click-level endpoint → NotImplementedError.
 * Tracking links: no documented deterministic deep-link scheme or link API for
 * publishers → NotImplementedError.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `adcellRequest` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `unknown`/`other`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. The user-visible noun is "programme" not "program".
 *
 * --- Amount unit -----------------------------------------------------------
 *
 * Adcell is a DACH network and settles in EUR. We assume amounts are EUR and
 * default `currency` to 'EUR' when the payload omits one. UNVERIFIED — confirm
 * against a live account; the raw payload retains whatever Adcell actually sent.
 */

import { adcellRequest } from './client.js';
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

const log = createLogger('adcell.adapter');

const SLUG = 'adcell';
const NAME = 'Adcell';

/** Adcell settles in EUR; default currency when a payload omits one. UNVERIFIED. */
const DEFAULT_CURRENCY = 'EUR';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.adcell.com',
  // Custom: API key/password + account id headers, not standard Bearer.
  authModel: 'custom',
  docsUrl: 'https://strackr.com/docs/adcell',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: built from public, third-party sources; the API is
  // dashboard-gated and the adapter has not been validated against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public, third-party sources; not yet verified against a live account.',
    "Adcell's publisher API is dashboard-gated; endpoint paths, field names, and the auth header scheme are reconstructed and need live verification.",
    'Amounts are assumed to be EUR (Adcell is a DACH network); the assumption is unverified and the raw payload retains the source value.',
    'Click-level data is not exposed via a documented publisher endpoint; listClicks is unsupported.',
    'No documented deterministic deep-link scheme or publisher link API; generateTrackingLink is unsupported.',
    'Distinct from the mrge adapter: Adcell is now under the mrge holding group but is integrated here as a standalone network with its own API and credentials.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  // API access may need enabling via Adcell support on some accounts, but the
  // key itself is self-service from the dashboard — not a hard approval gate.
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profiles
// ---------------------------------------------------------------------------

/**
 * Statistics reports (listTransactions / getEarningsSummary) can be slow over
 * wide windows. Give them a 60s timeout and 3 retries, matching Awin's and
 * Everflow's reporting profiles.
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
// Adcell raw response shapes (deliberately minimal; UNVERIFIED — see header)
// ---------------------------------------------------------------------------

/** A programme (advertiser) record. Field names are best-effort. */
interface AdcellProgrammeRaw {
  programId?: number | string;
  id?: number | string;
  programName?: string;
  name?: string;
  // Affiliate's relationship / partnership state. Best-effort German + English values.
  status?: string;
  partnershipStatus?: string;
  currency?: string;
  // Commission may arrive as a free-text string or a numeric percent.
  commission?: string | number;
  commissionText?: string;
  category?: string;
  categories?: string[];
  url?: string;
  homepageUrl?: string;
  websiteUrl?: string;
}

/** A transaction (sale / lead) record. Field names are best-effort. */
interface AdcellTransactionRaw {
  transactionId?: number | string;
  id?: number | string;
  programId?: number | string;
  programName?: string;
  // Adcell distinguishes sales and leads; we keep the raw type for context.
  type?: string;
  // Status — Adcell typically uses German states (offen/bestätigt/storniert).
  status?: string;
  // Monetary fields. `amount` ~ order value, `commission` ~ publisher payout.
  amount?: number | string;
  orderValue?: number | string;
  commission?: number | string;
  currency?: string;
  // Dates — best-effort field names; could be ISO strings or `YYYY-MM-DD`.
  clickDate?: string;
  clickTime?: string;
  transactionDate?: string;
  saleDate?: string;
  confirmationDate?: string;
  paymentDate?: string;
  subId?: string;
  cancellationReason?: string;
}

/** Envelope variations Adcell might wrap list responses in. */
interface AdcellProgrammesEnvelope {
  programs?: AdcellProgrammeRaw[];
  data?: AdcellProgrammeRaw[];
  items?: AdcellProgrammeRaw[];
}

interface AdcellTransactionsEnvelope {
  transactions?: AdcellTransactionRaw[];
  data?: AdcellTransactionRaw[];
  items?: AdcellTransactionRaw[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(operation: string): string {
  return requireCredential('ADCELL_API_TOKEN', {
    network: SLUG,
    operation,
    hint: 'Create an API password under My ADCELL → Settings → API-Password, then set ADCELL_API_TOKEN in ~/.affiliate-mcp/.env.',
  });
}

function requireAffiliateId(operation: string): string {
  return requireCredential('ADCELL_AFFILIATE_ID', {
    network: SLUG,
    operation,
    hint: 'Set ADCELL_AFFILIATE_ID (your numeric publisher ID from My ADCELL) in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Status normalisation: Adcell programme state → canonical ProgrammeStatus.
 *
 * Adcell is a German network, so states may be German or English. We collapse
 * the common values; anything unrecognised maps to 'unknown' rather than a
 * wrong guess (the raw value is preserved on `rawNetworkData`).
 *
 *   active / aktiv / joined / partner   → 'joined'
 *   pending / wartend / beantragt       → 'pending'
 *   declined / abgelehnt / rejected     → 'declined'
 *   available / verfügbar / open        → 'available'
 *   paused / pausiert / suspended       → 'suspended'
 *   anything else                       → 'unknown'
 */
function mapProgrammeStatus(raw: AdcellProgrammeRaw): ProgrammeStatus {
  const s = (raw.status ?? raw.partnershipStatus ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('aktiv') || s === 'active' || s === 'joined' || s === 'partner') return 'joined';
  if (s.includes('wartend') || s.includes('beantragt') || s === 'pending') return 'pending';
  if (s.includes('abgelehnt') || s === 'declined' || s === 'rejected') return 'declined';
  if (s.includes('verfügbar') || s.includes('verfuegbar') || s === 'available' || s === 'open')
    return 'available';
  if (s.includes('pausiert') || s === 'paused' || s === 'suspended') return 'suspended';
  return 'unknown';
}

/**
 * Status normalisation: Adcell transaction state → canonical TransactionStatus.
 *
 * Adcell typically reports German states. Best-effort mapping:
 *
 *   offen / open / pending              → 'pending'
 *   bestätigt / bestaetigt / confirmed / accepted / approved → 'approved'
 *   storniert / cancelled / canceled / rejected / declined   → 'reversed'
 *   ausgezahlt / bezahlt / paid          → 'paid'
 *   anything else                        → 'other'
 *
 * 'storniert' (cancelled) maps to 'reversed' because the user-facing intent is
 * the same: the sale did not pay out. 'reversed' is the term other networks use.
 */
function mapTransactionStatus(raw: AdcellTransactionRaw): TransactionStatus {
  const s = (raw.status ?? '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('ausgezahlt') || s.includes('bezahlt') || s === 'paid') return 'paid';
  if (s.includes('storniert') || s.includes('cancel') || s === 'rejected' || s === 'declined')
    return 'reversed';
  if (
    s.includes('bestätigt') ||
    s.includes('bestaetigt') ||
    s === 'confirmed' ||
    s === 'accepted' ||
    s === 'approved'
  )
    return 'approved';
  if (s.includes('offen') || s === 'open' || s === 'pending') return 'pending';
  return 'other';
}

/** Coerce a possibly-string numeric field to a number, defaulting to 0. */
function toNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Adcell may send German-formatted decimals ("12,34"); normalise the comma.
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age (in days) of a transaction at the moment this adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this number.
 *
 * We anchor on the confirmation date (when Adcell validated the commission)
 * then fall back to the sale/transaction date, mirroring Awin's preference for
 * the validation date.
 */
function computeAgeDays(raw: AdcellTransactionRaw, now: Date = new Date()): number {
  const anchor = raw.confirmationDate ?? raw.transactionDate ?? raw.saleDate;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/** Format a Date as `YYYY-MM-DD` for Adcell's statistics date params (best-effort). */
function formatAdcellDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toStatusList<T>(v?: T | T[]): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function firstArray<T>(...candidates: Array<T[] | undefined>): T[] {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toProgramme(raw: AdcellProgrammeRaw): Programme {
  const id = String(raw.programId ?? raw.id ?? '');
  const commission = raw.commissionText ?? raw.commission;
  return {
    id,
    name: raw.programName ?? raw.name ?? `Adcell programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? DEFAULT_CURRENCY,
    commissionRate:
      commission !== undefined
        ? {
            type: typeof commission === 'number' ? 'percent' : 'unknown',
            value: typeof commission === 'number' ? commission : undefined,
            description: typeof commission === 'string' ? commission : undefined,
          }
        : undefined,
    categories: firstArray<string>(
      raw.categories,
      raw.category ? [raw.category] : undefined,
    ),
    advertiserUrl: raw.url ?? raw.homepageUrl ?? raw.websiteUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AdcellTransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const sale = toNumber(raw.amount ?? raw.orderValue);
  const commission = toNumber(raw.commission);
  const currency = raw.currency ?? DEFAULT_CURRENCY;

  const dateConverted =
    nullableIso(raw.transactionDate ?? raw.saleDate) ?? new Date(0).toISOString();
  const dateClicked = nullableIso(raw.clickDate ?? raw.clickTime);
  const dateApproved = nullableIso(raw.confirmationDate);
  const datePaid = nullableIso(raw.paymentDate);

  return {
    id: String(raw.transactionId ?? raw.id ?? ''),
    network: SLUG,
    programmeId: String(raw.programId ?? ''),
    programmeName: raw.programName ?? '',
    status,
    amount: sale,
    currency,
    commission,
    dateClicked,
    dateConverted,
    dateApproved,
    datePaid,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.cancellationReason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AdcellAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List Adcell programmes the publisher can see / has joined.
   *
   * Endpoint (UNVERIFIED): GET /v2/publisher/programs
   *   Adcell may return a bare array or wrap it in `programs` / `data` /
   *   `items`; we read whichever is present. Free-text search, status, and
   *   category are filtered client-side because the documented surface does
   *   not confirm server-side filters.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    const affiliateId = requireAffiliateId('listProgrammes');

    const raw = await adcellRequest<AdcellProgrammesEnvelope | AdcellProgrammeRaw[]>({
      operation: 'listProgrammes',
      path: '/v2/publisher/programs',
      apiKey,
      affiliateId,
      query: { limit: query?.limit },
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const rows = Array.isArray(raw)
      ? raw
      : firstArray<AdcellProgrammeRaw>(raw.programs, raw.data, raw.items);

    let programmes = rows.map(toProgramme);

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
   * Fetch a single Adcell programme by ID.
   *
   * Endpoint (UNVERIFIED): GET /v2/publisher/programs/{id}
   * Adcell programme IDs are numeric; reject non-numeric input as a
   * config_error so the user sees an actionable hint, not an upstream 400.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^\d+$/.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Adcell programme IDs are numeric; received "${programmeId}".`,
          hint: 'Use affiliate_adcell_list_programmes to discover valid programme IDs.',
        }),
      );
    }

    const apiKey = requireApiKey('getProgramme');
    const affiliateId = requireAffiliateId('getProgramme');

    const raw = await adcellRequest<AdcellProgrammeRaw | { program?: AdcellProgrammeRaw }>({
      operation: 'getProgramme',
      path: `/v2/publisher/programs/${programmeId}`,
      apiKey,
      affiliateId,
      resilience: RESILIENCE.getProgramme ?? RESILIENCE.default,
    });

    // Adcell may wrap the single object in `program`; unwrap if so.
    const flat = (raw as { program?: AdcellProgrammeRaw })?.program ?? (raw as AdcellProgrammeRaw);
    return toProgramme(flat ?? {});
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions (sales + leads) over a date window.
   *
   * Endpoint (UNVERIFIED): GET /v2/publisher/statistics/transactions
   *   ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   *
   * Default window: last 30 days. We do not know Adcell's per-call window cap,
   * so we chunk into ≤92-day (~3 month) slices defensively — wide enough to be
   * efficient, narrow enough to dodge a likely quarterly cap. If a live account
   * reveals a tighter cap, lower `MAX_WINDOW_DAYS`.
   *
   * Filters (status / programme / age) are applied client-side: the documented
   * surface does not confirm server-side equivalents. Age filters run AFTER
   * status filtering so `{ status: 'approved', minAgeDays: 180 }` is meaningful
   * (PRD §15.9). Reversed transactions are returned unless excluded, with
   * `reversalReason` populated where Adcell supplies one (PRD §15.10).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');
    const affiliateId = requireAffiliateId('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const MAX_WINDOW_DAYS = 92;
    const slices = chunkDateRange(from, to, MAX_WINDOW_DAYS);

    const allRaw: AdcellTransactionRaw[] = [];
    for (const slice of slices) {
      const raw = await adcellRequest<AdcellTransactionsEnvelope | AdcellTransactionRaw[]>({
        operation: 'listTransactions',
        path: '/v2/publisher/statistics/transactions',
        apiKey,
        affiliateId,
        query: {
          startDate: formatAdcellDate(slice.start),
          endDate: formatAdcellDate(slice.end),
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const rows = Array.isArray(raw)
        ? raw
        : firstArray<AdcellTransactionRaw>(raw.transactions, raw.data, raw.items);
      allRaw.push(...rows);
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
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (not a separate report endpoint) for the
   * same reasons as Awin and Everflow: we need the per-transaction `ageDays`
   * for `oldestUnpaidAgeDays` anyway, and deriving keeps the summary auditable
   * — the user can call listTransactions and recompute the same numbers.
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
          programmeName: t.programmeName || `Adcell programme ${key}`,
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
      currency: firstCurrency ?? DEFAULT_CURRENCY,
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
   * Adcell does not expose click-level data via a documented publisher
   * endpoint.
   *
   * We throw `NotImplementedError` rather than returning an empty array — the
   * difference between "Adcell returned no clicks" and "Adcell does not expose
   * clicks" is an actionable observation vs a wild goose chase (PRD principle
   * 4.1). If a live account reveals a click endpoint, this becomes a real
   * implementation and the corresponding `knownLimitations` line is dropped.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Adcell does not expose click-level data via a documented publisher API endpoint',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Adcell does not publish a deterministic deep-link scheme or a publisher
   * link-generation API endpoint outside the dashboard.
   *
   * Adcell publishers normally copy ready-made tracking links / creatives from
   * the dashboard per programme; there is no documented, account-agnostic URL
   * template we can construct safely (unlike Awin's `cread.php`). Returning a
   * guessed URL would risk producing an untracked link, so we throw
   * `NotImplementedError`. Promote to a real implementation once a live account
   * confirms the link format or a link API.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Adcell does not document a deterministic deep-link scheme or publisher link API; ' +
        'copy tracking links from the Adcell dashboard per programme',
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
      note: 'Adcell does not expose click-level data via a documented publisher API endpoint',
    };

    // generateTrackingLink: known-unsupported. Record without probing.
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Adcell does not document a deterministic deep-link scheme or publisher link API',
    };

    // getProgramme requires a known programme ID — mark supported without probing.
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Requires a known programme ID; not probed automatically.',
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

export const adcellAdapter = new AdcellAdapter();
registerAdapter(adcellAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Mirrors Awin's `chunkDateRange`.
 * Adcell's per-call window cap is undocumented; we chunk defensively so wide
 * requests do not fail against a likely cap.
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

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapProgrammeStatus,
  mapTransactionStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  toNumber,
  chunkDateRange,
  formatAdcellDate,
};

// Silence unused-import lint for the logger.
void log;
