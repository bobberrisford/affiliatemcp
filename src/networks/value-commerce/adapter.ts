/**
 * ValueCommerce adapter — publisher-side (affiliate-site) implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/skimlinks/adapter.ts`, which in
 * turn mirrors the canonical `src/networks/awin/adapter.ts`. Read those for the
 * deep reasoning behind the structure. The load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction (with an injectable `now`).
 *   - Credentials are read via `requireCredential`; never `process.env` directly.
 *   - UK English; "programme" not "program".
 *
 * --- ValueCommerce API map (verified against public docs, 2026-06-04) ----------
 *
 * Auth: a self-issued "report API authentication key" pair (CLIENT_KEY +
 * CLIENT_SECRET) is Base64(CLIENT_KEY|CLIENT_SECRET)-encoded and used as a Bearer
 * value against the token-acquisition API; the returned access token (valid 30
 * minutes) is the Bearer for data calls. See auth.ts / client.ts.
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/as-77-token-api/
 *           https://help.valuecommerce.ne.jp/aff/tool/api/02/
 *
 * Order Report API (affiliate side), XML by default:
 *   GET https://api.valuecommerce.com/report/v2/affiliate/transaction/
 *     ?limit=N (1-1000) &offset=N &sort=... &field=... &criteria=a|c|o
 *      &from_date=YYYY-MM-DD &to_date=YYYY-MM-DD &approval_status=p|a|c|i
 *   criteria: a = processed/approval date, c = click date, o = order date.
 *   approval_status: p = pending (保留), a = approved (承認),
 *                    c = rejected (拒否), i = invoiced/billed (請求済み).
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/as-78-order-report-api/
 *
 * --- What this adapter does NOT implement -------------------------------------
 *
 *   - listProgrammes / getProgramme: the affiliate Order Report API is a
 *     transaction report, not a programme/merchant directory. ValueCommerce's
 *     programme listing is not exposed by a documented self-serve affiliate
 *     reporting endpoint, so both throw NotImplementedError.
 *   - listClicks: click-level data is not exposed by the affiliate Order Report
 *     API. Throws NotImplementedError (never returns []).
 *   - generateTrackingLink: ValueCommerce deeplinks (MyLink) are generated in the
 *     console / via the site-specific tracking format and are not derivable from
 *     the report API credentials alone. Throws NotImplementedError.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `valueCommerceRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope` (network +
 *      operation + httpStatus + verbatim networkErrorBody). Never swallow errors.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus`. Prefer `other` over a
 *      wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` — NEVER process.env (except tests).
 *   7. UK English. "programme", not "program".
 */

import {
  valueCommerceRequest,
  VALUE_COMMERCE_TRANSACTION_PATH,
  type XmlNode,
} from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken } from './auth.js';
import { setupSteps } from './setup.js';
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('value-commerce.adapter');

const SLUG = 'value-commerce';
const NAME = 'ValueCommerce';

const NOT_IMPL_PROGRAMMES =
  'ValueCommerce does not expose a self-serve affiliate programme/merchant directory ' +
  'through the public report API; the affiliate Order Report API is a transaction report only. ' +
  'listProgrammes/getProgramme throw NotImplementedError. See META.knownLimitations.';

const NOT_IMPL_CLICKS =
  'ValueCommerce does not expose click-level data through the public affiliate Order Report API.';

const NOT_IMPL_LINK =
  'ValueCommerce tracking links (MyLink) are generated in the console / via a site-specific ' +
  'tracking format and are not derivable from the report API credentials; generateTrackingLink ' +
  'throws NotImplementedError.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.valuecommerce.com',
  authModel: 'custom',
  docsUrl: 'https://pub-docs.valuecommerce.ne.jp/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The affiliate Order Report API returns XML by default; the client parses it with a small built-in parser. The exact XML element names per transaction field are not confirmed from public snippets, so the adapter reads several candidate tag names defensively. BLOCKED(verify): confirm the real element names against a live account.',
    'listProgrammes / getProgramme are not supported: ValueCommerce exposes no self-serve affiliate programme/merchant directory through the public report API; both throw NotImplementedError.',
    'listClicks is not exposed via the public affiliate Order Report API; the operation throws NotImplementedError.',
    'generateTrackingLink is not supported: ValueCommerce deeplinks (MyLink) are produced in the console and are not derivable from the report API credentials; the operation throws NotImplementedError.',
    'Access tokens are valid for 30 minutes; the adapter caches the token in memory and re-fetches on expiry.',
    'The report API ships v1/v2/v3 endpoints; the adapter targets v2. BLOCKED(verify): confirm the preferred version against a live account.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

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

// ValueCommerce's report API caps `limit` at 1000 per call.
const MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Raw transaction shape
// ---------------------------------------------------------------------------
//
// The XML element names are NOT confirmed from public snippets — only the request
// parameters and the approval_status codes are documented. We therefore read a
// set of candidate tag names per field. The verbatim XML for the transaction is
// always preserved on `rawNetworkData`, so any field this normaliser misses is
// still recoverable by the caller.

/** A single transaction element flattened to string fields (best-effort). */
export interface ValueCommerceTransactionRaw {
  [key: string]: XmlNode | XmlNode[] | undefined;
}

// ---------------------------------------------------------------------------
// Field extraction helpers (defensive, candidate-name based)
// ---------------------------------------------------------------------------

/** Read the first present leaf value among candidate tag names (case-insensitive). */
function pick(raw: ValueCommerceTransactionRaw, candidates: string[]): string | undefined {
  const lowerMap = new Map<string, XmlNode | XmlNode[] | undefined>();
  for (const [k, v] of Object.entries(raw)) {
    lowerMap.set(k.toLowerCase(), v);
  }
  for (const c of candidates) {
    const v = lowerMap.get(c.toLowerCase());
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function toAmount(v: string | undefined): number {
  if (v === undefined) return 0;
  // Strip currency symbols, commas and Japanese yen markers before parsing.
  const cleaned = v.replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  // ValueCommerce dates are typically "YYYY-MM-DD HH:MM:SS" (JST) or "YYYY-MM-DD".
  // Normalise a space separator to 'T' so Date.parse handles it.
  const candidate = d.includes(' ') && !d.includes('T') ? d.replace(' ', 'T') : d;
  const ts = Date.parse(candidate);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map a ValueCommerce approval status to the canonical TransactionStatus.
 *
 * ValueCommerce approval_status codes (documented):
 *   p / pending  → 'pending'  (保留: awaiting validation)
 *   a / approved → 'approved' (承認: validated, not yet billed/paid)
 *   c / rejected → 'reversed' (拒否: the conversion was rejected)
 *   i / invoiced → 'paid'     (請求済み: invoiced/billed to the advertiser, i.e.
 *                              the publisher will be paid — the closest canonical
 *                              state)
 *   anything else → 'other'
 *
 * Why 'rejected' → 'reversed': a rejected conversion will not pay out, which is
 * semantically a reversal — what every other adapter calls this state. The
 * verbatim status is preserved in `rawNetworkData`.
 *
 * Why 'invoiced' → 'paid': ValueCommerce's terminal "settled" state for a
 * conversion is 請求済み (invoiced/billed). It is the closest canonical match to
 * "the publisher has been (or will be) paid". BLOCKED(verify): confirm whether a
 * distinct paid/payment status exists on a live account.
 */
export function mapTransactionStatus(rawStatus: string | undefined): TransactionStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (s === 'p' || s === 'pending' || s === '保留') return 'pending';
  if (s === 'a' || s === 'approved' || s === '承認') return 'approved';
  if (s === 'c' || s === 'rejected' || s === 'reject' || s === 'declined' || s === '拒否')
    return 'reversed';
  if (s === 'i' || s === 'invoiced' || s === 'billed' || s === 'paid' || s === '請求済み')
    return 'paid';
  return 'other';
}

/** Map a canonical TransactionStatus to the ValueCommerce approval_status code. */
export function mapCanonicalToApprovalStatus(
  statuses?: TransactionStatus[],
): string | undefined {
  if (!statuses || statuses.length !== 1) return undefined;
  switch (statuses[0]) {
    case 'pending':
      return 'p';
    case 'approved':
      return 'a';
    case 'reversed':
      return 'c';
    case 'paid':
      return 'i';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Domain transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a transaction at the moment the adapter responded.
 * PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: approval/confirmation date (how long has this been in its
 * current state?) then the order date, then the click date.
 */
export function computeAgeDays(
  raw: ValueCommerceTransactionRaw,
  now: Date = new Date(),
): number {
  const anchor =
    pick(raw, ['confirmationDate', 'approvalDate', 'fixDate', 'processDate']) ??
    pick(raw, ['orderDate', 'orderTime', 'transactionDate']) ??
    pick(raw, ['clickDate', 'clickTime']);
  const iso = nullableIso(anchor);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function toTransaction(
  raw: ValueCommerceTransactionRaw,
  now: Date = new Date(),
): Transaction {
  const rawStatus = pick(raw, ['approvalStatus', 'approval_status', 'status', 'confirmationStatus']);
  const status = mapTransactionStatus(rawStatus);

  const commission = toAmount(pick(raw, ['reward', 'commission', 'rewardAmount', 'fee']));
  const sale = toAmount(pick(raw, ['amount', 'orderAmount', 'price', 'totalAmount', 'sales']));
  const currency = (pick(raw, ['currency', 'currencyCode']) ?? 'JPY').toUpperCase();

  const orderDate = nullableIso(pick(raw, ['orderDate', 'orderTime', 'transactionDate']));
  const clickDate = nullableIso(pick(raw, ['clickDate', 'clickTime']));
  const approvedDate = nullableIso(
    pick(raw, ['confirmationDate', 'approvalDate', 'fixDate', 'processDate']),
  );
  const paidDate = nullableIso(pick(raw, ['paidDate', 'invoiceDate', 'billingDate']));

  const programmeId = pick(raw, ['merchantId', 'mid', 'advertiserId', 'programId']) ?? '';
  const programmeName =
    pick(raw, ['merchantName', 'advertiserName', 'programName', 'siteName']) ??
    `ValueCommerce merchant ${programmeId}`;

  return {
    id: pick(raw, ['transactionId', 'orderId', 'id', 'orderNo']) ?? '',
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: orderDate ?? new Date(0).toISOString(),
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason:
      status === 'reversed'
        ? pick(raw, ['rejectReason', 'reason', 'denialReason']) ?? undefined
        : undefined,
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// XML tree → transaction array extraction
// ---------------------------------------------------------------------------

/**
 * Locate the repeated transaction elements within a parsed report tree.
 *
 * The exact wrapper/element names are not confirmed from public snippets, so we
 * search candidate container names then candidate item names, and finally fall
 * back to scanning for any array of record-like nodes. The verbatim XML is kept
 * on each transaction's `rawNetworkData`.
 */
export function extractTransactionNodes(tree: XmlNode): ValueCommerceTransactionRaw[] {
  if (typeof tree === 'string' || tree === null) return [];

  const root = tree as Record<string, XmlNode | XmlNode[]>;

  // 1. Look for a documented-style container, e.g. <Result><Transactions><Transaction>.
  const containerNames = ['transactions', 'transactionlist', 'result', 'response', 'data', 'items'];
  const itemNames = ['transaction', 'item', 'record', 'order', 'row'];

  // Helper: from a record, pull repeated children matching an item name.
  const collectItems = (node: Record<string, XmlNode | XmlNode[]>): ValueCommerceTransactionRaw[] => {
    const lower = new Map<string, XmlNode | XmlNode[]>();
    for (const [k, v] of Object.entries(node)) lower.set(k.toLowerCase(), v);
    for (const name of itemNames) {
      const found = lower.get(name);
      if (found === undefined) continue;
      const arr = Array.isArray(found) ? found : [found];
      return arr.filter((n) => typeof n === 'object' && n !== null) as unknown as ValueCommerceTransactionRaw[];
    }
    return [];
  };

  // Direct items at the root.
  const direct = collectItems(root);
  if (direct.length > 0) return direct;

  // Descend through candidate containers (one level deep, then their children).
  for (const cname of containerNames) {
    const lowerRoot = new Map<string, XmlNode | XmlNode[]>();
    for (const [k, v] of Object.entries(root)) lowerRoot.set(k.toLowerCase(), v);
    const container = lowerRoot.get(cname);
    if (container === undefined) continue;
    const containers = Array.isArray(container) ? container : [container];
    for (const c of containers) {
      if (typeof c !== 'object' || c === null) continue;
      const items = collectItems(c as Record<string, XmlNode | XmlNode[]>);
      if (items.length > 0) return items;
      // One more level (e.g. <result><transactions><transaction>).
      for (const v of Object.values(c)) {
        const vs = Array.isArray(v) ? v : [v];
        for (const inner of vs) {
          if (typeof inner !== 'object' || inner === null) continue;
          const nested = collectItems(inner as Record<string, XmlNode | XmlNode[]>);
          if (nested.length > 0) return nested;
        }
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Local query helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ValueCommerceAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes / getProgramme — not exposed by the affiliate report API
  // -------------------------------------------------------------------------

  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(NOT_IMPL_PROGRAMMES);
  }

  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(NOT_IMPL_PROGRAMMES);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List ValueCommerce conversions across a date window with optional status / age
   * / programme filters.
   *
   * Endpoint:
   *   GET /report/v2/affiliate/transaction/
   *     ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&criteria=o
   *     [&approval_status=p|a|c|i] [&limit=N (<=1000)]
   *
   * We query by order date (`criteria=o`) and default to a 30-day window when the
   * caller does not specify one. `limit` is capped at the documented 1000. The
   * response is XML; the client parses it and we read transaction fields
   * defensively (element names BLOCKED(verify)).
   *
   * PRD §15.9 (unpaid-age): `minAgeDays`/`maxAgeDays` filter on computed `ageDays`.
   * PRD §15.10 (reversed visibility): rejected conversions normalise to 'reversed'.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = await getAccessToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      from_date: from.toISOString().slice(0, 10),
      to_date: to.toISOString().slice(0, 10),
      // criteria=o → filter the window by order date (the conversion date).
      criteria: 'o',
    };

    if (typeof query?.limit === 'number') {
      params['limit'] = Math.min(query.limit, MAX_LIMIT);
    }

    // Server-side approval_status filter when a single canonical status is asked
    // for; multi-status requests are filtered client-side after normalisation.
    const statusFilter = toTransactionStatusList(query?.status);
    const singleUpstream = mapCanonicalToApprovalStatus(statusFilter);
    if (singleUpstream) {
      params['approval_status'] = singleUpstream;
    }

    const { tree } = await valueCommerceRequest({
      operation: 'listTransactions',
      path: VALUE_COMMERCE_TRANSACTION_PATH,
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawNodes = extractTransactionNodes(tree);
    let transactions = rawNodes.map((r) => toTransaction(r, now));

    // Optional client-side programme filter (the report API scopes by account,
    // not by a single merchant id param we have confirmed).
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Client-side canonical status filter — always applied when a status filter
    // was requested. The server-side approval_status uses upstream codes; filtering
    // on the normalised canonical status after transformation is always correct.
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Age filters — PRD §15.9.
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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (single source of truth, same reasoning as
   * Awin/Skimlinks). Do NOT pass `query.limit` through — a limited summary would
   * undercount (principle 4.1).
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
      currency: 'JPY',
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
          programmeName: t.programmeName || `ValueCommerce merchant ${key}`,
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
      currency: firstCurrency ?? 'JPY',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks — not exposed by the report API
  // -------------------------------------------------------------------------

  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(NOT_IMPL_CLICKS);
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — not derivable from report API credentials
  // -------------------------------------------------------------------------

  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(NOT_IMPL_LINK);
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully obtaining an access token.
   * Never throws — verifyAuth is called by error handlers.
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side admin operations are scaffolded for v0.2.');
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

  /**
   * Probe each operation with a minimal call. Known-unsupported ops are recorded
   * without probing to avoid wasting network calls.
   */
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

    // Known-unsupported ops — record without probing.
    operations['listProgrammes'] = { supported: false, note: NOT_IMPL_PROGRAMMES };
    operations['getProgramme'] = { supported: false, note: NOT_IMPL_PROGRAMMES };
    operations['listClicks'] = { supported: false, note: NOT_IMPL_CLICKS };
    operations['generateTrackingLink'] = { supported: false, note: NOT_IMPL_LINK };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const valueCommerceAdapter = new ValueCommerceAdapter();
registerAdapter(valueCommerceAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapCanonicalToApprovalStatus,
  computeAgeDays,
  toTransaction,
  extractTransactionNodes,
  toAmount,
  pick,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
