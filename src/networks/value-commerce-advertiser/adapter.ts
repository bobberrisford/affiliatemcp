/**
 * ValueCommerce advertiser (brand / EC / 広告主) adapter.
 *
 * READ-ONLY at v0.1. Mirrors the canonical advertiser reference
 * (`src/networks/impact-advertiser/adapter.ts`) for structure, and reuses the
 * publisher ValueCommerce adapter's dependency-free XML parser + token logic
 * (the EC report XML shape is the same family as the affiliate report XML).
 *
 * The adapter receives a `ctx?: AdapterCallContext` from the tool dispatcher
 * carrying `networkBrandId` — for ValueCommerce this is the advertiser's own
 * site / programme id (the PID the brand runs). Brand-scoped operations REQUIRE
 * the context; without it we cannot scope to a programme, so we throw a
 * `config_error` envelope rather than guessing.
 *
 * The ValueCommerce docs site is Japanese and returns 403 to automated WebFetch,
 * so endpoint shapes were corroborated via search snippets (same approach as the
 * publisher adapter). Element names carry `BLOCKED(verify)` markers.
 *
 * --- ValueCommerce advertiser API map ------------------------------------------
 *
 * Auth: a self-issued report API authentication key pair (CLIENT_KEY +
 * CLIENT_SECRET) is Base64(CLIENT_KEY|CLIENT_SECRET)-encoded and used as a Bearer
 * value against the EC token-acquisition API; the returned access token (valid 30
 * minutes) is the Bearer for data calls. See auth.ts / client.ts.
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/ec-74-token-api/
 *           https://help.valuecommerce.ne.jp/aff/tool/api/02/
 *
 * EC Order Report API (advertiser side), XML by default:
 *   GET https://api.valuecommerce.com/report/v2/merchant/transaction/
 *     ?limit=N (1-1000) &offset=N &sort=... &field=... &criteria=a|c|o
 *      &from_date=YYYY-MM-DD &to_date=YYYY-MM-DD &approval_status=p|a|c|i
 *   criteria: a = processed/approval date, c = click date, o = order date.
 *   approval_status: p = pending (保留), a = approved (承認),
 *                    c = rejected (拒否), i = invoiced/billed (請求済み).
 *   Rows carry the publisher site id (sid) so the report can be grouped by
 *   publisher.
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/ec-75-order-report-api/
 *
 * Operations:
 *   listBrands              → derive the advertiser's sites/programmes (PIDs) from
 *                             the EC report over a recent window (no documented
 *                             self-serve site-directory endpoint). BLOCKED(verify).
 *   verifyAuth              → reuse the token-acquisition probe in auth.ts.
 *   getProgrammePerformance → EC order report grouped by publisher (sid).
 *   listTransactions        → EC order report rows, brand-scoped (per programme).
 *   listProgrammes          → the advertiser's sites/programmes (same derivation
 *                             as listBrands, surfaced as Programme[]).
 *
 * Operations NOT in scope at v0.1 (throw NotImplementedError):
 *   getProgramme, getEarningsSummary, listClicks, generateTrackingLink,
 *   listPublishers, listPublisherSectors.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. NEVER call `fetch` outside `client.ts`. Use `valueCommerceAdvRequest`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope` (network +
 *      operation + httpStatus + verbatim networkErrorBody). Never swallow errors.
 *   3. PRESERVE the raw payload in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapPerformanceStatus` / `mapTransactionStatus`.
 *      Prefer the closest canonical state over a wrong guess.
 *   5. NEVER issue a non-GET request. The client enforces this; the adapter must
 *      not work around it.
 *   6. UK English. "programme", not "program".
 */

import {
  valueCommerceAdvRequest,
  VALUE_COMMERCE_ADV_TRANSACTION_PATH,
  type XmlNode,
} from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getAccessToken, SLUG } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type AdapterCallContext,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type DiscoveredBrand,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammePerformanceQuery,
  type ProgrammePerformanceRow,
  type ProgrammeQuery,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('value-commerce-advertiser.adapter');

const NAME = 'ValueCommerce (advertiser)';

const NOT_IMPL_GET_PROGRAMME =
  'ValueCommerce advertiser adapter does not implement getProgramme at v0.1; use listProgrammes ' +
  'and filter client-side.';

const NOT_IMPL_EARNINGS =
  'ValueCommerce advertiser adapter does not implement getEarningsSummary at v0.1; use ' +
  'getProgrammePerformance for the per-publisher rollup.';

const NOT_IMPL_CLICKS =
  'ValueCommerce advertiser adapter does not expose click-level data through the EC Order Report ' +
  'API; listClicks throws NotImplementedError.';

const NOT_IMPL_LINK =
  'ValueCommerce tracking-link generation is a publisher-side operation; the advertiser adapter ' +
  'does not implement generateTrackingLink.';

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
    'Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a report-only API authentication key from the advertiser console for defence in depth.',
    'The EC Order Report API returns XML by default; the client parses it with a small built-in parser. The exact XML element names per field are not confirmed from public snippets, so the adapter reads several candidate tag names defensively. BLOCKED(verify): confirm the real element names against a live account.',
    'getProgrammePerformance groups EC report rows by the publisher site id (sid) client-side. BLOCKED(verify): confirm the sid element name and whether a server-side group-by exists.',
    'listBrands / listProgrammes derive the advertiser sites/programmes from the EC report over a recent window (no documented self-serve site-directory endpoint). BLOCKED(verify).',
    'getProgramme / getEarningsSummary / listClicks / generateTrackingLink are not implemented (NotImplementedError).',
    'Access tokens are valid for 30 minutes; the adapter caches the token in memory and re-fetches on expiry.',
    'The EC Order Report API ships v1/v2 endpoints; the adapter targets v2. BLOCKED(verify): confirm the preferred version against a live account.',
  ],
  supportsBrandOps: true,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
  side: 'advertiser',
  credentialScope: 'multi-brand',
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

const REPORT_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 60_000,
  retries: 3,
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  listTransactions: REPORT_RESILIENCE,
  getProgrammePerformance: REPORT_RESILIENCE,
};

// ValueCommerce's report API caps `limit` at 1000 per call.
const MAX_LIMIT = 1000;

// The default lookback window (days) used when the caller does not supply one.
const DEFAULT_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// ctx guard
// ---------------------------------------------------------------------------

/**
 * Require an `AdapterCallContext` on brand-scoped advertiser operations. We
 * throw a `config_error` envelope so the user sees a clear "this op needs
 * `brand`" rather than a runtime TypeError when ctx is missing — this can happen
 * if a future caller bypasses the tool dispatcher.
 */
function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `ValueCommerce advertiser ${operation} requires a brand context (networkBrandId).`,
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId (the ValueCommerce site/programme id) via brands.json.',
      }),
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Raw report-row shape
// ---------------------------------------------------------------------------
//
// The XML element names are NOT confirmed from public snippets — only the request
// parameters and approval_status codes are documented. We therefore read a set of
// candidate tag names per field. The verbatim XML for the row is always preserved
// on `rawNetworkData`, so any field this normaliser misses is recoverable.

/** A single EC report row flattened to string fields (best-effort). */
export interface ValueCommerceAdvRowRaw {
  [key: string]: XmlNode | XmlNode[] | undefined;
}

// ---------------------------------------------------------------------------
// Field extraction helpers (defensive, candidate-name based)
// ---------------------------------------------------------------------------

/** Read the first present leaf value among candidate tag names (case-insensitive). */
function pick(raw: ValueCommerceAdvRowRaw, candidates: string[]): string | undefined {
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

// Candidate tag names for the publisher site id and name (BLOCKED(verify)).
const PUBLISHER_ID_TAGS = ['sid', 'siteId', 'site_id', 'affiliateId', 'publisherId', 'memberId'];
const PUBLISHER_NAME_TAGS = ['siteName', 'site_name', 'affiliateName', 'publisherName', 'memberName'];
// Candidate tag names for the advertiser programme / site id (the networkBrandId).
const PROGRAMME_ID_TAGS = ['pid', 'programId', 'program_id', 'merchantId', 'mid', 'advertiserId'];

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map a ValueCommerce approval status code to the canonical TransactionStatus.
 *
 * ValueCommerce approval_status codes (documented):
 *   p / pending  → 'pending'  (保留: awaiting validation)
 *   a / approved → 'approved' (承認: validated, not yet billed/paid)
 *   c / rejected → 'reversed' (拒否: the conversion was rejected)
 *   i / invoiced → 'paid'     (請求済み: invoiced/billed to the advertiser)
 *   anything else → 'other'
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

/**
 * Map a ValueCommerce approval status to the three canonical performance-row
 * states. The performance row only carries pending|approved|reversed; the EC
 * "invoiced/billed" (i) terminal state is collapsed to 'approved' (the
 * conversion was validated and will pay out). The verbatim code is preserved on
 * `rawNetworkData`.
 */
export function mapPerformanceStatus(rawStatus: string | undefined): ProgrammePerformanceRow['status'] {
  const t = mapTransactionStatus(rawStatus);
  if (t === 'reversed') return 'reversed';
  if (t === 'approved' || t === 'paid') return 'approved';
  return 'pending';
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
 * Compute the age (in days) of a row at the moment the adapter responded.
 * Anchor priority: approval/confirmation date, then order date, then click date.
 */
export function computeAgeDays(raw: ValueCommerceAdvRowRaw, now: Date = new Date()): number {
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

export function toTransaction(raw: ValueCommerceAdvRowRaw, now: Date = new Date()): Transaction {
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

  // On the advertiser side the "programme" is the advertiser's own site/PID; the
  // counterparty is the publisher (sid). We record the publisher as the
  // programmeName context so a brand operator can see which partner converted.
  const programmeId = pick(raw, PROGRAMME_ID_TAGS) ?? '';
  const publisherName = pick(raw, PUBLISHER_NAME_TAGS);
  const publisherId = pick(raw, PUBLISHER_ID_TAGS);
  const programmeName =
    publisherName ??
    (publisherId ? `ValueCommerce publisher ${publisherId}` : `ValueCommerce programme ${programmeId}`);

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

/** Map a single EC report row to one (un-aggregated) performance row. */
export function toPerformanceRow(raw: ValueCommerceAdvRowRaw): ProgrammePerformanceRow {
  const rawDate =
    pick(raw, ['orderDate', 'orderTime', 'transactionDate']) ??
    pick(raw, ['confirmationDate', 'approvalDate']) ??
    pick(raw, ['clickDate', 'clickTime']);
  const iso = nullableIso(rawDate);
  const date = iso ? iso.slice(0, 10) : '';

  const publisherId = pick(raw, PUBLISHER_ID_TAGS) ?? '';
  const publisherName = pick(raw, PUBLISHER_NAME_TAGS) ?? (publisherId ? `ValueCommerce publisher ${publisherId}` : '');
  const grossSale = toAmount(pick(raw, ['amount', 'orderAmount', 'price', 'totalAmount', 'sales']));
  const commission = toAmount(pick(raw, ['reward', 'commission', 'rewardAmount', 'fee']));
  const currency = (pick(raw, ['currency', 'currencyCode']) ?? 'JPY').toUpperCase();

  return {
    date,
    publisherId,
    publisherName,
    // The EC order report is order-level, not click-level: each row is one
    // conversion, so clicks is 0 and conversions is 1.
    clicks: 0,
    conversions: 1,
    grossSale,
    commission,
    currency,
    status: mapPerformanceStatus(
      pick(raw, ['approvalStatus', 'approval_status', 'status', 'confirmationStatus']),
    ),
    rawNetworkData: raw,
  };
}

/**
 * Aggregate per-order performance rows into one row per (publisher, date,
 * status) tuple. The EC order report is order-level; this rollup gives the
 * caller a per-publisher view aligned with the canonical
 * `getProgrammePerformance` contract.
 */
export function aggregateByPublisher(rows: ProgrammePerformanceRow[]): ProgrammePerformanceRow[] {
  const map = new Map<string, ProgrammePerformanceRow>();
  for (const r of rows) {
    const key = `${r.publisherId}|${r.date}|${r.status}|${r.currency}`;
    const existing = map.get(key);
    if (existing) {
      existing.conversions += r.conversions;
      existing.clicks += r.clicks;
      existing.grossSale += r.grossSale;
      existing.commission += r.commission;
      // Preserve raw as a growing array so each underlying order is recoverable.
      (existing.rawNetworkData as unknown[]).push(r.rawNetworkData);
    } else {
      map.set(key, {
        ...r,
        rawNetworkData: [r.rawNetworkData],
      });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// XML tree → row array extraction
// ---------------------------------------------------------------------------

/**
 * Locate the repeated transaction/order elements within a parsed report tree.
 *
 * The exact wrapper/element names are not confirmed from public snippets, so we
 * search candidate container names then candidate item names, and finally fall
 * back to scanning for any array of record-like nodes. The verbatim XML is kept
 * on each row's `rawNetworkData`.
 */
export function extractRowNodes(tree: XmlNode): ValueCommerceAdvRowRaw[] {
  if (typeof tree === 'string' || tree === null) return [];

  const root = tree as Record<string, XmlNode | XmlNode[]>;

  const containerNames = ['transactions', 'transactionlist', 'result', 'response', 'data', 'items'];
  const itemNames = ['transaction', 'item', 'record', 'order', 'row'];

  const collectItems = (node: Record<string, XmlNode | XmlNode[]>): ValueCommerceAdvRowRaw[] => {
    const lower = new Map<string, XmlNode | XmlNode[]>();
    for (const [k, v] of Object.entries(node)) lower.set(k.toLowerCase(), v);
    for (const name of itemNames) {
      const found = lower.get(name);
      if (found === undefined) continue;
      const arr = Array.isArray(found) ? found : [found];
      return arr.filter((n) => typeof n === 'object' && n !== null) as unknown as ValueCommerceAdvRowRaw[];
    }
    return [];
  };

  const direct = collectItems(root);
  if (direct.length > 0) return direct;

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

/** Build the from/to window (YYYY-MM-DD) defaulting to the recent window. */
function resolveWindow(from?: string, to?: string, now: Date = new Date()): { from: string; to: string } {
  const toDate = to ? new Date(to) : now;
  const fromDate = from
    ? new Date(from)
    : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
}

/**
 * Fetch raw EC report rows for the configured credential over a window. Shared
 * by listTransactions, getProgrammePerformance, listBrands, and listProgrammes.
 */
async function fetchReportRows(
  operation: string,
  opts: {
    from?: string;
    to?: string;
    approvalStatus?: string;
    limit?: number;
    now: Date;
  },
): Promise<ValueCommerceAdvRowRaw[]> {
  const token = await getAccessToken();
  const window = resolveWindow(opts.from, opts.to, opts.now);

  const params: Record<string, string | number | undefined> = {
    from_date: window.from,
    to_date: window.to,
    // criteria=o → filter the window by order date (the conversion date).
    criteria: 'o',
  };
  if (typeof opts.limit === 'number') {
    params['limit'] = Math.min(opts.limit, MAX_LIMIT);
  }
  if (opts.approvalStatus) {
    params['approval_status'] = opts.approvalStatus;
  }

  const { tree } = await valueCommerceAdvRequest({
    operation,
    path: VALUE_COMMERCE_ADV_TRANSACTION_PATH,
    token,
    query: params,
    resilience: RESILIENCE[operation as keyof ResilienceConfigMap] ?? RESILIENCE.default,
  });

  return extractRowNodes(tree);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ValueCommerceAdvertiserAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listBrands — the multi-brand-discovery hook for the wizard.
  // -------------------------------------------------------------------------

  /**
   * Enumerate the advertiser's sites/programmes (PIDs) the credential addresses.
   *
   * BLOCKED(verify): ValueCommerce exposes no documented self-serve site-directory
   * endpoint for the advertiser report key. We therefore derive the addressable
   * programmes from the EC report over a recent window: each distinct programme
   * id (PID) becomes one DiscoveredBrand. Confirm against a live account; a
   * dedicated directory endpoint may exist behind the console.
   */
  async listBrands(): Promise<DiscoveredBrand[]> {
    const now = new Date();
    const rows = await fetchReportRows('verifyAuth', { limit: MAX_LIMIT, now });

    const byId = new Map<string, DiscoveredBrand>();
    for (const r of rows) {
      const id = pick(r, PROGRAMME_ID_TAGS);
      if (!id) continue;
      if (byId.has(id)) continue;
      const name = pick(r, ['programName', 'merchantName', 'advertiserName', 'siteName']);
      byId.set(id, {
        networkBrandId: id,
        displayName: name ?? `ValueCommerce programme ${id}`,
        apiEnabled: true,
      });
    }
    return [...byId.values()];
  }

  // -------------------------------------------------------------------------
  // verifyAuth — reuse the token-acquisition probe.
  // -------------------------------------------------------------------------

  async verifyAuth(
    _ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // listProgrammes — the advertiser's own sites/programmes.
  // -------------------------------------------------------------------------

  /**
   * Surface the advertiser's sites/programmes as Programme[]. Same derivation as
   * listBrands (BLOCKED(verify) — derived from the EC report). Not brand-scoped:
   * it enumerates everything the credential addresses, so a ctx is optional.
   */
  async listProgrammes(query?: ProgrammeQuery, _ctx?: AdapterCallContext): Promise<Programme[]> {
    const brands = await this.listBrands();
    let programmes: Programme[] = brands.map((b) => ({
      id: b.networkBrandId,
      name: b.displayName,
      network: SLUG,
      status: 'joined',
      currency: 'JPY',
      rawNetworkData: b,
    }));
    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  // -------------------------------------------------------------------------
  // listTransactions — EC order report rows, brand-scoped.
  // -------------------------------------------------------------------------

  /**
   * List EC order-report rows for one of the advertiser's programmes.
   *
   * Brand-scoped: requires ctx.networkBrandId (the advertiser site/PID). The EC
   * report is scoped by the credential, not by a confirmed server-side programme
   * filter, so we filter to the requested programme client-side after
   * normalisation. Status/age filters mirror the publisher adapter.
   */
  async listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]> {
    const c = requireCtx('listTransactions', ctx);
    const now = new Date();

    const statusFilter = toTransactionStatusList(query?.status);
    const singleUpstream = mapCanonicalToApprovalStatus(statusFilter);

    const rawNodes = await fetchReportRows('listTransactions', {
      from: query?.from,
      to: query?.to,
      approvalStatus: singleUpstream,
      limit: query?.limit,
      now,
    });

    let transactions = rawNodes.map((r) => toTransaction(r, now));

    // Brand scope: keep only rows belonging to the requested programme/PID.
    transactions = transactions.filter((t) => t.programmeId === c.networkBrandId);

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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getProgrammePerformance — per-publisher rollup of the EC order report.
  // -------------------------------------------------------------------------

  /**
   * Group the EC order report by publisher (site id / sid) for one of the
   * advertiser's programmes. Brand-scoped: requires ctx.networkBrandId.
   *
   * The EC report is order-level; we map each row to a per-order performance row
   * (conversions=1) then aggregate by (publisher, date, status). BLOCKED(verify):
   * the sid element name and whether a server-side group-by exists.
   */
  async getProgrammePerformance(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]> {
    const c = requireCtx('getProgrammePerformance', ctx);
    const now = new Date();

    const rawNodes = await fetchReportRows('getProgrammePerformance', {
      from: query?.from,
      to: query?.to,
      limit: query?.limit ? Math.min(query.limit * 50, MAX_LIMIT) : MAX_LIMIT,
      now,
    });

    // Scope to the requested programme/PID (the brand the caller asked about).
    const scoped = rawNodes.filter((r) => {
      const pid = pick(r, PROGRAMME_ID_TAGS);
      // If no programme id is present on a row, keep it — the credential is
      // already scoped to the advertiser; otherwise match the requested PID.
      return pid === undefined || pid === c.networkBrandId;
    });

    let rows = scoped.map(toPerformanceRow);

    if (query?.publisherId) {
      rows = rows.filter((r) => r.publisherId === query.publisherId);
    }

    let aggregated = aggregateByPublisher(rows);
    if (typeof query?.limit === 'number') aggregated = aggregated.slice(0, query.limit);
    return aggregated;
  }

  // -------------------------------------------------------------------------
  // Ops the advertiser side does NOT implement at v0.1.
  // -------------------------------------------------------------------------

  async getProgramme(_programmeId: string, _ctx?: AdapterCallContext): Promise<Programme> {
    throw new NotImplementedError(NOT_IMPL_GET_PROGRAMME);
  }

  async getEarningsSummary(
    _query?: TransactionQuery,
    _ctx?: AdapterCallContext,
  ): Promise<EarningsSummary> {
    throw new NotImplementedError(NOT_IMPL_EARNINGS);
  }

  async listClicks(_query?: ClickQuery, _ctx?: AdapterCallContext): Promise<Click[]> {
    throw new NotImplementedError(NOT_IMPL_CLICKS);
  }

  async generateTrackingLink(
    _input: { programmeId: string; destinationUrl: string },
    _ctx?: AdapterCallContext,
  ): Promise<TrackingLink> {
    throw new NotImplementedError(NOT_IMPL_LINK);
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError(
      'Use getProgrammePerformance for the advertiser-side per-publisher rollup.',
    );
  }

  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Not implemented for ValueCommerce advertiser at v0.1.');
  }

  // -------------------------------------------------------------------------
  // Setup + diagnostics
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    operations['verifyAuth'] = {
      supported: true,
      note: 'Live token-acquisition probe runs at wizard time; not re-probed here.',
    };
    operations['listBrands'] = {
      supported: true,
      note:
        'Multi-brand discovery hook. Marked experimental: derived from the EC report over a recent ' +
        'window because no self-serve site-directory endpoint is documented. BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['listProgrammes'] = {
      supported: true,
      note: 'Derived from the EC report (same source as listBrands). BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['listTransactions'] = {
      supported: true,
      note: 'EC order report rows, scoped to the requested programme. Element names BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['getProgrammePerformance'] = {
      supported: true,
      note: 'EC order report grouped by publisher (sid) client-side. sid element name BLOCKED(verify).',
      claimStatus: 'experimental',
    };
    operations['getProgramme'] = { supported: false, note: NOT_IMPL_GET_PROGRAMME };
    operations['getEarningsSummary'] = { supported: false, note: NOT_IMPL_EARNINGS };
    operations['listClicks'] = { supported: false, note: NOT_IMPL_CLICKS };
    operations['generateTrackingLink'] = { supported: false, note: NOT_IMPL_LINK };

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

export const valueCommerceAdvertiserAdapter = new ValueCommerceAdvertiserAdapter();
registerAdapter(valueCommerceAdvertiserAdapter);

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapPerformanceStatus,
  mapCanonicalToApprovalStatus,
  computeAgeDays,
  toTransaction,
  toPerformanceRow,
  aggregateByPublisher,
  extractRowNodes,
  toAmount,
  pick,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
