/**
 * Lomadee adapter — publisher-side implementation (Brazil).
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` and mirrors
 * `src/networks/skimlinks/adapter.ts`. Awin is the canonical reference; read it
 * for the deep reasoning behind the structure. The load-bearing decisions
 * replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper that prefers
 *     `unknown`/`other` over a wrong guess.
 *   - `ageDays` is computed per transaction with an injectable `now`.
 *   - UK English; "programme" not "program".
 *
 * --- Lomadee API map -----------------------------------------------------------
 *
 * Auth model: `custom`. App-token + sourceId carried in the request URL for the
 * offers and deeplink APIs; a separate report token (minted from account
 * e-mail + password) plus publisherId for the sales-report API. See auth.ts.
 *   Source: https://developer.lomadee.com/
 *           https://developer.socialsoul.com.vc/lab/tutoriais/afiliados/pra-que-serve-o-app-token-e-como-criar.html
 *
 * Offers API → listProgrammes / getProgramme:
 *   GET /v3/{appToken}/offer/_search?keyword={kw}&sourceId={sourceId}
 *   GET /v3/{appToken}/offer/_bestsellers?sourceId={sourceId}
 *   We surface the distinct merchant STORES carried on the offers as programmes —
 *   Lomadee's publisher-facing discovery surface is offer/store oriented, not a
 *   "joined programmes" list, so programme.status is 'available' (not 'joined').
 *   Source: https://developer.socialsoul.com.vc/afiliados/ofertas/v1/
 *
 * Sales report ("Consulte suas vendas") → listTransactions / getEarningsSummary:
 *   GET /api/lomadee/reportTransaction?publisherId={publisherId}&token={reportToken}
 *   Returns XML covering up to 90 days from the start date.
 *   Source: https://developer.socialsoul.com.vc/afiliados/relatorios/recursos/consulte-suas-vendas/
 *   BLOCKED(verify): the exact XML element names are not published anywhere
 *   indexable. The parser below is defensive (reads several plausible field
 *   names) and preserves the verbatim per-transaction XML on rawNetworkData.
 *   Status mapping defaults to 'other' and a live-account test is required
 *   before claim_status moves beyond 'experimental'.
 *
 * Deeplink API → generateTrackingLink (real API call):
 *   GET /service/createLinks/lomadee/{appToken}/?sourceId={sourceId}&link1={url}
 *   Source: https://developer.socialsoul.com.vc/afiliados/deeplink/
 *
 * Clicks → NotImplementedError. Lomadee does not expose a click-level API to
 * publishers.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use the lomadee* request helpers.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`. Never swallow.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction with an injectable `now`.
 *   6. Read credentials via `requireCredential` — NEVER process.env (except tests).
 *   7. UK English. "programme", not "program".
 */

import { lomadeeJsonRequest, lomadeeTextRequest } from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, getReportToken } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { requireCredential } from '../../shared/config.js';
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

const log = createLogger('lomadee.adapter');

const SLUG = 'lomadee';
const NAME = 'Lomadee';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://api.lomadee.com',
  authModel: 'custom',
  docsUrl: 'https://developer.lomadee.com/',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'The sales-report API (reportTransaction) returns XML whose exact element names are not published; the adapter parses defensively and preserves the verbatim XML on rawNetworkData. Transaction status mapping and date fields require live-account verification.',
    'The sales-report API covers a maximum window of 90 days from the start date; listTransactions defaults to the most recent 90 days when no window is supplied.',
    'listProgrammes / getProgramme are derived from the Offers API (offer stores), not a joined-programmes endpoint; programme status is reported as "available" because Lomadee does not expose per-publisher join state via this API.',
    'listClicks is not exposed by the Lomadee publisher API; the operation throws NotImplementedError.',
    'The report API uses a token minted from the account e-mail and password (LOMADEE_REPORT_USER / LOMADEE_REPORT_PASSWORD), separate from the app-token used by offers and deeplinks.',
    'Lomadee may take up to 3 days to release API access on a newly created account.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 15,
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
// Lomadee raw response shapes (JSON — offers / deeplink)
// ---------------------------------------------------------------------------
//
// Deliberately minimal and permissive: Lomadee's field set varies across API
// versions. Treating every field as possibly absent and preserving the original
// under `rawNetworkData` keeps the adapter robust to upstream drift.

interface LomadeeStoreRaw {
  id?: string | number;
  name?: string;
  link?: string;
  thumbnail?: string;
}

interface LomadeeOfferRaw {
  id?: string | number;
  name?: string;
  link?: string;
  price?: number | string;
  priceFrom?: number | string;
  store?: LomadeeStoreRaw;
  category?: { id?: string | number; name?: string };
}

interface LomadeeOffersResponse {
  offers?: LomadeeOfferRaw[];
  pagination?: { page?: number; totalPage?: number; size?: number };
  requestInfo?: { status?: string; message?: string };
}

interface LomadeeLinkRaw {
  id?: string | number;
  link?: string;
  redirectLink?: string;
  originalLink?: string;
}

interface LomadeeCreateLinksResponse {
  links?: LomadeeLinkRaw[];
  requestInfo?: { status?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Lomadee sales-report raw shape (parsed from XML)
// ---------------------------------------------------------------------------
//
// BLOCKED(verify): the reportTransaction XML schema is not published. The parser
// reads each <transaction> (or <sale>) element's children into a flat map of
// string values; the transformer then reads several plausible field names.
// The verbatim per-transaction fragment is preserved on rawNetworkData.

interface LomadeeReportRaw {
  [field: string]: string;
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Lomadee sales status string to the canonical TransactionStatus.
 *
 * Lomadee/SocialSoul commission states (Portuguese) → canonical:
 *   pendente / aguardando / em análise   → 'pending'
 *   aprovada / aprovado / confirmada     → 'approved'
 *   paga / pago                          → 'paid'
 *   cancelada / recusada / estornada     → 'reversed'
 *   anything else / absent               → 'other'
 *
 * Why default 'other': the exact set of Portuguese status strings emitted by
 * reportTransaction is not documented. We map the obvious ones and preserve the
 * verbatim value in `rawNetworkData` for everything else (principle: never guess).
 */
function mapTransactionStatus(raw: LomadeeReportRaw): TransactionStatus {
  const s = (raw.status ?? raw.situacao ?? raw.situation ?? '').toLowerCase().trim();
  if (!s) return 'other';
  if (s.includes('pend') || s.includes('aguard') || s.includes('anális') || s.includes('analis')) {
    return 'pending';
  }
  if (s.includes('aprov') || s.includes('confirm') || s.includes('approv')) return 'approved';
  if (s.includes('pag') || s.includes('paid')) return 'paid';
  if (s.includes('cancel') || s.includes('recus') || s.includes('estorn') || s.includes('revers') || s.includes('reject')) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map a Lomadee store/offer relationship to the canonical ProgrammeStatus.
 *
 * The Offers API does not expose per-publisher join state, so a store surfaced
 * via offers is "available" to promote. Any explicit status string is mapped
 * where recognised; otherwise we report 'available' (the store IS promotable),
 * not 'unknown'.
 */
function mapProgrammeStatus(raw: { status?: string }): ProgrammeStatus {
  const s = (raw.status ?? '').toLowerCase().trim();
  if (!s) return 'available';
  if (s === 'active' || s === 'joined' || s === 'ativo' || s === 'ativa') return 'joined';
  if (s === 'pending' || s === 'pendente') return 'pending';
  if (s === 'declined' || s === 'rejected' || s === 'recusado') return 'declined';
  if (s === 'available' || s === 'disponivel' || s === 'disponível') return 'available';
  if (s === 'suspended' || s === 'paused' || s === 'pausado' || s === 'suspenso') return 'suspended';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function toAmount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  // Lomadee report amounts may use a comma decimal separator (pt-BR).
  const normalised = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(normalised);
  if (!Number.isNaN(n)) return n;
  const plain = parseFloat(String(v));
  return Number.isNaN(plain) ? 0 : plain;
}

function nullableIso(d?: string | null): string | undefined {
  if (!d) return undefined;
  const ts = Date.parse(d);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

/**
 * Compute the age (in days) of a Lomadee transaction at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: validation/approval date (how long approved-but-not-paid?)
 * then the conversion/transaction date. `now` is injectable for deterministic tests.
 */
function computeAgeDays(raw: LomadeeReportRaw, now: Date = new Date()): number {
  const anchor =
    raw.validationDate ??
    raw.approvedDate ??
    raw.dateApproved ??
    raw.transactionDate ??
    raw.dateConverted ??
    raw.date ??
    raw.data;
  if (!anchor) return 0;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function toTransaction(raw: LomadeeReportRaw, now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(raw);
  const commission = toAmount(raw.commission ?? raw.comissao ?? raw.commissionValue);
  const sale = toAmount(raw.saleValue ?? raw.value ?? raw.valor ?? raw.amount);
  const currency = (raw.currency ?? raw.moeda ?? 'BRL').toUpperCase();

  const transactionDate =
    nullableIso(raw.transactionDate ?? raw.dateConverted ?? raw.date ?? raw.data) ??
    new Date(0).toISOString();
  const clickDate = nullableIso(raw.clickDate ?? raw.dateClicked ?? raw.dataClique);
  const approvedDate = nullableIso(raw.validationDate ?? raw.approvedDate ?? raw.dateApproved);
  const paidDate = nullableIso(raw.paidDate ?? raw.datePaid ?? raw.dataPagamento);

  const programmeId = String(raw.storeId ?? raw.advertiserId ?? raw.lojaId ?? raw.store ?? '');
  const programmeName = raw.storeName ?? raw.advertiserName ?? raw.loja ?? `Lomadee store ${programmeId}`;

  return {
    id: String(raw.id ?? raw.transactionId ?? raw.orderId ?? raw.pedido ?? ''),
    network: SLUG,
    programmeId,
    programmeName,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: transactionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(raw, now),
    reversalReason: status === 'reversed' ? raw.reason ?? raw.motivo ?? undefined : undefined,
    rawNetworkData: raw,
  };
}

function toProgramme(store: LomadeeStoreRaw, sampleOffer?: LomadeeOfferRaw): Programme {
  const id = String(store.id ?? '');
  const programme: Programme = {
    id,
    name: store.name ?? `Lomadee store ${id}`,
    network: SLUG,
    status: mapProgrammeStatus({}),
    advertiserUrl: store.link,
    rawNetworkData: sampleOffer ? { store, sampleOffer } : { store },
  };
  const category = sampleOffer?.category?.name;
  if (category) programme.categories = [category];
  return programme;
}

// ---------------------------------------------------------------------------
// XML parsing for the sales report
// ---------------------------------------------------------------------------

/**
 * Parse the reportTransaction XML body into a list of flat field maps.
 *
 * We deliberately avoid adding an XML-parser dependency: the document is a flat
 * list of transaction records, so a small, well-scoped regex extraction is
 * sufficient and keeps the dependency surface unchanged. Each record element
 * (commonly <transaction> or <sale>) is captured verbatim and its direct child
 * elements are read into a string map. Unknown shapes degrade to an empty list
 * rather than throwing — the verbatim body is still available to the caller via
 * the error path if the request itself failed.
 *
 * BLOCKED(verify): element names are unconfirmed. The transformer reads several
 * plausible names; live verification is required.
 */
function parseReportXml(xml: string): LomadeeReportRaw[] {
  if (!xml || xml.trim() === '') return [];
  const records: LomadeeReportRaw[] = [];
  // Match repeated <transaction>…</transaction> or <sale>…</sale> blocks.
  const recordRe = /<(transaction|sale)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let recordMatch: RegExpExecArray | null;
  while ((recordMatch = recordRe.exec(xml)) !== null) {
    const inner = recordMatch[2] ?? '';
    const fields: LomadeeReportRaw = {};
    const fieldRe = /<([a-zA-Z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRe.exec(inner)) !== null) {
      const key = fieldMatch[1];
      const value = decodeXmlEntities((fieldMatch[2] ?? '').trim());
      if (key) fields[key] = value;
    }
    records.push(fields);
  }
  return records;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireAppToken(operation: string): string {
  return requireCredential('LOMADEE_APP_TOKEN', {
    network: SLUG,
    operation,
    hint: 'Set LOMADEE_APP_TOKEN in ~/.affiliate-mcp/.env (affiliate panel → Credenciais de API → Gerar Token).',
  });
}

function requireSourceId(operation: string): string {
  return requireCredential('LOMADEE_SOURCE_ID', {
    network: SLUG,
    operation,
    hint: 'Set LOMADEE_SOURCE_ID in ~/.affiliate-mcp/.env (your publisher sourceId from the affiliate panel).',
  });
}

function requirePublisherId(operation: string): string {
  return requireCredential('LOMADEE_PUBLISHER_ID', {
    network: SLUG,
    operation,
    hint: 'Set LOMADEE_PUBLISHER_ID in ~/.affiliate-mcp/.env (your numeric publisher ID).',
  });
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class LomadeeAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * List the merchant stores the publisher can promote, derived from the Offers
   * API. Lomadee's publisher-facing discovery surface is offer/store oriented;
   * there is no "joined programmes" endpoint, so programme status is 'available'.
   *
   *   GET /v3/{appToken}/offer/_search?keyword={kw}&sourceId={sourceId}
   *   GET /v3/{appToken}/offer/_bestsellers?sourceId={sourceId}  (when no search term)
   *
   * Stores are de-duplicated by store id; the first offer seen for a store is
   * retained as a sample for category context.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const appToken = requireAppToken('listProgrammes');
    const sourceId = requireSourceId('listProgrammes');

    const keyword = query?.search?.trim();
    const path = keyword
      ? `/v3/${encodeURIComponent(appToken)}/offer/_search`
      : `/v3/${encodeURIComponent(appToken)}/offer/_bestsellers`;

    const params: Record<string, string | number | undefined> = { sourceId };
    if (keyword) params['keyword'] = keyword;

    const response = await lomadeeJsonRequest<LomadeeOffersResponse>({
      operation: 'listProgrammes',
      path,
      query: params,
      resilience: RESILIENCE.default,
    });

    const offers = Array.isArray(response.offers) ? response.offers : [];

    const byStore = new Map<string, Programme>();
    for (const offer of offers) {
      const store = offer.store;
      if (!store || store.id === undefined) continue;
      const key = String(store.id);
      if (!byStore.has(key)) {
        byStore.set(key, toProgramme(store, offer));
      }
    }

    let programmes = [...byStore.values()];

    // Client-side filters (the offers API does not filter by programme metadata).
    if (query?.categories && query.categories.length > 0) {
      const wanted = new Set(query.categories.map((c) => c.toLowerCase()));
      programmes = programmes.filter((p) =>
        (p.categories ?? []).some((c) => wanted.has(c.toLowerCase())),
      );
    }
    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Look up a single store by id. The Offers API has no "store by id" endpoint,
   * so we search offers for the store and return the first match. Throws a
   * network_api_error envelope when no store with the id is found in the offers
   * surface (principle 4.1: never fabricate a programme that the API did not return).
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the Lomadee store id (the programme id returned by listProgrammes).',
        }),
      );
    }

    const programmes = await this.listProgrammes({});
    const match = programmes.find((p) => p.id === String(programmeId));
    if (!match) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `No Lomadee store with id "${programmeId}" was found in the current offers surface.`,
          hint: 'The Offers API only surfaces stores that currently have offers. Use a search term via listProgrammes to widen the surface.',
        }),
      );
    }
    return match;
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * List Lomadee sales via the "Consulte suas vendas" report API.
   *
   *   GET /api/lomadee/reportTransaction?publisherId={publisherId}&token={reportToken}
   *
   * The report covers up to 90 days from the start date; we default to the most
   * recent 90 days when no window is supplied. The endpoint returns XML, which
   * we parse defensively (see parseReportXml). Status / age / programme / date
   * filters are applied client-side because the endpoint's server-side filter
   * parameters are undocumented.
   *
   * PRD §15.9 (unpaid-age) and §15.10 (reversed visibility) are applied the same
   * way as the other adapters.
   *
   * BLOCKED(verify): XML element names and the precise status vocabulary are
   * unconfirmed; live-account verification required.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const publisherId = requirePublisherId('listTransactions');
    const token = await getReportToken();
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from ? new Date(query.from) : new Date(now.getTime() - NINETY_DAYS_MS);

    const xml = await lomadeeTextRequest({
      operation: 'listTransactions',
      path: '/api/lomadee/reportTransaction',
      query: {
        publisherId,
        token,
        // Lomadee's report start/end parameter names are not documented; we send
        // commonly used names so the window is honoured server-side where supported,
        // and we still filter client-side below for correctness.
        startDate: from.toISOString().slice(0, 10),
        endDate: to.toISOString().slice(0, 10),
      },
      resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
    });

    const records = parseReportXml(xml);
    let transactions = records.map((r) => toTransaction(r, now));

    // Client-side conversion-window filter (the server-side window is best-effort).
    const fromMs = from.getTime();
    const toMs = to.getTime();
    transactions = transactions.filter((t) => {
      const ts = Date.parse(t.dateConverted);
      if (Number.isNaN(ts)) return true; // keep undateable rows; raw is preserved
      return ts >= fromMs && ts <= toMs;
    });

    // Status filter.
    const statusFilter = toTransactionStatusList(query?.status);
    if (statusFilter && statusFilter.length > 0) {
      const set = new Set(statusFilter);
      transactions = transactions.filter((t) => set.has(t.status));
    }

    // Programme filter.
    if (query?.programmeId) {
      transactions = transactions.filter((t) => t.programmeId === String(query.programmeId));
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

    log.debug({ count: transactions.length, publisherId }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (one call, one source of truth) so the user
   * can recompute the summary from the transactions they see, and so the
   * per-transaction `ageDays` is available for `oldestUnpaidAgeDays`.
   *
   * Do NOT pass `query.limit` through — a limited summary undercounts (principle 4.1).
   */
  async getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary> {
    const now = new Date();
    const from = query?.from ?? new Date(now.getTime() - NINETY_DAYS_MS).toISOString();
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
          programmeName: t.programmeName || `Lomadee store ${key}`,
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
   * Lomadee does not expose click-level data to publishers via its public API.
   *
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed by the
   * API" is principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Lomadee does not expose click-level data via its public publisher API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Mint a Lomadee affiliate deeplink via the createLinks API (a real API call —
   * the link is generated server-side, unlike Awin/Skimlinks deterministic URLs).
   *
   *   GET /service/createLinks/lomadee/{appToken}/?sourceId={sourceId}&link1={url}
   *
   * The destination URL is validated before the call. The minted link is read
   * from the first element of the response `links` array; the verbatim response
   * is preserved on `rawNetworkData`.
   *
   * Source: https://developer.socialsoul.com.vc/afiliados/deeplink/
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full advertiser URL you want to convert into a Lomadee affiliate link.',
        }),
      );
    }

    const appToken = requireAppToken('generateTrackingLink');
    const sourceId = requireSourceId('generateTrackingLink');

    const response = await lomadeeJsonRequest<LomadeeCreateLinksResponse>({
      operation: 'generateTrackingLink',
      path: `/service/createLinks/lomadee/${encodeURIComponent(appToken)}/`,
      query: { sourceId, link1: input.destinationUrl },
      resilience: RESILIENCE.default,
    });

    const first = Array.isArray(response.links) ? response.links[0] : undefined;
    const trackingUrl = first?.redirectLink ?? first?.link;
    if (!trackingUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          networkErrorBody: JSON.stringify(response),
          message: 'Lomadee createLinks returned no link for the supplied URL.',
          hint: 'Confirm the destination URL belongs to a Lomadee advertiser and that LOMADEE_APP_TOKEN / LOMADEE_SOURCE_ID are valid.',
        }),
      );
    }

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: input.programmeId || undefined,
      createdAt: new Date().toISOString(),
      rawNetworkData: response,
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify the app-token + sourceId by minting a deeplink (see auth.ts).
   *
   * On success: { ok: true, identity }. On failure: { ok: false, reason }.
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
   * Probe each operation with a minimal call. listClicks is known-unsupported and
   * recorded without probing.
   */
  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>, note?: string): Promise<void> => {
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

    // Known-unsupported op — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Lomadee does not expose click-level data via its public publisher API.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('listTransactions', () => this.listTransactions({ limit: 1 }), 'Report XML shape unverified against a live account.');
    await probe('getEarningsSummary', () => this.getEarningsSummary({ limit: 1 }), 'Derived from listTransactions; report XML shape unverified.');

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

export const lomadeeAdapter = new LomadeeAdapter();
registerAdapter(lomadeeAdapter);

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
  toTransaction,
  toProgramme,
  parseReportXml,
  toAmount,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
