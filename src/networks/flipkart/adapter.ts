/**
 * Flipkart Affiliate adapter (publisher side, single-brand).
 *
 * Patterned on the canonical reference `src/networks/awin/adapter.ts`; read
 * that file's header for the full reasoning behind the structure. The
 * Flipkart-specific divergences are documented inline with "why" comments.
 *
 * --- What Flipkart is, in this project's terms -----------------------------
 *
 * Flipkart Affiliate is a single-merchant programme: there is exactly one
 * "merchant" (Flipkart itself, the Indian marketplace) and the publisher is
 * either in the programme or not. There is no catalogue of advertisers to
 * join. We therefore model ONE synthetic programme so the discovery
 * operations (`listProgrammes` / `getProgramme`) still return something
 * meaningful and the canonical contract holds. The product feed exposes
 * categories, not programmes, so categories are surfaced on that single
 * programme rather than as programmes in their own right.
 *
 * --- Flipkart API map (verify against the API docs) ------------------------
 *
 *   Docs:  https://affiliate.flipkart.com/api-docs/af_overview.html
 *          https://affiliate.flipkart.com/api-docs/af_report_ref.html
 *          https://affiliate.flipkart.com/api-docs/af_register.html
 *   Base:  https://affiliate-api.flipkart.net
 *   Auth:  Fk-Affiliate-Id + Fk-Affiliate-Token custom headers (see client.ts).
 *
 *   GET /affiliate/api/{trackingId}.json
 *     → Product Feed Listing: `apiListings` keyed by category, each with the
 *       product-feed URL. Used by verifyAuth and to seed programme categories.
 *   GET /affiliate/report/orders/detail/json
 *     ?startDate=YYYY-MM-DD &endDate=YYYY-MM-DD &status=... &offset=0
 *     → Orders report: `{ orderList: [...] }`. The transactions source.
 *
 * --- Cardinal rules (same as Awin) ------------------------------------------
 *
 *   1. NEVER call `fetch` directly. Use `flipkartRequest` from `./client.ts`.
 *   2. EVERY failure round-trips through a `NetworkErrorEnvelope`.
 *   3. PRESERVE the verbatim upstream payload in `rawNetworkData`.
 *   4. NORMALISE status enums to the canonical set; document the mapping.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string ("programme", not "program").
 */

import { flipkartRequest } from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  requireAffiliateId,
  requireToken,
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

const log = createLogger('flipkart.adapter');

const SLUG = 'flipkart';
const NAME = 'Flipkart Affiliate';

/**
 * The single programme id Flipkart exposes. Flipkart is one merchant, so we
 * mint a stable synthetic id. `getProgramme` only accepts this value.
 */
const FLIPKART_PROGRAMME_ID = 'flipkart';

/**
 * Flipkart reports and feeds are denominated in Indian Rupees. The orders
 * report `sales`/`tentativeCommission` objects carry a `currency` field which
 * we read per-row; this constant is the fallback when a row omits it.
 */
const DEFAULT_CURRENCY = 'INR';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://affiliate-api.flipkart.net',
  // Two custom headers (Fk-Affiliate-Id + Fk-Affiliate-Token), not a Bearer
  // token — hence `custom`.
  authModel: 'custom',
  docsUrl: 'https://affiliate.flipkart.com/api-docs/af_overview.html',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // `experimental`: the adapter has not been validated against a live Flipkart
  // account at commit time and the orders-report amount unit is assumed rather
  // than confirmed (see knownLimitations).
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: the adapter has not been validated against a live Flipkart affiliate account.',
    'Order/commission amounts are assumed to be in Indian Rupees (INR) as whole-rupee decimal values; the orders report does not document the minor-unit convention, so amounts are surfaced verbatim from the `amount` field without rescaling.',
    'Flipkart periodically pauses new affiliate signups, so the programme may be closed to new applicants when you attempt to register.',
    'Click-level data is not exposed via the public affiliate API; listClicks is unsupported.',
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

/**
 * The orders report can be slow when a wide date window holds many rows and
 * paginates over several offset pages. We give it a longer timeout and an
 * extra retry, mirroring Awin's treatment of its transactions endpoint.
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
// Flipkart response shapes (deliberately minimal; every field optional)
// ---------------------------------------------------------------------------
//
// We do not model these with strict schemas — the transformers read keys
// defensively and preserve the raw payload under `rawNetworkData`, so a field
// rename upstream degrades gracefully rather than throwing a schema error.

interface FlipkartMoney {
  amount?: number;
  currency?: string;
}

interface FlipkartOrderRaw {
  affiliateOrderItemId?: string;
  productId?: string;
  title?: string;
  category?: string;
  quantity?: number;
  price?: number;
  status?: string;
  orderDate?: string;
  commissionRate?: number;
  sales?: FlipkartMoney;
  tentativeCommission?: FlipkartMoney;
  affExtParam1?: string;
  affExtParam2?: string;
  salesChannel?: string;
  customerType?: string;
}

interface FlipkartOrdersResponse {
  orderList?: FlipkartOrderRaw[];
  // Flipkart paginates with HATEOAS-style links; we only act on `next`.
  // The shape varies (object vs array), so we read it defensively below.
  first?: string;
  last?: string;
  next?: string;
  previous?: string;
}

interface FlipkartFeedListing {
  apiListings?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Flipkart orders report → canonical.
 *
 * Flipkart's `status` values (per the report API docs):
 *   pending    — order placed, commission computed but not yet confirmed.
 *   tentative  — similar to pending (commission still provisional).
 *   approved   — commission confirmed for the order.
 *   cancelled  — order returned / cancelled / rejected (no payout).
 *
 * Mapping:
 *   pending | tentative → 'pending'   (both mean "not yet confirmed")
 *   approved            → 'approved'
 *   cancelled           → 'reversed'  (the user did not get paid; "reversed"
 *                                       is what every other network calls this)
 *   anything else       → 'other'     (never invent a status the user did not see)
 *
 * Flipkart does not expose a "paid" status on the orders report, so 'paid' is
 * never produced here. Approved-but-unpaid is the closest observable state and
 * is what the unpaid-age affordance keys off.
 */
function mapOrderStatus(raw: FlipkartOrderRaw): TransactionStatus {
  switch ((raw.status ?? '').toLowerCase()) {
    case 'pending':
    case 'tentative':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'cancelled':
    case 'canceled':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Map a canonical TransactionStatus to the Flipkart `status` query value.
 *
 * Flipkart accepts a single `status` filter per call. We only translate the
 * statuses Flipkart exposes; 'paid' has no Flipkart equivalent, and 'other'
 * is not a filterable value, so both fall through to "no server-side filter"
 * (the caller's status filter is then applied client-side after the fetch).
 */
function pickFlipkartStatus(statuses?: TransactionStatus[]): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  // Only narrow server-side when the caller asked for exactly one mappable
  // status; mixed requests are filtered client-side to avoid undercounting.
  if (statuses.length === 1) {
    switch (statuses[0]) {
      case 'pending':
        return 'pending';
      case 'approved':
        return 'approved';
      case 'reversed':
        return 'cancelled';
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Compute the age (in days) of an order at the moment this adapter responded.
 *
 * Flipkart exposes only `orderDate` on the report (no separate approval or
 * payment date), so age is anchored on the conversion date. This is honest:
 * "this order from N days ago is still pending" is the affordance, and N is
 * orderDate-relative.
 */
function computeAgeDays(raw: FlipkartOrderRaw, now: Date = new Date()): number {
  if (!raw.orderDate) return 0;
  const t = Date.parse(raw.orderDate);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transformers (Flipkart raw → canonical domain types)
// ---------------------------------------------------------------------------

function toTransaction(raw: FlipkartOrderRaw, now: Date = new Date()): Transaction {
  const status = mapOrderStatus(raw);
  // Commission: prefer the structured tentativeCommission.amount; the report
  // does not split tentative vs confirmed into separate fields, so this is the
  // commission figure regardless of status.
  const commission = raw.tentativeCommission?.amount ?? 0;
  const sale = raw.sales?.amount ?? raw.price ?? 0;
  const currency =
    raw.tentativeCommission?.currency ?? raw.sales?.currency ?? DEFAULT_CURRENCY;

  const orderDate = nullableIso(raw.orderDate) ?? new Date(0).toISOString();

  return {
    id: String(raw.affiliateOrderItemId ?? ''),
    network: SLUG,
    // Single programme: every order belongs to the one Flipkart programme.
    programmeId: FLIPKART_PROGRAMME_ID,
    programmeName: NAME,
    status,
    amount: sale,
    currency,
    commission,
    // Flipkart's report carries no click timestamp.
    dateClicked: undefined,
    dateConverted: orderDate,
    // No separate approval date on the report.
    dateApproved: undefined,
    // No paid-date field; Flipkart never reports a 'paid' state here.
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // Flipkart does not give a per-order reversal reason; the status alone
    // signals the reversal. Leave undefined rather than fabricating one.
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

/**
 * Build the single synthetic Flipkart programme. `categories` is seeded from
 * the product-feed listing when available (the keys of `apiListings`), so the
 * caller sees which categories Flipkart actively markets.
 */
function toProgramme(
  status: ProgrammeStatus,
  categories: string[],
  rawNetworkData: unknown,
): Programme {
  return {
    id: FLIPKART_PROGRAMME_ID,
    name: NAME,
    slug: SLUG,
    network: SLUG,
    status,
    currency: DEFAULT_CURRENCY,
    // Commission rates on Flipkart are per-category and per-campaign; the feed
    // listing does not expose a single headline rate, so we leave it unset
    // rather than guess.
    commissionRate: undefined,
    categories,
    advertiserUrl: 'https://www.flipkart.com',
    rawNetworkData,
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class FlipkartAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * Return the single Flipkart programme.
   *
   * Flipkart has no catalogue of merchants to browse: the publisher works with
   * Flipkart or not at all. We fetch the product-feed listing to seed the
   * programme's categories (and to confirm the credentials work), then return
   * exactly one programme. Client-side `search` / `status` / `categories`
   * filters are honoured so the contract behaves like the other adapters.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const affiliateId = requireAffiliateId('listProgrammes');
    const token = requireToken('listProgrammes');

    const listing = await flipkartRequest<FlipkartFeedListing>({
      operation: 'listProgrammes',
      path: `/affiliate/api/${encodeURIComponent(affiliateId)}.json`,
      affiliateId,
      token,
      resilience: RESILIENCE.listProgrammes ?? RESILIENCE.default,
    });

    const categories = Object.keys(listing?.apiListings ?? {});
    // Credentials that reach the listing mean the publisher is in the
    // programme; we model that as 'joined'.
    const programme = toProgramme('joined', categories, listing);

    let programmes = [programme];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.categories ?? []).some((c) => c.toLowerCase().includes(needle)),
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
   * Fetch the single Flipkart programme by id. The only valid id is the
   * synthetic `flipkart`; any other value is a caller error and surfaces as a
   * `config_error` envelope pointing at `listProgrammes`.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (programmeId !== FLIPKART_PROGRAMME_ID) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Flipkart exposes a single programme with id "${FLIPKART_PROGRAMME_ID}"; received "${programmeId}".`,
          hint: 'Call affiliate_flipkart_list_programmes; Flipkart is one merchant, so there is one programme.',
        }),
      );
    }

    const [programme] = await this.listProgrammes();
    if (!programme) {
      // listProgrammes always returns the one programme unless filtered, and we
      // pass no filter here. Defensive: never fabricate a stub.
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'Flipkart returned no programme from the product-feed listing.',
        }),
      );
    }
    return programme;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List orders from the Flipkart orders report.
   *
   * Endpoint:
   *   GET /affiliate/report/orders/detail/json
   *     ?startDate=YYYY-MM-DD &endDate=YYYY-MM-DD &status=... &offset=0
   *
   * Date handling:
   *   - Flipkart takes date-only (YYYY-MM-DD) bounds. We default to the last 30
   *     days when no window is given so the call is concrete.
   *   - Flipkart's report engine limits how wide a single window can be; we
   *     chunk into ≤90-day slices defensively so a caller asking for a year
   *     does not silently lose rows. (Awin uses the same chunking idea with a
   *     31-day cap.)
   *
   * Pagination:
   *   - The report paginates by `offset`. We follow the `next` link (or step
   *     the offset) until a page returns no rows, accumulating across pages.
   *
   * Status:
   *   - A single mappable status filter is pushed server-side via the `status`
   *     query param; mixed filters are applied client-side after the fetch.
   *
   * Age filters (PRD §15.9) are applied AFTER status filtering, anchored on the
   * computed `ageDays` (orderDate-relative).
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const affiliateId = requireAffiliateId('listTransactions');
    const token = requireToken('listTransactions');

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const statusFilter = toTransactionStatusList(query?.status);
    const serverStatus = pickFlipkartStatus(statusFilter);

    const slices = chunkDateRange(from, to, 90);

    const allRaw: FlipkartOrderRaw[] = [];
    for (const slice of slices) {
      // Walk offset pages until a page yields no rows. Flipkart's report is
      // offset-paginated; an empty `orderList` marks the end of the window.
      let offset = 0;
      // Guard against a misbehaving report engine that never empties the list:
      // cap the page count generously. Each page is one upstream call.
      const maxPages = 1000;
      for (let page = 0; page < maxPages; page += 1) {
        const resp = await flipkartRequest<FlipkartOrdersResponse>({
          operation: 'listTransactions',
          path: '/affiliate/report/orders/detail/json',
          affiliateId,
          token,
          query: {
            startDate: toDateOnly(slice.start),
            endDate: toDateOnly(slice.end),
            status: serverStatus,
            offset,
          },
          resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
        });

        const rows = Array.isArray(resp?.orderList) ? resp.orderList : [];
        if (rows.length === 0) break;
        allRaw.push(...rows);
        offset += rows.length;
      }
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter: every Flipkart order is the one programme, so a
    // mismatched filter legitimately returns nothing.
    if (query?.programmeId && query.programmeId !== FLIPKART_PROGRAMME_ID) {
      transactions = [];
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
   * Aggregate the orders report into an earnings summary, client-side.
   *
   * Derived from `listTransactions` (not a separate report endpoint) for the
   * same reasons as Awin: the user must be able to reproduce the summary from
   * the transactions they can see, and Flipkart has no aggregate endpoint whose
   * status buckets we would trust over the per-order data.
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Ignore `limit` — a limited summary silently undercounts (principle 4.1).
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

      // Count commission (the publisher's earnings), not the sale amount.
      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || FLIPKART_PROGRAMME_ID;
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: t.programmeName || NAME,
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // Oldest unpaid: pending or approved (approved-but-not-paid is the
      // "still owed after N days" case; Flipkart has no 'paid' state here).
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
   * Flipkart does not expose click-level data via the public affiliate API.
   * We throw `NotImplementedError` rather than returning `[]` so the user can
   * tell "Flipkart has no clicks endpoint" apart from "no clicks in range"
   * (PRD principle 4.1).
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Flipkart does not expose click-level data via the public affiliate API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Flipkart affiliate deep-link deterministically.
   *
   * Flipkart's documented scheme appends the tracking ID as the `affid` query
   * parameter to a normal Flipkart product/category URL:
   *
   *   https://www.flipkart.com/<path>?<existing params>&affid={trackingId}
   *
   * We do not call an API — the scheme is documented and stable, so an API
   * round-trip would add latency and a failure mode for no benefit (same
   * rationale as Awin's deterministic link).
   *
   * `programmeId` must be the single Flipkart programme id (validated so a
   * caller passing a stray value learns early). We require the credentials to
   * be configured so a half-configured environment fails at link-generation
   * time rather than at first click.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (input.programmeId && input.programmeId !== FLIPKART_PROGRAMME_ID) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `Flipkart has a single programme id "${FLIPKART_PROGRAMME_ID}"; received "${input.programmeId}".`,
          hint: `Pass programmeId "${FLIPKART_PROGRAMME_ID}" (or omit it) and a destinationUrl on flipkart.com.`,
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
          hint: 'Pass the full Flipkart product or category URL you want to link to.',
        }),
      );
    }

    // The tracking ID is the affid value; the token need only be configured
    // (sanity check) so a half-set environment is caught here.
    const affiliateId = requireAffiliateId('generateTrackingLink');
    requireToken('generateTrackingLink');

    let trackingUrl: string;
    try {
      const url = new URL(input.destinationUrl);
      url.searchParams.set('affid', affiliateId);
      trackingUrl = url.toString();
    } catch {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `destinationUrl is not a valid URL: "${input.destinationUrl}".`,
          hint: 'Pass an absolute Flipkart URL, e.g. https://www.flipkart.com/<product>/p/<id>.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: FLIPKART_PROGRAMME_ID,
      createdAt: new Date().toISOString(),
      // No upstream call; record the construction context for transparency.
      rawNetworkData: {
        format: 'flipkart.com ?affid= deterministic construction',
        affid: affiliateId,
        destinationUrl: input.destinationUrl,
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
      note: 'Flipkart does not expose click-level data via the public affiliate API',
    };

    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic URL construction; no live probe.',
    };
    operations['getProgramme'] = {
      supported: true,
      note: 'Single synthetic programme; not probed automatically.',
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
// Module-level registration (side effect — see Awin's adapter for the why).
// ---------------------------------------------------------------------------

export const flipkartAdapter = new FlipkartAdapter();
registerAdapter(flipkartAdapter);

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

interface DateSlice {
  start: Date;
  end: Date;
}

/**
 * Split `[from, to]` into ≤`maxDays`-day chunks. Flipkart's report engine
 * limits how wide a single window can be; we chunk so callers can request
 * wider windows naturally. Returns at least one slice; a `from >= to` window
 * yields one (zero-width) slice so the call shape stays predictable.
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

// Internal test helpers — exported under `_` so they stay off the public
// adapter surface.
export const _internals = {
  mapOrderStatus,
  pickFlipkartStatus,
  computeAgeDays,
  toTransaction,
  toProgramme,
  chunkDateRange,
  toDateOnly,
  FLIPKART_PROGRAMME_ID,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
