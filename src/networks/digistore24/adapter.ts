/**
 * Digistore24 adapter — publisher / affiliate side.
 *
 * READ ME FIRST (future contributors):
 *
 * This adapter follows the pattern established by `src/networks/awin/adapter.ts`.
 * Read that file and its header comments before modifying this one.
 *
 * --- API overview -----------------------------------------------------------
 *
 * Auth:    Custom header `X-DS-API-KEY: <key>`.
 * Base:    https://www.digistore24.com/api/call/{function}
 * Docs:    https://dev.digistore24.com/hc/en-us (API reference A–Z) +
 *          Swagger at https://www.digistore24.com/api/docs.
 *
 * Digistore24 is a single-platform German digital-products network. It exposes
 * a function-style REST API: one path per function, arguments as query params,
 * a `{ result: "success", data: ... }` envelope (the client unwraps `data` and
 * raises a NetworkError when `result` is not "success" — see client.ts).
 *
 * --- Function map (verify against the API reference A–Z) --------------------
 *
 *   GET  /api/call/ping
 *     → connectivity / auth smoke test. Used inside capabilitiesCheck.
 *   GET  /api/call/getUserInfo
 *     → account identity. Used by verifyAuth (see auth.ts).
 *   GET  /api/call/listTransactions
 *     ?from=-30d &to=now &search[role]=affiliate &page_no=1 &page_size=1000
 *     → transactions you earn commission on: payments, refunds, chargebacks.
 *   GET  /api/call/listProducts (marketplace catalogue)
 *     → product catalogue; not used as the programme source — see
 *       `listProgrammes` for why we synthesise a single platform programme.
 *
 * --- Programmes mapping (the non-obvious decision) --------------------------
 *
 * Digistore24 has no "programme" concept the way Awin/CJ do. A publisher is an
 * affiliate of the platform and promotes individual products (each owned by a
 * vendor). There is no clean per-merchant "joined / available" catalogue
 * scoped to the publisher via the API: products are joined per-product, and
 * the marketplace endpoint is a discovery catalogue, not a relationship list.
 *
 * Rather than mis-model products as programmes (the IDs, statuses and
 * commission shapes do not line up), we synthesise ONE programme that
 * represents the Digistore24 platform itself. `listProgrammes` returns that
 * single synthetic programme; `getProgramme` returns it for the platform id
 * and a config_error for anything else. This keeps the contract honest: the
 * mapping is documented here and in network.json `known_limitations`, and the
 * synthetic programme carries `claimStatus: 'experimental'` in
 * capabilitiesCheck. Transactions reference this same platform programme id so
 * earnings aggregation has a stable key.
 *
 * --- Cardinal rules (see Awin adapter header for full rationale) ------------
 *
 *   1. NEVER call `fetch` directly. Use `digistore24Request` from `./client.ts`.
 *   2. EVERY failure → NetworkErrorEnvelope (network, operation, httpStatus,
 *      verbatim networkErrorBody). Never collapse to "an error occurred".
 *   3. PRESERVE the raw response in `rawNetworkData` on every domain object.
 *   4. NORMALISE status enums to the canonical set. Prefer `other`/`unknown`
 *      over a wrong guess. Document the mapping inline.
 *   5. COMPUTE `ageDays` for every transaction (PRD §15.9).
 *   6. UK English throughout. User-visible noun is "programme" not "program".
 *
 * --- Amount unit assumption -------------------------------------------------
 *
 * Digistore24 reports monetary amounts in MAJOR currency units as decimal
 * values (e.g. `49.00` EUR, not `4900` cents). We parse them as floats and do
 * not divide. This is consistent with the documented examples (`amount =>
 * 10.00, currency => EUR`) but has not been confirmed against a live account,
 * hence the matching note in network.json `known_limitations`.
 */

import { digistore24Request } from './client.js';
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
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionStatus,
  type TransactionQuery,
} from '../../shared/types.js';

const log = createLogger('digistore24.adapter');

const SLUG = 'digistore24';
const NAME = 'Digistore24';

/**
 * The id of the synthetic platform programme. See the "Programmes mapping"
 * note in the file header. Stable so transactions and earnings can key off it.
 */
const PLATFORM_PROGRAMME_ID = 'digistore24';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://www.digistore24.com',
  // Digistore24 uses a custom header (X-DS-API-KEY) rather than standard Bearer.
  authModel: 'custom',
  docsUrl: 'https://dev.digistore24.com/hc/en-us',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  // Experimental: adapter built from public docs; not verified against a live account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live Digistore24 account.',
    'Monetary amounts are assumed to be major currency units (e.g. 49.00 EUR), not minor units/cents; this matches the documented examples but is unconfirmed against a live account.',
    'Digistore24 has no per-merchant programme concept; listProgrammes/getProgramme return a single synthetic programme representing the platform, and transactions key off it.',
    'Click-level data is not exposed via the public Digistore24 API; listClicks is unsupported.',
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
 * listTransactions can be slow when the date window is wide and the account
 * has many records. Give it a longer timeout and an extra retry, matching the
 * pattern Awin uses for its transactions endpoint. getEarningsSummary derives
 * from listTransactions so it shares the profile.
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
// Digistore24 response shapes (deliberately minimal — read defensively)
// ---------------------------------------------------------------------------

interface Digistore24TransactionRaw {
  id?: string | number;
  transaction_id?: string | number;
  purchase_id?: string;
  // Digistore24 labels the row kind under `transaction_type` (and some
  // endpoints `type`): pay | refund | chargeback | refund_request | ...
  transaction_type?: string;
  type?: string;
  // The transaction (gross) amount and the affiliate's share. Field names vary
  // across endpoints; we read the common ones and fall back gracefully.
  amount?: string | number;
  transaction_amount?: string | number;
  amount_affiliate?: string | number;
  affiliate_amount?: string | number;
  commission?: string | number;
  currency?: string;
  // Timestamps. created_at is the booking time of the transaction.
  created_at?: string;
  date?: string;
  // Product context — used as the programme name where present.
  product_id?: string | number;
  product_name?: string;
  campaignkey?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Status normalisation: Digistore24 transaction_type → canonical.
 *
 * Digistore24 records each money movement as a typed transaction rather than a
 * single row with a mutable status:
 *
 *   pay / payment        → 'approved'  (a booked sale the affiliate earns on)
 *   refund / refund_request → 'reversed' (the buyer's money was returned)
 *   chargeback           → 'reversed'  (a forced reversal)
 *   anything else        → 'other'
 *
 * Why 'pay' maps to 'approved' rather than 'paid': a booked sale is an earned
 * commission, but the API's transaction list does not by itself tell us the
 * commission has been disbursed to the affiliate's payout. We therefore stop
 * at 'approved' and never invent 'paid'. There is no separate 'pending' type
 * in this list — pending commission states are not exposed as transactions.
 *
 * Unknown types map to 'other' by design — we never invent a status the user
 * did not see on Digistore24's side.
 */
function mapTransactionStatus(raw: Digistore24TransactionRaw): TransactionStatus {
  const t = (raw.transaction_type ?? raw.type ?? '').toLowerCase();
  if (t === 'pay' || t === 'payment') return 'approved';
  if (t === 'refund' || t === 'refund_request' || t === 'chargeback') return 'reversed';
  return 'other';
}

/**
 * Parse a Digistore24 monetary value. Amounts are major currency units as
 * decimal strings or numbers (e.g. "49.00" or 49). We never divide by 100 —
 * see the amount-unit note in the file header.
 */
function parseAmount(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the age (in days) of a transaction at the moment this adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this number.
 *
 * Digistore24 exposes a single booking timestamp (`created_at`), so we anchor
 * on it. There is no separate validation/approval date to prefer.
 */
function computeAgeDays(raw: Digistore24TransactionRaw, now: Date = new Date()): number {
  const anchor = raw.created_at ?? raw.date;
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

/**
 * Format a Date for Digistore24's `from`/`to` params. The API accepts relative
 * strings ('-30d', 'now') and absolute timestamps; we send absolute
 * `YYYY-MM-DD HH:MM:SS` for determinism.
 */
function formatDigistore24Date(d: Date): string {
  // ISO without the millisecond/Z suffix, space-separated date and time.
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// ---------------------------------------------------------------------------
// Transformers (Digistore24 raw → canonical domain types)
// ---------------------------------------------------------------------------

function toTransaction(raw: Digistore24TransactionRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const sale = parseAmount(raw.transaction_amount ?? raw.amount);
  const commission = parseAmount(raw.amount_affiliate ?? raw.affiliate_amount ?? raw.commission);
  const currency = raw.currency ?? 'EUR';

  const converted = nullableIso(raw.created_at ?? raw.date) ?? new Date(0).toISOString();

  return {
    id: String(raw.id ?? raw.transaction_id ?? raw.purchase_id ?? ''),
    network: SLUG,
    // All transactions key off the synthetic platform programme so earnings
    // aggregation has a stable key (see the file header). The product context
    // is preserved on rawNetworkData and surfaced in the programme NAME below.
    programmeId: PLATFORM_PROGRAMME_ID,
    programmeName: raw.product_name ?? NAME,
    status,
    amount: sale,
    currency,
    commission,
    dateConverted: converted,
    // Digistore24's transaction list does not expose a separate approval or
    // paid date; leave them undefined rather than fabricating.
    dateApproved: undefined,
    datePaid: undefined,
    ageDays: computeAgeDays(raw, now),
    // PRD §15.10 — Digistore24 does not provide a reversal reason on the
    // transaction; the type itself (refund/chargeback) is the reason. Leave
    // undefined rather than inventing text.
    reversalReason: undefined,
    rawNetworkData: raw,
  };
}

/**
 * Build the single synthetic programme representing the Digistore24 platform.
 * See the "Programmes mapping" note in the file header.
 */
function platformProgramme(): Programme {
  return {
    id: PLATFORM_PROGRAMME_ID,
    name: 'Digistore24 (platform)',
    network: SLUG,
    // The publisher is an affiliate of the platform itself.
    status: 'joined',
    rawNetworkData: {
      note:
        'Synthetic programme: Digistore24 has no per-merchant programme concept exposed to ' +
        'affiliates via the API. This represents the platform; individual products are promoted ' +
        'per-product via promolinks.',
      platformId: PLATFORM_PROGRAMME_ID,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

export class Digistore24Adapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * Return the single synthetic platform programme.
   *
   * Digistore24 has no per-merchant programme catalogue scoped to the publisher
   * (see the file header). We model the platform as one programme so the
   * contract has a stable, honest answer to "what can I work with?". We still
   * require the credential so a half-configured environment fails here rather
   * than at first use, and we honour the client-side filters (search, status,
   * limit) so the op behaves like every other adapter's listProgrammes.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    requireCredential('DIGISTORE24_API_KEY', {
      network: SLUG,
      operation: 'listProgrammes',
      hint: 'Create an API key at dev.digistore24.com → "Create API key".',
    });

    let programmes = [platformProgramme()];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      programmes = programmes.filter((p) => wanted.has(p.status));
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
   * Return the synthetic platform programme for the platform id; reject
   * anything else with a config_error envelope pointing the caller at
   * listProgrammes. There is no per-id programme endpoint to call.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    requireCredential('DIGISTORE24_API_KEY', {
      network: SLUG,
      operation: 'getProgramme',
      hint: 'Create an API key at dev.digistore24.com → "Create API key".',
    });

    if (programmeId !== PLATFORM_PROGRAMME_ID) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Digistore24 exposes a single synthetic platform programme with id "${PLATFORM_PROGRAMME_ID}"; received "${programmeId}".`,
          hint: 'Call affiliate_digistore24_list_programmes to see the available programme id.',
        }),
      );
    }

    return platformProgramme();
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List transactions (payments, refunds, chargebacks) across a date window.
   *
   * Digistore24 endpoint:
   *   GET /api/call/listTransactions
   *     ?from=YYYY-MM-DD HH:MM:SS &to=YYYY-MM-DD HH:MM:SS
   *     &search[role]=affiliate
   *     &page_no=N &page_size=1000
   *
   * Pagination is page-number based (`page_no` / `page_size`, default page size
   * 1000). We page until a short page is returned. `search[role]=affiliate`
   * scopes the list to commissions the publisher earns (the API can also
   * return vendor-side rows on accounts that sell their own products).
   *
   * The response `data` is expected to carry the rows under a `transaction_list`
   * key (Digistore24's list functions wrap the array); we read that and fall
   * back to a bare array defensively.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` returns only transactions whose computed `ageDays` is
   * >= the threshold; `maxAgeDays` the converse. Applied AFTER status filtering
   * so `{ status: 'approved', minAgeDays: 180 }` is meaningful.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireCredential('DIGISTORE24_API_KEY', {
      network: SLUG,
      operation: 'listTransactions',
      hint: 'Create an API key at dev.digistore24.com → "Create API key".',
    });

    const now = new Date();
    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const pageSize = 1000;
    const allRaw: Digistore24TransactionRaw[] = [];

    // Page-number pagination. Cap at a generous page count so a misbehaving API
    // cannot loop forever; each page goes through the resilience layer.
    const MAX_PAGES = 100;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      const data = await digistore24Request<{ transaction_list?: Digistore24TransactionRaw[] } | Digistore24TransactionRaw[]>({
        operation: 'listTransactions',
        function: 'listTransactions',
        apiKey,
        query: {
          from: formatDigistore24Date(from),
          to: formatDigistore24Date(to),
          'search[role]': 'affiliate',
          page_no: pageNo,
          page_size: pageSize,
        },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });

      const rows = extractRows(data);
      allRaw.push(...rows);
      // Stop once the page is short (last page) or empty.
      if (rows.length < pageSize) break;
    }

    let transactions = allRaw.map((r) => toTransaction(r, now));

    // programmeId filter — every Digistore24 transaction belongs to the
    // synthetic platform programme; reject a mismatched filter by returning
    // nothing rather than silently ignoring it.
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
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (not a separate report function) so the
   * user can reproduce the numbers by listing the transactions they see — the
   * same rationale as Awin. We total commission, not sale amount.
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
      currency: 'EUR',
    };

    let totalEarnings = 0;
    let firstCurrency: string | undefined;
    let oldestUnpaidAgeDays: number | undefined;

    for (const t of txns) {
      if (!firstCurrency) firstCurrency = t.currency;

      byStatus[t.status] = (byStatus[t.status] ?? 0) + t.commission;
      totalEarnings += t.commission;

      const key = t.programmeId || PLATFORM_PROGRAMME_ID;
      const existing = byProgrammeMap.get(key);
      if (existing) {
        existing.total += t.commission;
        existing.transactionCount += 1;
      } else {
        byProgrammeMap.set(key, {
          programmeId: key,
          programmeName: 'Digistore24 (platform)',
          total: t.commission,
          currency: t.currency,
          transactionCount: 1,
        });
      }

      // PRD §15.9 — oldest unpaid age. "Unpaid" here means approved-but-not-
      // disbursed (Digistore24's transaction list does not expose a pending
      // state, so the bucket is just 'approved').
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
   * Digistore24 does not expose click-level data via its public API.
   *
   * We throw `NotImplementedError` deliberately rather than returning an empty
   * array — the difference between "no clicks" and "no click API" is principle
   * 4.1. If Digistore24 adds click data later, this becomes a real
   * implementation and the limitation line is dropped from META/network.json.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Digistore24 does not expose click-level data via the public API',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a Digistore24 promolink (affiliate deep-link).
   *
   * Documented format:
   *
   *   https://www.checkout-ds24.com/redir/{PRODUCT-ID}/{AFFILIATE}/{CAMPAIGNKEY}
   *
   * For this adapter:
   *   - `input.programmeId` carries the Digistore24 PRODUCT-ID to promote.
   *     (Digistore24 promolinks are per-product, not per-merchant, so the
   *     "programmeId" slot is the product id here. The synthetic platform
   *     programme id is rejected with an actionable hint.)
   *   - The AFFILIATE segment is the publisher's Digistore24 ID, read from the
   *     optional `DIGISTORE24_AFFILIATE_ID` credential when present; if it is
   *     not configured we omit the segment and Digistore24 fills it from the
   *     authenticated session / the vendor's default.
   *   - `input.destinationUrl` is recorded for reference but is not part of the
   *     promolink: the promolink always leads to the product's own sales page.
   *
   * Why deterministic construction rather than an API call: the promolink
   * scheme is documented and stable; an API round-trip would add latency and a
   * failure mode for no benefit (the same rationale as Awin's cread.php link).
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
          message: 'Digistore24 promolinks require a product id in `programmeId`.',
          hint:
            'Pass the Digistore24 PRODUCT-ID to promote in `programmeId`. The product id is shown ' +
            'on the product in your Digistore24 marketplace / vendor page.',
        }),
      );
    }
    if (input.programmeId === PLATFORM_PROGRAMME_ID) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message:
            'Digistore24 promolinks are per-product; the synthetic platform programme id cannot be linked.',
          hint: 'Pass a real Digistore24 PRODUCT-ID in `programmeId` rather than the platform id.',
        }),
      );
    }

    // Require the credential so a half-configured environment learns at
    // link-generation time, not at first click.
    requireCredential('DIGISTORE24_API_KEY', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint: 'Create an API key at dev.digistore24.com → "Create API key".',
    });

    // Optional publisher ID for the AFFILIATE segment. Read via getCredential
    // (not requireCredential) so its absence does not fail the call.
    const affiliateId = process.env['DIGISTORE24_AFFILIATE_ID']?.trim() || undefined;

    const product = encodeURIComponent(input.programmeId);
    const affiliateSegment = affiliateId ? `/${encodeURIComponent(affiliateId)}` : '';
    const trackingUrl = `https://www.checkout-ds24.com/redir/${product}${affiliateSegment}`;

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'checkout-ds24.com/redir promolink deterministic construction',
        productId: input.programmeId,
        affiliate: affiliateId ?? '(filled by Digistore24 from the authenticated session)',
        note: 'Promolink leads to the product sales page; destinationUrl is recorded for reference only.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to `auth.verifyAuth`, which calls getUserInfo and returns the
   * account identity. The adapter surface returns the contract type
   * `{ ok: true, identity? } | { ok: false, reason }`.
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

  /**
   * Probe each operation with a minimal call to record live capability data.
   * Each probe is wrapped so one failing op does not block the others.
   */
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

    await probe('listTransactions', () => this.listTransactions({ limit: 1 }));
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    // listProgrammes / getProgramme are synthetic (no live probe needed) but
    // flagged experimental: the mapping is a deliberate synthesis, not a
    // network catalogue.
    operations['listProgrammes'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Single synthetic programme representing the Digistore24 platform; not a network catalogue.',
    };
    operations['getProgramme'] = {
      supported: true,
      claimStatus: 'experimental',
      note: 'Returns the synthetic platform programme; per-merchant programmes are not exposed.',
    };

    // listClicks: known-unsupported. Record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Digistore24 does not expose click-level data via the public API',
    };

    // generateTrackingLink is deterministic; record as supported without a
    // probe (a probe would need a real product id).
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic promolink construction; requires a product id, not probed automatically.',
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
// Module-level registration (see Awin adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const digistore24Adapter = new Digistore24Adapter();
registerAdapter(digistore24Adapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Extract the transaction rows from a listTransactions `data` payload.
 * Digistore24 wraps the array under `transaction_list`; accept a bare array
 * too for resilience against endpoint variants.
 */
function extractRows(
  data: { transaction_list?: Digistore24TransactionRaw[] } | Digistore24TransactionRaw[] | undefined,
): Digistore24TransactionRaw[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.transaction_list)) return data.transaction_list;
  return [];
}

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  mapTransactionStatus,
  computeAgeDays,
  parseAmount,
  toTransaction,
  platformProgramme,
  formatDigistore24Date,
  extractRows,
  PLATFORM_PROGRAMME_ID,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
