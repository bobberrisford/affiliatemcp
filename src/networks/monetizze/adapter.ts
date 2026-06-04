/**
 * Monetizze adapter — publisher/affiliate-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and `src/networks/skimlinks/adapter.ts` (the closest publisher-side
 * sibling). The load-bearing decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper.
 *   - `ageDays` is computed per transaction, with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Monetizze API map (Open API 2.1) -----------------------------------------
 *
 * Base URL: https://api.monetizze.com.br/2.1
 * Auth: POST /token with header `x_consumer_key: <access key>` → token; then send
 *       header `token: <token>` on data calls. (See client.ts / auth.ts.)
 *
 * Sales / commissions (the reporting endpoint):
 *   GET /transactions[?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&status=<n>]
 *   Each sale carries `produto{ codigo, nome, categoria, chave }` and a
 *   `comissoes[]` array of affiliate commission rows
 *   (refAfiliado, nome, tipo_comissao, valor, comissao, email).
 *   Status codes (callback example repo): 1 Aguardando pagamento, 2 Finalizada,
 *   3 Cancelada, 4 Devolvida, 5 Bloqueada, 6 Completa, 7 Abandono de Checkout.
 *
 *   Sources:
 *     https://help.monetizze.com.br/books/integracoes/page/api-monetizze
 *     https://github.com/Monetizze/ExemploPOSTCallback (field names + status codes)
 *     https://github.com/skaisser/monetizze (endpoint + headers)
 *     https://github.com/Monetizze/ExemploPOSTCallback/issues/18 (token + 403)
 *
 * Products / programmes (listProgrammes / getProgramme):
 *   The help-centre states the API exposes product data, but no specific
 *   product-listing path or response shape could be confirmed from public
 *   sources (the interactive apidoc at https://api.monetizze.com.br/2.1/apidoc/
 *   is JS-rendered and refused automated fetches). BLOCKED(verify): both
 *   operations throw NotImplementedError rather than calling an invented endpoint.
 *
 * Clicks + tracking links:
 *   The Monetizze API is a sale/commission reporting API; it does not expose
 *   click-level data, and affiliate tracking links are generated inside the
 *   panel (not via a documented, deterministic public endpoint). listClicks and
 *   generateTrackingLink throw NotImplementedError.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `monetizzeRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`. Never swallow.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. See `mapTransactionStatus` / `mapProgrammeStatus`.
 *      Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` — NEVER process.env (except tests).
 *   7. UK English. "programme", not "program".
 */

import { monetizzeRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getToken } from './auth.js';
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
  type ProgrammeStatus,
  type ResilienceConfig,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
  type TransactionStatus,
} from '../../shared/types.js';

const log = createLogger('monetizze.adapter');

const SLUG = 'monetizze';
const NAME = 'Monetizze';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.monetizze.com.br/2.1',
  authModel: 'custom',
  docsUrl: 'https://api.monetizze.com.br/2.1/apidoc/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'listProgrammes / getProgramme: no public product-listing endpoint path or response shape could be confirmed; the interactive apidoc is JS-rendered and refused automated fetches. Both operations throw NotImplementedError rather than calling an unconfirmed endpoint.',
    'listClicks: the Monetizze API does not expose click-level data; the operation throws NotImplementedError.',
    'generateTrackingLink: Monetizze affiliate links are generated inside the panel, not via a documented deterministic public endpoint; the operation throws NotImplementedError.',
    'listTransactions advanced-filter query parameter names (date window, status) are unconfirmed against the live interactive docs; the adapter sends dataInicio/dataFim and also filters client-side as a safeguard.',
    'Authentication uses a two-step token exchange (x_consumer_key header -> token); the token-response field name and token lifetime are unconfirmed, so the adapter reads the token field defensively and uses a conservative cache TTL.',
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
// Monetizze raw response shapes
// ---------------------------------------------------------------------------
//
// Why deliberately minimal: Monetizze's field names can vary across API
// versions. Treating every field as possibly absent and preserving the original
// under `rawNetworkData` keeps the adapter robust to upstream drift. Field names
// below are taken from the official callback example repo
// (https://github.com/Monetizze/ExemploPOSTCallback).

interface MonetizzeProdutoRaw {
  codigo?: string | number;
  nome?: string;
  categoria?: string;
  chave?: string;
}

interface MonetizzeComissaoRaw {
  refAfiliado?: string | number;
  nome?: string;
  tipo_comissao?: string;
  valor?: number | string;
  comissao?: number | string;
  email?: string;
}

interface MonetizzeSaleRaw {
  // Sale identity + status.
  codigo?: string | number;
  status?: string; // textual status (e.g. "Finalizada")
  codigo_status?: number | string; // numeric status code (1..7)
  // Amounts.
  valor?: number | string; // gross sale value
  valorRecebido?: number | string; // amount received
  // Dates (format yyyy-mm-dd H:i:s per callback docs).
  dataInicio?: string;
  dataFinalizada?: string;
  // Nested.
  produto?: MonetizzeProdutoRaw;
  comissoes?: MonetizzeComissaoRaw[];
}

interface MonetizzeTransactionsResponse {
  // The list wrapper field name is unconfirmed against live docs; read the
  // common candidates defensively. BLOCKED(verify).
  vendas?: MonetizzeSaleRaw[];
  transactions?: MonetizzeSaleRaw[];
  data?: MonetizzeSaleRaw[];
}

// Numeric Monetizze status code -> canonical TransactionStatus.
// Source: https://github.com/Monetizze/ExemploPOSTCallback (status codes).
const STATUS_CODE_MAP: Record<string, TransactionStatus> = {
  '1': 'pending', // Aguardando pagamento
  '2': 'approved', // Finalizada (payment confirmed; commission not yet paid out)
  '3': 'reversed', // Cancelada
  '4': 'reversed', // Devolvida (refunded)
  '5': 'reversed', // Bloqueada
  '6': 'paid', // Completa (cycle complete / settled)
  '7': 'other', // Abandono de Checkout
};

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Monetizze sale status to the canonical TransactionStatus.
 *
 * Preference order: the numeric `codigo_status` (stable, documented in the
 * callback example repo), then the textual `status` as a fallback.
 *
 * Monetizze -> canonical:
 *   1 Aguardando pagamento  -> 'pending'
 *   2 Finalizada            -> 'approved'  (payment confirmed; not yet paid out)
 *   3 Cancelada             -> 'reversed'
 *   4 Devolvida             -> 'reversed'  (refunded)
 *   5 Bloqueada             -> 'reversed'
 *   6 Completa              -> 'paid'      (cycle settled)
 *   7 Abandono de Checkout  -> 'other'
 *   anything else           -> 'other'
 *
 * Why 3/4/5 -> 'reversed': from the affiliate's perspective each means the sale
 * did not (or will no longer) pay out — semantically a reversal. The verbatim
 * status is preserved in `rawNetworkData`.
 */
function mapTransactionStatus(raw: MonetizzeSaleRaw): TransactionStatus {
  const code = raw.codigo_status;
  if (code !== undefined && code !== null) {
    const mapped = STATUS_CODE_MAP[String(code).trim()];
    if (mapped) return mapped;
  }
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'aguardando pagamento' || s === 'pending') return 'pending';
  if (s === 'finalizada' || s === 'approved') return 'approved';
  if (s === 'cancelada' || s === 'devolvida' || s === 'bloqueada' || s === 'reversed') return 'reversed';
  if (s === 'completa' || s === 'paid') return 'paid';
  return 'other';
}

/**
 * Map a Monetizze product/programme status to the canonical ProgrammeStatus.
 *
 * Monetizze does not expose a publisher<->programme relationship status through
 * a confirmed public endpoint, so this defaults to 'unknown' for anything it
 * cannot confidently map. Kept for parity with the reference adapters and used
 * by unit tests.
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (s === 'ativo' || s === 'active' || s === 'joined') return 'joined';
  if (s === 'pendente' || s === 'pending') return 'pending';
  if (s === 'recusado' || s === 'declined' || s === 'rejected') return 'declined';
  if (s === 'disponivel' || s === 'disponível' || s === 'available') return 'available';
  if (s === 'suspenso' || s === 'suspended' || s === 'pausado' || s === 'paused') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of a Monetizze sale at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: dataFinalizada (when payment was confirmed — how long has
 * this been approved-but-not-paid?) falls back to dataInicio (when the purchase
 * started). For pending sales, dataInicio is the earliest available anchor.
 */
function computeAgeDays(raw: MonetizzeSaleRaw, now: Date = new Date()): number {
  const anchor = raw.dataFinalizada ?? raw.dataInicio;
  if (!anchor) return 0;
  const t = parseMonetizzeDate(anchor);
  if (t === undefined) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Parse a Monetizze date. The callback docs use `yyyy-mm-dd H:i:s` (space
 * separator, no timezone). We treat that as UTC by replacing the space with `T`
 * and appending `Z`; ISO strings are parsed directly.
 */
function parseMonetizzeDate(d?: string | null): number | undefined {
  if (!d) return undefined;
  const direct = Date.parse(d);
  if (!Number.isNaN(direct)) return direct;
  const iso = `${d.trim().replace(' ', 'T')}Z`;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? undefined : ts;
}

function nullableIso(d?: string | null): string | undefined {
  const ts = parseMonetizzeDate(d);
  return ts === undefined ? undefined : new Date(ts).toISOString();
}

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Sum the affiliate commission for a sale from its `comissoes[]` rows.
 * Each row's `valor` is the monetary commission amount for that recipient.
 */
function sumCommission(raw: MonetizzeSaleRaw): number {
  if (!Array.isArray(raw.comissoes)) return 0;
  return raw.comissoes.reduce((acc, c) => acc + toAmount(c.valor), 0);
}

function toTransaction(raw: MonetizzeSaleRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = sumCommission(raw);
  const sale = toAmount(raw.valor);
  // Monetizze is a Brazilian platform; sales settle in BRL. Currency is not in
  // the documented sale payload, so we default to BRL and preserve the raw row.
  const currency = 'BRL';

  const startDate = nullableIso(raw.dataInicio) ?? new Date(0).toISOString();
  const finalisedDate = nullableIso(raw.dataFinalizada);

  return {
    id: String(raw.codigo ?? ''),
    network: SLUG,
    programmeId: String(raw.produto?.codigo ?? ''),
    programmeName: raw.produto?.nome ?? `Monetizze product ${raw.produto?.codigo ?? ''}`,
    status,
    amount: sale,
    currency,
    commission,
    // The API does not provide a separate click time; dataInicio is the earliest
    // available anchor (purchase start), used as the conversion date.
    dateConverted: startDate,
    // dataFinalizada is when payment was confirmed; treat as the approval date.
    dateApproved: finalisedDate,
    // datePaid is not separately exposed; left undefined.
    ageDays: computeAgeDays(raw, now),
    rawNetworkData: raw,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class MonetizzeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * No public Monetizze product-listing endpoint path or response shape could be
   * confirmed from accessible documentation. The interactive apidoc
   * (https://api.monetizze.com.br/2.1/apidoc/) is JS-rendered and refused
   * automated fetches.
   *
   * We throw NotImplementedError rather than calling an invented endpoint, and
   * rather than returning an empty array — the difference between "Monetizze
   * returned no products" and "the products endpoint is unconfirmed" is
   * principle 4.1.
   *
   * BLOCKED(verify): confirm the products endpoint path + shape against a live
   * account, then implement and remove this throw.
   */
  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(
      'Monetizze product/programme listing is not implemented: no public product-listing endpoint ' +
        'path or response shape could be confirmed from accessible documentation (the interactive ' +
        'apidoc is JS-rendered and refused automated fetches). See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Same restriction as listProgrammes — the product endpoint is unconfirmed.
   */
  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(
      'Monetizze single-product/programme lookup is not implemented: no public product endpoint ' +
        'path or response shape could be confirmed from accessible documentation.',
    );
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Monetizze sales (with their affiliate commissions) across a date window
   * with optional status / age / programme filters.
   *
   *   GET /transactions[?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&status=<n>]
   *
   * BLOCKED(verify): the advanced-filter query-parameter names (date window,
   * status) are unconfirmed against the live interactive docs. The adapter sends
   * `dataInicio`/`dataFim` (the field names used in the callback payload) and
   * also applies date/status filtering client-side as a safeguard, so results
   * are correct even if the server ignores the params.
   *
   * --- PRD §15.9: unpaid-age filter ------------------------------------------
   *
   * `query.minAgeDays` / `query.maxAgeDays` filter on the computed `ageDays`.
   *
   * --- PRD §15.10: reversed-sale visibility ----------------------------------
   *
   * Cancelled / refunded / blocked sales (status codes 3/4/5) are normalised to
   * 'reversed'.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = await getToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const params: Record<string, string | number | undefined> = {
      dataInicio: from.toISOString().slice(0, 10),
      dataFim: to.toISOString().slice(0, 10),
    };

    const response = await monetizzeRequest<MonetizzeTransactionsResponse>({
      operation: 'listTransactions',
      path: '/transactions',
      token,
      query: params,
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const rawSales: MonetizzeSaleRaw[] = Array.isArray(response.vendas)
      ? response.vendas
      : Array.isArray(response.transactions)
        ? response.transactions
        : Array.isArray(response.data)
          ? response.data
          : [];

    let transactions = rawSales.map((r) => toTransaction(r, now));

    // Client-side date-window safeguard (in case the server ignores the params).
    const fromMs = from.getTime();
    const toMs = to.getTime();
    transactions = transactions.filter((t) => {
      const ts = Date.parse(t.dateConverted);
      if (Number.isNaN(ts)) return true;
      return ts >= fromMs && ts <= toMs;
    });

    // Programme (product) filter.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === query.programmeId);
    }

    // Canonical status filter — applied on the normalised status.
    const statusFilter = toTransactionStatusList(query?.status);
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
   * We derive from `listTransactions` for the same reason as Awin/Skimlinks: a
   * dedicated reports endpoint would be a second source of truth for the same
   * data, and we still need the per-transaction `ageDays` to compute
   * `oldestUnpaidAgeDays`. One call, one source.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts
   * (principle 4.1).
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
      currency: 'BRL',
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
          programmeName: t.programmeName || `Monetizze product ${key}`,
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
      currency: firstCurrency ?? 'BRL',
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
   * Monetizze does not expose click-level data via its public API — it is a
   * sale/commission reporting API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Monetizze does not expose click-level data via its public API (it is a sale/commission reporting API).',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Monetizze affiliate tracking links are generated inside the panel (per
   * product, after affiliation is approved); there is no documented,
   * deterministic public endpoint to construct them from credentials alone.
   *
   * We throw NotImplementedError rather than fabricating a URL format — the
   * difference between a verified link format and a guess is principle 4.1.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Monetizze affiliate links are generated inside the panel (per product, after affiliation); ' +
        'there is no documented deterministic public endpoint to construct them.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials by successfully exchanging the access key for a token.
   *
   * On success: returns { ok: true, identity: '...' }.
   * On failure (wrong key, network error): returns { ok: false, reason: '...' }.
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
   * Probe each operation with a minimal call.
   *
   * listProgrammes / getProgramme / listClicks / generateTrackingLink are
   * known-unsupported and are recorded without probing to avoid wasting calls.
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

    // Known-unsupported ops — record without probing.
    operations['listProgrammes'] = {
      supported: false,
      note: 'No public Monetizze product-listing endpoint could be confirmed; unimplemented.',
    };
    operations['getProgramme'] = {
      supported: false,
      note: 'No public Monetizze product endpoint could be confirmed; unimplemented.',
    };
    operations['listClicks'] = {
      supported: false,
      note: 'Monetizze does not expose click-level data via its public API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Monetizze affiliate links are generated inside the panel; no deterministic public endpoint.',
    };

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

export const monetizzeAdapter = new MonetizzeAdapter();
registerAdapter(monetizzeAdapter);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function toTransactionStatusList(
  v?: TransactionStatus | TransactionStatus[],
): TransactionStatus[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Internal test helpers — exported so unit tests can exercise transformers
// directly without network calls.
// ---------------------------------------------------------------------------

export const _internals = {
  mapTransactionStatus,
  mapProgrammeStatus,
  computeAgeDays,
  parseMonetizzeDate,
  toTransaction,
  sumCommission,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
