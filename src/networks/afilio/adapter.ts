/**
 * Afilio adapter — publisher-side implementation.
 *
 * READ ME FIRST (agents adding other networks):
 *
 * This file follows the pattern of `src/networks/awin/adapter.ts` (the canonical
 * reference) and mirrors `src/networks/skimlinks/adapter.ts`. The load-bearing
 * decisions replicated here:
 *   - Never call `fetch` outside `client.ts`.
 *   - Every failure round-trips through a `NetworkErrorEnvelope`.
 *   - Raw payloads are preserved in `rawNetworkData` on every domain object.
 *   - Status enums are normalised with a documented mapping helper that prefers
 *     `unknown`/`other` over a wrong guess.
 *   - `ageDays` is computed per transaction with an injectable `now`.
 *   - Credentials are read via `requireCredential` only.
 *   - UK English; "programme" not "program".
 *
 * --- Afilio API map ------------------------------------------------------------
 *
 * Afilio is a Brazilian performance-marketing network. The affiliate-facing
 * reporting APIs are query-parameter authenticated (token + affid) and return
 * XML. There is no OAuth and no deterministic, self-serve deeplink builder
 * documented for affiliates.
 *
 * Sales & Leads API → listTransactions / getEarningsSummary
 *   GET /api/leadsale_api.php?mode=list&token=..&affid=..&type=sale|lead
 *       &dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD&format=XML
 *   Source: https://v2.afilio.com.br/Manual/manuais-v2.html
 *           http://static.afilio.com.br/Manuais%202016/API_Sales_e_Leads_PT.pdf
 *
 * Campaign Description API → listProgrammes / getProgramme
 *   GET /api/{campaign endpoint}?token=..&affid=..&format=XML
 *   Documented fields: ID, Nome, URL, Descrição, Progdate, Progdeb, Progfin,
 *   SiteID, Cpmprice, Clicprice, Dblclicprice, Leadprice, Saleprice,
 *   Downloadprice, Status.
 *   Source: https://v2.afilio.com.br/Manual/manuais/api-campanhas.pdf
 *
 * listClicks → NotImplementedError (no click-level affiliate API is documented).
 * generateTrackingLink → NotImplementedError (Afilio deeplinks are generated in
 *   the dashboard; no documented deterministic format from campaign id + aff id).
 *
 * BLOCKED(verify): the documentation PDFs are WAF-blocked (HTTP 403 to automated
 * clients), so the EXACT XML element names, the EXACT campaign endpoint filename,
 * and the full status vocabulary are reconstructed from the manual index and
 * search snippets, not read verbatim. The adapter reads fields defensively and
 * the network ships `experimental` until confirmed against a live account.
 *
 * --- Cardinal rules (non-negotiable) ------------------------------------------
 *
 *   1. Never call `fetch` outside `client.ts`. Use `afilioRequest`.
 *   2. Every failure round-trips through a `NetworkErrorEnvelope`.
 *   3. Preserve raw payloads in `rawNetworkData` on every domain object.
 *   4. Normalise status enums. Prefer `unknown`/`other` over a wrong guess.
 *   5. Compute `ageDays` per transaction. See `computeAgeDays`.
 *   6. Read credentials via `requireCredential` from shared/config.
 *   7. UK English. "programme", not "program".
 */

import {
  afilioRequest,
  parseAfilioXmlRows,
  AFILIO_LEADSALE_PATH,
  AFILIO_CAMPAIGN_PATH,
  type AfilioXmlRow,
} from './client.js';
import { verifyAuth as authVerify, validateCredential as authValidate, requireToken, requireAffId } from './auth.js';
import { setupSteps } from './setup.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CommissionRateStructured,
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

const log = createLogger('afilio.adapter');

const SLUG = 'afilio';
const NAME = 'Afilio';

/** Afilio is a Brazilian network; transactions are denominated in BRL. */
const DEFAULT_CURRENCY = 'BRL';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: 'https://v2.afilio.com.br',
  authModel: 'custom',
  docsUrl: 'https://v2.afilio.com.br/Manual/manuais-v2.html',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-04',
  claimStatus: 'experimental',
  knownLimitations: [
    'Adapter built from public API documentation; not yet verified against a live account.',
    'Afilio documentation PDFs are served behind a WAF (HTTP 403 to automated clients), so the exact XML field names, the exact Campaign Description endpoint filename, and the full status vocabulary could not be read verbatim; field readers are defensive and all original data is preserved in rawNetworkData. BLOCKED(verify).',
    'listClicks is not exposed by any documented Afilio affiliate API; the operation throws NotImplementedError.',
    'generateTrackingLink is not implemented: Afilio deeplinks are generated inside the dashboard and no deterministic affiliate-side link format (from a campaign id + Aff ID) is documented; the operation throws NotImplementedError.',
    'getProgramme filters the Campaign Description list client-side; Afilio does not document a single-campaign lookup endpoint.',
    'Transaction currency defaults to BRL when the API response omits a currency field; the verbatim row is preserved in rawNetworkData.',
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

// ---------------------------------------------------------------------------
// Field readers — defensive over reconstructed field names
// ---------------------------------------------------------------------------
//
// The Afilio XML field names could not be read verbatim (PDFs are WAF-blocked),
// so each reader tries several candidate names (all lower-cased, matching the
// parser's normalisation). Adding a confirmed name later is a one-line change.

function pick(row: AfilioXmlRow, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n.toLowerCase()];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function toAmount(v: string | undefined): number {
  if (v === undefined) return 0;
  // Afilio is Brazilian; values may use a comma decimal separator. Normalise:
  // strip thousands separators (.) only when a comma is present as the decimal.
  let s = v.trim();
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function nullableIso(d?: string): string | undefined {
  if (!d) return undefined;
  // Accept both ISO and "YYYY-MM-DD HH:MM:SS" (common in PT-BR APIs).
  const normalised = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(d) ? d.replace(' ', 'T') : d;
  const ts = Date.parse(normalised);
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Status mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an Afilio sale/lead status to the canonical TransactionStatus.
 *
 * Afilio reports status in Portuguese. Observed/likely values and our mapping:
 *   pendente / pending / aguardando   → 'pending'  (awaiting validation)
 *   aprovado / approved / validado    → 'approved' (validated, not yet paid)
 *   pago / paid                       → 'paid'     (paid out to the affiliate)
 *   cancelado / rejeitado / recusado /
 *     estornado / reversed / declined → 'reversed' (did not pay out)
 *   anything else                     → 'other'
 *
 * Why 'cancelado'/'estornado' → 'reversed': from the affiliate's perspective a
 * cancelled or charged-back sale did not pay out — semantically a reversal,
 * which is what every other network calls this state. The verbatim status is
 * preserved in `rawNetworkData`.
 *
 * BLOCKED(verify): the exact Afilio status vocabulary is not confirmed verbatim;
 * unrecognised values fall through to 'other' rather than being guessed.
 */
function mapTransactionStatus(rawStatus: string | undefined): TransactionStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (s === 'pendente' || s === 'pending' || s === 'aguardando' || s === 'em analise' || s === 'em análise') {
    return 'pending';
  }
  if (s === 'aprovado' || s === 'aprovada' || s === 'approved' || s === 'validado' || s === 'confirmado') {
    return 'approved';
  }
  if (s === 'pago' || s === 'paga' || s === 'paid') {
    return 'paid';
  }
  if (
    s === 'cancelado' ||
    s === 'cancelada' ||
    s === 'rejeitado' ||
    s === 'recusado' ||
    s === 'estornado' ||
    s === 'reversed' ||
    s === 'declined' ||
    s === 'rejected'
  ) {
    return 'reversed';
  }
  return 'other';
}

/**
 * Map an Afilio campaign status to the canonical ProgrammeStatus.
 *
 * The Campaign Description API returns campaigns the affiliate can see; it does
 * not clearly distinguish join state, so we map activity, not membership, and
 * default to 'unknown' for anything we cannot confidently classify.
 *
 *   ativo / active / ativa / 1        → 'joined'   (active relationship)
 *   pendente / pending                → 'pending'
 *   recusado / declined / rejeitado   → 'declined'
 *   disponivel / disponível / available → 'available'
 *   pausado / suspenso / inativo / paused / suspended → 'suspended'
 *   anything else                     → 'unknown'
 *
 * BLOCKED(verify): exact campaign status vocabulary not confirmed verbatim.
 */
function mapProgrammeStatus(rawStatus: string | undefined): ProgrammeStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (s === 'ativo' || s === 'ativa' || s === 'active' || s === '1' || s === 'on') return 'joined';
  if (s === 'pendente' || s === 'pending') return 'pending';
  if (s === 'recusado' || s === 'declined' || s === 'rejeitado' || s === 'rejected') return 'declined';
  if (s === 'disponivel' || s === 'disponível' || s === 'available') return 'available';
  if (s === 'pausado' || s === 'suspenso' || s === 'inativo' || s === 'paused' || s === 'suspended' || s === '0') {
    return 'suspended';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Domain object transformers
// ---------------------------------------------------------------------------

/**
 * Compute the age (in days) of an Afilio transaction at the moment the adapter
 * responded. PRD §15.9 — the unpaid-age affordance depends on this.
 *
 * Anchor priority: conversion/sale date (when the transaction happened) is the
 * earliest and most reliable anchor across both sales and leads.
 */
function computeAgeDays(row: AfilioXmlRow, now: Date = new Date()): number {
  const anchor =
    pick(row, 'date', 'data', 'saledate', 'leaddate', 'transactiondate', 'datetime', 'created', 'datahora');
  const iso = nullableIso(anchor);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ms = now.getTime() - t;
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Transform one Afilio sale/lead XML row into a canonical Transaction.
 *
 * `kind` distinguishes the API call that produced the row ('sale' | 'lead') and
 * is surfaced so the caller can tell apart a CPA sale from a CPL lead even when
 * the upstream row shape is otherwise identical.
 */
function toTransaction(row: AfilioXmlRow, kind: 'sale' | 'lead', now: Date = new Date()): Transaction {
  const status = mapTransactionStatus(pick(row, 'status', 'situacao', 'situação'));
  const commission = toAmount(pick(row, 'commission', 'comissao', 'comissão', 'valor', 'value', 'price'));
  // Gross order value (sales only). Leads usually have no order value.
  const sale = toAmount(pick(row, 'salevalue', 'ordervalue', 'valorvenda', 'valorpedido', 'amount'));
  const currency = (pick(row, 'currency', 'moeda') ?? DEFAULT_CURRENCY).toUpperCase();

  const conversionDate =
    nullableIso(pick(row, 'date', 'data', 'saledate', 'leaddate', 'transactiondate', 'datahora')) ??
    new Date(0).toISOString();
  const clickDate = nullableIso(pick(row, 'clickdate', 'dataclick', 'dataclique', 'clicktime'));
  const approvedDate = nullableIso(pick(row, 'approveddate', 'dataaprovacao', 'dataaprovação', 'datavalidacao'));
  const paidDate = nullableIso(pick(row, 'paiddate', 'datapagamento'));

  const programmeId =
    pick(row, 'programid', 'campaignid', 'campid', 'idcampanha', 'idprograma', 'progid') ?? '';
  const programmeName =
    pick(row, 'programname', 'campaignname', 'campanha', 'nomecampanha', 'nome') ??
    (programmeId ? `Afilio campaign ${programmeId}` : `Afilio ${kind}`);

  const reversalReason =
    status === 'reversed' ? pick(row, 'reason', 'motivo', 'reversalreason') : undefined;

  const id = pick(row, 'transactionid', 'id', 'transid', 'orderid', 'pedidoid', 'leadid') ?? '';

  return {
    id: String(id),
    network: SLUG,
    programmeId: String(programmeId),
    programmeName,
    status,
    amount: sale,
    currency,
    commission,
    dateClicked: clickDate,
    dateConverted: conversionDate,
    dateApproved: approvedDate,
    datePaid: paidDate,
    ageDays: computeAgeDays(row, now),
    reversalReason,
    rawNetworkData: { kind, ...row },
  };
}

/** Transform one Afilio campaign XML row into a canonical Programme. */
function toProgramme(row: AfilioXmlRow): Programme {
  const id = pick(row, 'id', 'campaignid', 'campid', 'idcampanha', 'programid') ?? '';
  const name = pick(row, 'nome', 'name', 'campaignname', 'campanha') ?? `Afilio campaign ${id}`;
  const status = mapProgrammeStatus(pick(row, 'status', 'situacao', 'situação'));
  const advertiserUrl = pick(row, 'url', 'site', 'website');
  const description = pick(row, 'descricao', 'descrição', 'description', 'desc');

  // Afilio reports several price types per campaign (CPC, CPL, CPA, …). We pick
  // the sale price (CPA) as the headline commission when present, else the lead
  // price (CPL). The full set stays in rawNetworkData.
  const salePrice = pick(row, 'saleprice', 'valorvenda');
  const leadPrice = pick(row, 'leadprice', 'valorlead');
  const clickPrice = pick(row, 'clicprice', 'clickprice', 'valorclique');

  let commissionRate: string | CommissionRateStructured | undefined;
  if (salePrice !== undefined) {
    commissionRate = { type: 'flat', value: toAmount(salePrice), currency: DEFAULT_CURRENCY, description: 'Saleprice (CPA)' };
  } else if (leadPrice !== undefined) {
    commissionRate = { type: 'flat', value: toAmount(leadPrice), currency: DEFAULT_CURRENCY, description: 'Leadprice (CPL)' };
  } else if (clickPrice !== undefined) {
    commissionRate = { type: 'flat', value: toAmount(clickPrice), currency: DEFAULT_CURRENCY, description: 'Clicprice (CPC)' };
  }

  const programme: Programme = {
    id: String(id),
    name,
    network: SLUG,
    status,
    currency: DEFAULT_CURRENCY,
    rawNetworkData: row,
  };
  if (commissionRate !== undefined) programme.commissionRate = commissionRate;
  if (advertiserUrl !== undefined) programme.advertiserUrl = advertiserUrl;
  // The campaign description is preserved verbatim in rawNetworkData; it is not a
  // category, so we deliberately do not populate `categories` from it.
  void description;
  return programme;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AfilioAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes — Campaign Description API
  // -------------------------------------------------------------------------

  /**
   * List the campaigns (programmes) visible to the affiliate via the Campaign
   * Description API. Supports client-side `search`, `status`, and `limit`
   * filtering; Afilio does not document server-side filters for this endpoint.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const token = requireToken('listProgrammes');
    const affid = requireAffId('listProgrammes');

    const xml = await afilioRequest({
      operation: 'listProgrammes',
      path: AFILIO_CAMPAIGN_PATH,
      query: { token, affid, format: 'XML' },
      resilience: RESILIENCE.default,
    });

    const rows = parseAfilioXmlRows(xml, ['campaign', 'campanha', 'program', 'programa', 'record', 'item', 'row']);
    let programmes = rows.map((r) => toProgramme(r));

    programmes = this.applyProgrammeFilters(programmes, query);

    log.debug({ count: programmes.length }, 'listProgrammes complete');
    return programmes;
  }

  private applyProgrammeFilters(programmes: Programme[], query?: ProgrammeQuery): Programme[] {
    let out = programmes;
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      out = out.filter((p) => wanted.has(p.status));
    }
    if (query?.search) {
      const needle = query.search.toLowerCase();
      out = out.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (typeof query?.limit === 'number') {
      out = out.slice(0, query.limit);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Look up a single campaign by id. Afilio does not document a single-campaign
   * endpoint, so we fetch the Campaign Description list and filter client-side.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    if (!programmeId) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: 'programmeId is required.',
          hint: 'Pass the Afilio campaign id.',
        }),
      );
    }
    const all = await this.listProgrammes();
    const found = all.find((p) => p.id === String(programmeId));
    if (!found) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'network_api_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Afilio campaign ${programmeId} was not found in the Campaign Description list.`,
          hint: 'Confirm the campaign id and that your account can see the campaign.',
        }),
      );
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // listTransactions — Sales & Leads API
  // -------------------------------------------------------------------------

  /**
   * List Afilio transactions across a date window. Afilio splits sales and leads
   * into two calls (`type=sale` and `type=lead`); we fetch both and merge so the
   * affiliate sees a single transaction stream. Optional status / age / programme
   * filters are applied client-side after normalisation.
   *
   * The API takes `dateStart`/`dateEnd` as `YYYY-MM-DD`. No maximum window is
   * documented; we default to a 30-day window when none is supplied.
   * BLOCKED(verify): confirm whether a server-side window cap exists.
   *
   * PRD §15.9: `minAgeDays`/`maxAgeDays` filter on the computed `ageDays`.
   * PRD §15.10: cancelled/charged-back sales normalise to 'reversed' with reason.
   */
  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    const token = requireToken('listTransactions');
    const affid = requireAffId('listTransactions');
    const now = new Date();

    const to = query?.to ? new Date(query.to) : now;
    const from = query?.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const dateStart = from.toISOString().slice(0, 10);
    const dateEnd = to.toISOString().slice(0, 10);

    const fetchType = async (type: 'sale' | 'lead'): Promise<Transaction[]> => {
      const xml = await afilioRequest({
        operation: 'listTransactions',
        path: AFILIO_LEADSALE_PATH,
        query: { mode: 'list', token, affid, type, dateStart, dateEnd, format: 'XML' },
        resilience: RESILIENCE.listTransactions ?? RESILIENCE.default,
      });
      const rows = parseAfilioXmlRows(xml, [type, 'sale', 'lead', 'record', 'item', 'row', 'transaction']);
      return rows.map((r) => toTransaction(r, type, now));
    };

    const [sales, leads] = await Promise.all([fetchType('sale'), fetchType('lead')]);
    let transactions = [...sales, ...leads];

    // Status filter (client-side; the Sales/Leads API does not document a
    // server-side status parameter).
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      transactions = transactions.filter((t) => wanted.has(t.status));
    }

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

    log.debug({ count: transactions.length }, 'listTransactions complete');
    return transactions;
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary — derived from listTransactions
  // -------------------------------------------------------------------------

  /**
   * Aggregate transactions into an earnings summary.
   *
   * Derived from `listTransactions` (one source of truth; the affiliate can
   * recompute the summary from the transactions they see). Do NOT pass
   * `query.limit` through — a limited summary undercounts (principle 4.1).
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
          programmeName: t.programmeName || `Afilio campaign ${key}`,
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
      currency: firstCurrency ?? DEFAULT_CURRENCY,
      byProgramme: [...byProgrammeMap.values()],
      byStatus,
      oldestUnpaidAgeDays,
      periodFrom: from,
      periodTo: to,
    };
  }

  // -------------------------------------------------------------------------
  // listClicks — not exposed
  // -------------------------------------------------------------------------

  /**
   * Afilio does not expose click-level data to affiliates via a documented API.
   * We throw NotImplementedError rather than returning an empty array — the
   * difference between "no clicks in the period" and "clicks not exposed" is
   * principle 4.1.
   */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'Afilio does not expose click-level data to affiliates via a documented API.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink — not implemented
  // -------------------------------------------------------------------------

  /**
   * Afilio deeplinks are generated inside the affiliate dashboard. There is no
   * documented deterministic format that can be constructed from a campaign id
   * and the Aff ID alone (links embed per-affiliate, per-creative tracking the
   * affiliate API does not return), so we throw NotImplementedError rather than
   * emit a guessed URL that would silently fail to track.
   */
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(
      'Afilio does not document a deterministic affiliate tracking-link format constructible from a campaign id and Aff ID; ' +
        'deeplinks are generated in the Afilio dashboard. See META.knownLimitations.',
    );
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Verify credentials with one cheap Sales API call. Never throws — verifyAuth
   * is called by error handlers.
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
   * Probe each operation with a minimal call. listClicks and generateTrackingLink
   * are known-unsupported and recorded without probing.
   */
  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        const sampleSize = Array.isArray(result) ? result.length : 1;
        operations[name] = { supported: true, latencyMs: Date.now() - start, sampleSize };
      } catch (err) {
        operations[name] = {
          supported: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    // Known-unsupported ops — record without probing.
    operations['listClicks'] = {
      supported: false,
      note: 'Afilio does not expose click-level data to affiliates via a documented API.',
    };
    operations['generateTrackingLink'] = {
      supported: false,
      note: 'Afilio deeplinks are generated in the dashboard; no deterministic affiliate-side format is documented.',
    };

    await probe('verifyAuth', () => this.verifyAuth());
    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
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

export const afilioAdapter = new AfilioAdapter();
registerAdapter(afilioAdapter);

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
  toAmount,
  nullableIso,
  pick,
};

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
