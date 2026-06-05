/**
 * PartnerStack adapter (partner / publisher side).
 *
 * Built against the PartnerStack **Partner API**
 * (https://docs.partnerstack.com/docs/partner-api) — the view a partner has of
 * their own partnerships and the rewards (commissions) they have earned. The
 * brand/vendor side lives in `src/networks/partnerstack-advertiser/` and speaks
 * the separate Vendor API.
 *
 * Read `src/networks/awin/adapter.ts` first — it is the canonical reference and
 * this adapter mirrors its shape (defensive transformers, status normalisation,
 * `ageDays`, deterministic-or-not link construction, module-level register).
 *
 * --- Honesty note (claim_status: experimental) -----------------------------
 *
 * The PartnerStack docs render API keys + some response schemas client-side and
 * were not fully scrapeable at commit time. The documented invariants — host,
 * bearer auth, `{ data, message, status }` envelope, cursor paging
 * (`starting_after`/`has_more`), epoch-ms timestamps — are encoded here, but the
 * exact field names on `partnership` / `reward` objects have NOT been confirmed
 * against a live partner account. Every transformer therefore reads a spread of
 * plausible keys defensively and preserves the verbatim payload on
 * `rawNetworkData`. Lines that need a live check carry `// TODO(verify)`.
 *
 * --- Operations ------------------------------------------------------------
 *
 *   listProgrammes       GET /partnerships → one Programme per partnership.
 *   getProgramme         filter /partnerships by key (no documented single-get).
 *   listTransactions     GET /rewards → Transaction[] (the partner's commissions).
 *   getEarningsSummary   derived from listTransactions (see Awin's rationale).
 *   listClicks           NotImplementedError — the Partner API does not expose
 *                        click-level data.
 *   generateTrackingLink NotImplementedError — partner links are pre-issued by
 *                        PartnerStack (listed via /links); there is no documented
 *                        per-destination deep-link construction.
 *   verifyAuth           cheap /partnerships probe (see auth.ts).
 */

import { partnerstackRequest, SLUG } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireApiKey } from './auth.js';
import { setupSteps } from './setup.js';
import { configErrorFor } from './internal.js';
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

const log = createLogger('partnerstack.adapter');
const NAME = 'PartnerStack';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.partnerstack.com',
  authModel: 'bearer',
  docsUrl: 'https://docs.partnerstack.com/docs/partner-api',
  adapterVersion: '0.1.0',
  // experimental: implemented against the documented contract but not yet
  // validated end-to-end against a live partner account.
  claimStatus: 'experimental',
  knownLimitations: [
    'Click-level data is not exposed via the PartnerStack Partner API; listClicks is unsupported.',
    'generateTrackingLink is unsupported: PartnerStack issues partner links itself (listed via /links); there is no documented per-destination deep-link construction.',
    'Reward amounts are assumed to be minor units (cents) and divided by 100; the unit is `// TODO(verify)` against a live account.',
    'partnership / reward field names are read defensively and have not been confirmed against a live partner account (the docs render schemas client-side). Verbatim payloads are preserved on rawNetworkData.',
    'getProgramme filters the /partnerships list client-side; the Partner API has no documented single-partnership GET.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 5,
  setupRequiresApproval: false,
  side: 'publisher',
  credentialScope: 'single-brand',
  // PartnerStack timestamps are epoch milliseconds (absolute UTC), so no
  // networkTimezone is required — values are already offset-qualified.
};

// ---------------------------------------------------------------------------
// Resilience profile
// ---------------------------------------------------------------------------

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
  // /rewards can be a large pull over a wide window; give the transactional
  // ops more budget (same rationale as Awin's listTransactions).
  listTransactions: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
  getEarningsSummary: { ...DEFAULT_RESILIENCE, timeoutMs: 60_000, retries: 3 },
};

// Default and maximum page size requested from the cursor-paginated endpoints.
const PAGE_SIZE = 100;
// Safety cap so a misbehaving `has_more` cannot loop forever.
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// PartnerStack response shapes (deliberately minimal + defensive)
// ---------------------------------------------------------------------------

/** The standard PartnerStack envelope: `{ data, message, status }`. */
interface PartnerstackEnvelope<T> {
  data?: T;
  message?: string;
  status?: string | number;
}

interface PartnerstackPartnershipRaw {
  key?: string;
  id?: string;
  status?: string;
  created_at?: number;
  joined_at?: number;
  // Programme identity tends to live on a nested group/offer object.
  group?: { name?: string; slug?: string; key?: string };
  offer?: { name?: string; key?: string };
  partner?: { email?: string; name?: string };
}

interface PartnerstackRewardRaw {
  key?: string;
  id?: string;
  status?: string;
  amount?: number; // minor units (cents) — `// TODO(verify)`
  currency?: string;
  created_at?: number;
  approved_at?: number;
  paid_at?: number;
  group?: { name?: string; slug?: string; key?: string };
  group_key?: string;
  partnership_key?: string;
  transaction?: { amount?: number; currency?: string };
}

// ---------------------------------------------------------------------------
// Envelope / list extraction
// ---------------------------------------------------------------------------

/**
 * Unwrap the PartnerStack `{ data, ... }` envelope. Tolerates a bare body too
 * (some endpoints may return the payload un-enveloped) so a drift in shape
 * degrades to "read what's there" rather than failing hard.
 */
function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as PartnerstackEnvelope<unknown>).data;
  }
  return body;
}

/** Pull the array of records out of an unwrapped `data` payload. */
function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // PartnerStack commonly nests rows under `items`; tolerate `rows`/`results`.
    for (const key of ['items', 'rows', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/** Whether the unwrapped payload signals another page (`has_more`). */
function hasMore(data: unknown): boolean {
  if (data && typeof data === 'object') {
    return (data as Record<string, unknown>)['has_more'] === true;
  }
  return false;
}

function recordKey(row: { key?: string; id?: string }): string | undefined {
  return row.key ?? row.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function epochMsToIso(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Minor units (cents) → major units. `// TODO(verify)` the unit upstream. */
function minorToMajor(amount?: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 0;
  return amount / 100;
}

/**
 * Status normalisation: PartnerStack reward status → canonical.
 *
 * PartnerStack reward vocabulary (verify against a live account):
 *   pending            → 'pending'
 *   approved/actioned  → 'approved'
 *   paid               → 'paid'
 *   declined/voided/refunded → 'reversed' (the partner did not get paid)
 *   anything else      → 'other'
 *
 * We never invent a status the partner did not see on PartnerStack's side; the
 * verbatim token is preserved on `rawNetworkData`.
 */
function mapTransactionStatus(raw: PartnerstackRewardRaw): TransactionStatus {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'actioned':
      return 'approved';
    case 'paid':
      return 'paid';
    case 'declined':
    case 'voided':
    case 'refunded':
      return 'reversed';
    default:
      return 'other';
  }
}

/**
 * Status normalisation: PartnerStack partnership status → canonical.
 *   active             → 'joined'
 *   pending            → 'pending'
 *   declined/rejected  → 'declined'
 *   paused/suspended   → 'suspended'
 *   anything else      → 'unknown'
 */
function mapProgrammeStatus(raw: PartnerstackPartnershipRaw): ProgrammeStatus {
  switch (String(raw.status ?? '').toLowerCase()) {
    case 'active':
    case 'approved':
    case 'joined':
      return 'joined';
    case 'pending':
      return 'pending';
    case 'declined':
    case 'rejected':
      return 'declined';
    case 'paused':
    case 'suspended':
      return 'suspended';
    default:
      return 'unknown';
  }
}

function computeAgeDays(raw: PartnerstackRewardRaw, now: Date = new Date()): number {
  const anchorMs = raw.approved_at ?? raw.created_at;
  if (typeof anchorMs !== 'number' || !Number.isFinite(anchorMs)) return 0;
  return Math.max(0, Math.floor((now.getTime() - anchorMs) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function programmeIdentity(
  source: PartnerstackPartnershipRaw | PartnerstackRewardRaw,
): { id: string; name: string } {
  const group = source.group;
  const id =
    group?.slug ??
    group?.key ??
    ('group_key' in source ? (source as PartnerstackRewardRaw).group_key : undefined) ??
    ('offer' in source ? (source as PartnerstackPartnershipRaw).offer?.key : undefined) ??
    ('partnership_key' in source ? (source as PartnerstackRewardRaw).partnership_key : undefined) ??
    '';
  const name =
    group?.name ??
    ('offer' in source ? (source as PartnerstackPartnershipRaw).offer?.name : undefined) ??
    (id ? `PartnerStack programme ${id}` : 'PartnerStack programme');
  return { id: String(id), name };
}

function toProgramme(raw: PartnerstackPartnershipRaw): Programme {
  const { id, name } = programmeIdentity(raw);
  return {
    id,
    name,
    network: SLUG,
    status: mapProgrammeStatus(raw),
    rawNetworkData: raw,
  };
}

function toTransaction(raw: PartnerstackRewardRaw, now: Date = new Date()): Transaction {
  const { id: programmeId, name: programmeName } = programmeIdentity(raw);
  const commission = minorToMajor(raw.amount);
  // The reward is the partner's commission; the underlying transaction amount
  // (the sale) is only present on some reward shapes.
  const sale = minorToMajor(raw.transaction?.amount) || commission;
  const currency = raw.currency ?? raw.transaction?.currency ?? 'USD';

  const dateConverted = epochMsToIso(raw.created_at) ?? new Date(0).toISOString();

  return {
    id: String(recordKey(raw) ?? ''),
    network: SLUG,
    programmeId,
    programmeName,
    status: mapTransactionStatus(raw),
    amount: sale,
    currency,
    commission,
    dateConverted,
    dateApproved: epochMsToIso(raw.approved_at),
    datePaid: epochMsToIso(raw.paid_at),
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class PartnerstackAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  /**
   * Fetch every page of a cursor-paginated Partner API resource.
   *
   * PartnerStack uses `starting_after` (the key of the last seen row) plus a
   * `has_more` flag. We loop until `has_more` is false or `MAX_PAGES` is hit —
   * the cap is a backstop against a misbehaving flag, logged so a truncated
   * pull is never silent (principle 4.1).
   */
  private async fetchAll<T extends { key?: string; id?: string }>(
    operation: string,
    path: string,
    apiKey: string,
    resilience = RESILIENCE.default,
  ): Promise<T[]> {
    const out: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await partnerstackRequest<PartnerstackEnvelope<unknown>>({
        operation,
        path,
        apiKey,
        query: { limit: PAGE_SIZE, starting_after: startingAfter },
        resilience,
      });
      const data = unwrapData(body);
      const rows = extractList(data) as T[];
      out.push(...rows);
      if (!hasMore(data) || rows.length === 0) return out;
      const last = rows[rows.length - 1];
      const cursor = last ? recordKey(last) : undefined;
      if (!cursor) return out;
      startingAfter = cursor;
    }
    log.warn(
      { operation, cap: MAX_PAGES, fetched: out.length },
      'partnerstack pagination hit MAX_PAGES cap; result may be truncated',
    );
    return out;
  }

  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const apiKey = requireApiKey('listProgrammes');
    const raw = await this.fetchAll<PartnerstackPartnershipRaw>(
      'listProgrammes',
      '/partnerships',
      apiKey,
    );
    let programmes = raw.map(toProgramme);

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const statusFilter = toStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      programmes = programmes.filter((p) => set.has(p.status));
    }
    if (typeof query?.limit === 'number') programmes = programmes.slice(0, query.limit);
    return programmes;
  }

  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId || programmeId.trim() === '') {
      throw configErrorFor('getProgramme', 'A PartnerStack programme id (partnership/group key) is required.', {
        hint: 'List programmes first (affiliate_partnerstack_list_programmes) to find the id.',
      });
    }
    const apiKey = requireApiKey('getProgramme');
    const raw = await this.fetchAll<PartnerstackPartnershipRaw>(
      'getProgramme',
      '/partnerships',
      apiKey,
    );
    const match = raw.map(toProgramme).find((p) => p.id === programmeId);
    if (!match) {
      throw configErrorFor('getProgramme', `No PartnerStack partnership found with id "${programmeId}".`, {
        hint: 'Use affiliate_partnerstack_list_programmes to see valid ids.',
      });
    }
    return match;
  }

  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const apiKey = requireApiKey('listTransactions');
    const now = new Date();
    const raw = await this.fetchAll<PartnerstackRewardRaw>(
      'listTransactions',
      '/rewards',
      apiKey,
      RESILIENCE.listTransactions ?? RESILIENCE.default,
    );
    let transactions = raw.map((r) => toTransaction(r, now));

    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }
    // from/to filter client-side against dateConverted (the Partner API's
    // server-side reward filters are undocumented — `// TODO(verify)`).
    if (query?.from) {
      const fromMs = Date.parse(query.from);
      if (!Number.isNaN(fromMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) >= fromMs);
      }
    }
    if (query?.to) {
      const toMs = Date.parse(query.to);
      if (!Number.isNaN(toMs)) {
        transactions = transactions.filter((t) => Date.parse(t.dateConverted) <= toMs);
      }
    }
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }
    if (typeof query?.minAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays >= (query.minAgeDays as number));
    }
    if (typeof query?.maxAgeDays === 'number') {
      transactions = transactions.filter((t) => t.ageDays <= (query.maxAgeDays as number));
    }
    if (typeof query?.limit === 'number') transactions = transactions.slice(0, query.limit);
    return transactions;
  }

  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = query?.to ?? now.toISOString();

    // Derive from listTransactions (ignoring `limit` — a limited summary would
    // silently undercount, violating principle 4.1).
    const txns = await this.listTransactions({ ...query, from, to, limit: undefined });

    const byProgrammeMap = new Map<string, EarningsByProgramme>();
    const byStatus: EarningsByStatus = {
      pending: 0,
      approved: 0,
      reversed: 0,
      paid: 0,
      other: 0,
      currency: 'USD',
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
          programmeName: t.programmeName || `PartnerStack programme ${key}`,
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
      currency: firstCurrency ?? 'USD',
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'PartnerStack does not expose click-level data via the Partner API',
    );
  }

  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'PartnerStack issues partner links itself (listed via /links); there is no documented ' +
        'per-destination deep-link construction for the Partner API.',
    );
  }

  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        operations[name] = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize: Array.isArray(result) ? result.length : 1,
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

    operations['getProgramme'] = {
      supported: true,
      note: 'Filters the /partnerships list client-side; requires a known id, not probed automatically.',
      claimStatus: 'experimental',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'PartnerStack does not expose click-level data via the Partner API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'PartnerStack issues partner links itself; no per-destination construction.',
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
// Module-level registration (see Awin's adapter for the rationale).
// ---------------------------------------------------------------------------

export const partnerstackAdapter = new PartnerstackAdapter();
registerAdapter(partnerstackAdapter);

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

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  toProgramme,
  toTransaction,
  unwrapData,
  extractList,
  hasMore,
  minorToMajor,
  epochMsToIso,
};
