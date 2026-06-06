/**
 * Affilae adapter — publisher side, single-brand.
 *
 * Built from Affilae's public API documentation (https://rest.affilae.com/reference
 * and https://affilae.com/en/api-v2-2/). It has NOT been validated against a
 * live Affilae account — `claimStatus` is `experimental` and the field names
 * read by the transformers are best-effort from the public docs. Every
 * transformer reads keys defensively and preserves the verbatim payload on
 * `rawNetworkData`, so an unrecognised shape surfaces honestly rather than
 * crashing.
 *
 * --- Affilae API map (publisher side) ---------------------------------------
 *
 *   GET /publisher/publishers.me
 *     → the authenticated publisher account (id, name). verifyAuth uses this.
 *   GET /publisher/programs.list
 *     → the publisher's programmes / partnerships.
 *   GET /publisher/conversions.list
 *     ?status=pending|accepted|refused &from=ISO &to=ISO &programId=...
 *     → conversions (our Transactions). Amounts are in CENTS; we convert to
 *       major units. Dates are UTC ISO-8601.
 *
 * --- Cardinal rules (see Awin's adapter header for full reasoning) ----------
 *
 *   1. NEVER call `fetch` directly. Use `affilaeRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the raw response on `rawNetworkData`.
 *   4. NORMALISE status enums into the canonical set; prefer 'other'/'unknown'
 *      over a wrong guess.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme").
 *
 * --- Amount-unit assumption -------------------------------------------------
 *
 * Affilae's docs state amounts are expressed in cents ("100" = "1.00"). We
 * divide by 100 to surface major units on `amount`/`commission`. The verbatim
 * cents value remains on `rawNetworkData`.
 */

import { affilaeRequest } from './client.js';
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
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('affilae.adapter');

const SLUG = 'affilae';
const NAME = 'Affilae';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://rest.affilae.com',
  authModel: 'bearer',
  docsUrl: 'https://rest.affilae.com/reference',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: implemented from public docs only, not yet validated
  // against a live Affilae account. Promote after live acceptance testing.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).',
    'Monetary amounts are returned by Affilae in cents and converted to major units; the verbatim cents value is preserved on rawNetworkData.',
    'Click-level data is not exposed via the documented publisher API; listClicks is unsupported.',
    'Tracking-link minting requires an API call whose exact contract is not publicly documented; generateTrackingLink is unsupported pending live verification.',
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

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Affilae response shapes (deliberately minimal + defensive)
// ---------------------------------------------------------------------------
//
// Affilae's public field documentation is thin (the reference site gates
// fetchers). We read several plausible key names per field and treat every
// field as possibly absent; the verbatim payload is preserved on
// `rawNetworkData`. When Affilae returns something we don't recognise the user
// sees the raw payload rather than a schema-mismatch error.
// ---------------------------------------------------------------------------

interface AffilaeProgrammeRaw {
  id?: string;
  _id?: string;
  programId?: string;
  name?: string;
  programName?: string;
  status?: string;
  partnershipStatus?: string;
  currency?: string;
  currencyCode?: string;
  url?: string;
  websiteUrl?: string;
  category?: string;
  categories?: string[];
  commission?: string | number;
  commissionRate?: string | number;
}

interface AffilaeAmount {
  amount?: number;
  value?: number;
  currency?: string;
}

interface AffilaeConversionRaw {
  id?: string;
  _id?: string;
  conversionId?: string;
  programId?: string;
  programName?: string;
  programmeName?: string;
  status?: string; // pending | accepted | refused (per docs)
  paid?: boolean;
  isPaid?: boolean;
  // Amounts in CENTS (Affilae convention). Several plausible key names.
  amount?: number | AffilaeAmount;
  saleAmount?: number;
  turnover?: number;
  commission?: number | AffilaeAmount;
  commissionAmount?: number;
  currency?: string;
  currencyCode?: string;
  // Dates — UTC ISO-8601.
  clickDate?: string;
  conversionDate?: string;
  date?: string;
  createdAt?: string;
  validationDate?: string;
  approvedAt?: string;
  paymentDate?: string;
  paidAt?: string;
  refusedReason?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Affilae conversion status → canonical.
 *
 * Affilae documents three conversion statuses: 'pending', 'accepted',
 * 'refused'. We map:
 *   accepted  → 'approved'  (the commission was validated)
 *   pending   → 'pending'
 *   refused   → 'reversed'  (the user did not get paid; "reversed" is what
 *                            every other network calls this state)
 *   anything else → 'other' (never invent a status the user didn't see)
 *
 * If Affilae exposes a paid flag we surface 'paid' on top of the status string,
 * because a conversion can remain 'accepted' even after it has been paid.
 */
function mapTransactionStatus(raw: AffilaeConversionRaw): TransactionStatus {
  if (raw.paid === true || raw.isPaid === true) return 'paid';
  switch ((raw.status ?? '').toLowerCase()) {
    case 'pending':
    case 'open':
      return 'pending';
    case 'accepted':
    case 'approved':
    case 'validated':
      return 'approved';
    case 'refused':
    case 'rejected':
    case 'declined':
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: Affilae programme/partnership status → canonical.
 *
 * Affilae partnerships move through application states. We collapse to our
 * enum and default to 'unknown' rather than miscategorising an unfamiliar
 * value.
 */
function mapProgrammeStatus(raw: AffilaeProgrammeRaw): ProgrammeStatus {
  const s = (raw.partnershipStatus ?? raw.status ?? '').toLowerCase();
  if (s === 'joined' || s === 'active' || s === 'accepted' || s === 'validated') return 'joined';
  if (s === 'pending' || s === 'waiting' || s === 'applied') return 'pending';
  if (s === 'declined' || s === 'refused' || s === 'rejected') return 'declined';
  if (s === 'available' || s === 'notjoined' || s === 'open') return 'available';
  if (s === 'paused' || s === 'suspended' || s === 'closed') return 'suspended';
  return 'unknown';
}

/**
 * Read a money field that may be a bare number (cents) or an object with an
 * `amount`/`value` (cents) plus optional `currency`. Returns cents.
 */
function readCents(field: number | AffilaeAmount | undefined): number | undefined {
  if (field === undefined) return undefined;
  if (typeof field === 'number') return field;
  if (typeof field.amount === 'number') return field.amount;
  if (typeof field.value === 'number') return field.value;
  return undefined;
}

/** Convert cents to major units. Affilae amounts are in cents per the docs. */
function centsToMajor(cents: number | undefined): number {
  if (cents === undefined || Number.isNaN(cents)) return 0;
  return cents / 100;
}

/**
 * Compute the age (in days) of a conversion at the moment this adapter
 * responded (PRD §15.9). We prefer the validation/approval date then the
 * conversion date, matching Awin's anchoring rationale: the unpaid-age
 * affordance asks "how long has this been approved-but-not-paid?".
 */
function computeAgeDays(raw: AffilaeConversionRaw, now: Date = new Date()): number {
  const anchor =
    raw.validationDate ?? raw.approvedAt ?? raw.conversionDate ?? raw.date ?? raw.createdAt;
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

// ---------------------------------------------------------------------------
// Transformers (Affilae raw → canonical domain types)
// ---------------------------------------------------------------------------

function toProgramme(raw: AffilaeProgrammeRaw): Programme {
  const id = String(raw.id ?? raw._id ?? raw.programId ?? '');
  const commissionSource = raw.commission ?? raw.commissionRate;
  return {
    id,
    name: raw.name ?? raw.programName ?? `Affilae programme ${id}`,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    currency: raw.currency ?? raw.currencyCode,
    commissionRate:
      commissionSource !== undefined
        ? { type: 'unknown', description: String(commissionSource) }
        : undefined,
    categories: raw.categories ?? (raw.category ? [raw.category] : []),
    advertiserUrl: raw.url ?? raw.websiteUrl,
    rawNetworkData: raw,
  };
}

function toTransaction(raw: AffilaeConversionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);

  const saleCents = readCents(raw.amount) ?? raw.saleAmount ?? raw.turnover;
  const commissionCents = readCents(raw.commission) ?? raw.commissionAmount;
  const currency =
    (typeof raw.amount === 'object' ? raw.amount.currency : undefined) ??
    (typeof raw.commission === 'object' ? raw.commission.currency : undefined) ??
    raw.currency ??
    raw.currencyCode ??
    'EUR';

  const conversionDate =
    nullableIso(raw.conversionDate ?? raw.date ?? raw.createdAt) ?? new Date(0).toISOString();

  return {
    id: String(raw.id ?? raw._id ?? raw.conversionId ?? ''),
    network: SLUG,
    programmeId: String(raw.programId ?? ''),
    programmeName: raw.programName ?? raw.programmeName ?? '',
    status,
    amount: centsToMajor(saleCents),
    currency,
    commission: centsToMajor(commissionCents),
    dateClicked: nullableIso(raw.clickDate),
    dateConverted: conversionDate,
    dateApproved: nullableIso(raw.validationDate ?? raw.approvedAt),
    datePaid: nullableIso(raw.paymentDate ?? raw.paidAt),
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed' ? raw.refusedReason ?? raw.reason ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

/**
 * Unwrap a list response. Affilae `.list` routes may return a bare array or an
 * envelope keyed by the resource name / `data` / `results`. We read all the
 * common shapes and fall back to an empty array.
 */
function unwrapList<T>(response: unknown, ...keys: string[]): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    for (const key of [...keys, 'data', 'results', 'items']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class AffilaeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the publisher's Affilae programmes / partnerships.
   *
   *   GET /publisher/programs.list
   *
   * Affilae's documented filter surface for the publisher programmes list is
   * thin, so `search`, `status`, `categories`, and `limit` are applied
   * client-side after the fetch. This keeps the adapter honest: we never claim
   * a server-side filter we cannot verify against the public docs.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');

    const raw = await affilaeRequest<unknown>({
      operation: 'listProgrammes',
      path: '/publisher/programs.list',
      token,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    let programmes = unwrapList<AffilaeProgrammeRaw>(raw, 'programs', 'programmes').map(toProgramme);

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
   * Affilae IDs are 24-character hex strings (Mongo ObjectId style). We
   * validate that shape before calling so an obviously-wrong id surfaces as a
   * `config_error` rather than an opaque upstream 400/404.
   *
   * The publisher programmes list does not document a per-id detail route, so
   * we fetch the list and select the matching row. This keeps a single
   * documented endpoint as the source of truth.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || !/^[a-f0-9]{24}$/i.test(programmeId)) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Affilae programme IDs are 24-character hex strings; received "${programmeId}".`,
          hint: 'List programmes first (affiliate_affilae_list_programmes) to find the correct id.',
        }),
      );
    }

    const programmes = await this.listProgrammes();
    const match = programmes.find((p) => p.id === programmeId);
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Affilae programme "${programmeId}" was not found among the publisher's programmes.`,
          hint: 'The publisher may not have a partnership with this programme.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List conversions (our Transactions) across a date window.
   *
   *   GET /publisher/conversions.list
   *     ?status=pending|accepted|refused &from=ISO &to=ISO &programId=...
   *
   * Affilae documents `status`, `from`, `to`, `customerId`, and `externalId`
   * filters; the exact maximum window per call is not published. To stay
   * within typical reporting limits we chunk wide windows into ≤31-day slices
   * (the same conservative cap Awin uses) so a 90-day request makes sequential
   * calls rather than risking an upstream rejection.
   *
   * Status, programme, and age filters are applied client-side after the fetch
   * so a query like `{ status: 'approved', minAgeDays: 180 }` is meaningful.
   * Amounts are converted from cents to major units in the transformer.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const slices = chunkDateRange(from, to, 31);

    const allRaw: AffilaeConversionRaw[] = [];
    for (const slice of slices) {
      const chunk = await affilaeRequest<unknown>({
        operation: 'listTransactions',
        path: '/publisher/conversions.list',
        token,
        query: {
          from: formatAffilaeDate(slice.start),
          to: formatAffilaeDate(slice.end),
          programId: query?.programmeId,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      allRaw.push(...unwrapList<AffilaeConversionRaw>(chunk, 'conversions'));
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
   * Aggregate conversions into an earnings summary.
   *
   * Derived from `listTransactions` so the user can recompute the same numbers
   * by listing the underlying conversions (see Awin's rationale). We ignore
   * `limit` here — a limit on a summary would silently undercount
   * (principle 4.1). Totals count commission, not sale amount.
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
          programmeName: t.programmeName || `Affilae programme ${key}`,
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
   * Affilae does not expose click-level data to publishers via its documented
   * current API. (An older `/2.0/publisher/{profileId}/clicks` route existed
   * but the V2 surface was closed on 2022-05-01.) We throw
   * `NotImplementedError` rather than return an empty array so the user can
   * tell "no clicks" from "no click API" (principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Affilae does not expose click-level data to publishers via the documented API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Affilae generates tracking links via an API call whose exact request/
   * response contract is not publicly documented (the link format, C2S vs
   * S2S, depends on per-programme settings resolved server-side). Rather than
   * mint a URL from a guessed scheme — which would silently produce a
   * non-tracking link — we throw `NotImplementedError` until the contract can
   * be verified against a live account.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Affilae tracking links are minted server-side with a per-programme format that is not publicly ' +
        'documented; generateTrackingLink is unsupported pending live verification.',
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
      note: 'Requires a known programme id; not probed automatically.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Affilae does not expose click-level data to publishers via the documented API',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Tracking-link minting contract is not publicly documented; unsupported pending live verification.',
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
// Module-level registration (side effect — see Awin's adapter for rationale)
// ---------------------------------------------------------------------------

export const affilaeAdapter = new AffilaeAdapter();
registerAdapter(affilaeAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function requireToken(operation: string): string {
  return requireCredential('AFFILAE_API_TOKEN', {
    network: SLUG,
    operation,
    hint: 'Generate a token in the Affilae dashboard → API Tokens menu.',
  });
}

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
 * Split `[from, to]` into ≤`maxDays`-day chunks. Affilae does not publish a
 * hard per-call window cap, so we chunk conservatively (matching Awin's 31-day
 * cap) to stay within typical reporting limits and let callers request wider
 * windows naturally.
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

/**
 * Format a Date for Affilae's `from`/`to` query params. Affilae expects UTC
 * ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ); `toISOString()` produces exactly that.
 */
function formatAffilaeDate(d: Date): string {
  return d.toISOString();
}

// Internal test helpers — exported under `_internals` so they don't appear in
// the public adapter surface.
export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  centsToMajor,
  readCents,
  toTransaction,
  toProgramme,
  unwrapList,
  chunkDateRange,
  formatAffilaeDate,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
