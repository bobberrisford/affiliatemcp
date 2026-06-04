/**
 * Monetizze HTTP client — the ONLY path Monetizze adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Monetizze API surface (Open API 2.1) -------------------------------------
 *
 * Base URL: https://api.monetizze.com.br/2.1
 *   Confirmed from: the help-centre integration guide
 *   (https://help.monetizze.com.br/books/integracoes/page/api-monetizze),
 *   the community SDK skaisser/monetizze (https://github.com/skaisser/monetizze),
 *   and the official callback example repo issue thread
 *   (https://github.com/Monetizze/ExemploPOSTCallback/issues/18).
 *
 * Authentication (two-step):
 *   1. POST /token
 *        Header: x_consumer_key: <API access key created in the Monetizze panel
 *                                 via Ferramentas > API>
 *        → returns an account token.
 *      Requests with no key receive HTTP 403 "Credenciais de API não fornecidas"
 *      (observed in issue #18 above).
 *   2. Data requests send the token in the `token` header.
 *      Header names verbatim: `x_consumer_key` (token exchange) and `token`
 *      (authenticated data calls) per the skaisser/monetizze SDK.
 *
 * Sales / commissions (the reporting endpoint this adapter relies on):
 *   GET /transactions
 *     [?transaction=<id>]            single sale lookup
 *     [?email=<buyer email>]         filter by buyer
 *     [?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&status=<n>]  advanced filter
 *   Each sale carries a `comissoes[]` array with the affiliate commission rows
 *   (refAfiliado, nome, tipo_comissao, valor, comissao, email) and a `produto`
 *   object (codigo, nome, categoria, chave). Status codes (callback example
 *   repo): 1 Aguardando pagamento, 2 Finalizada, 3 Cancelada, 4 Devolvida,
 *   5 Bloqueada, 6 Completa, 7 Abandono de Checkout.
 *   BLOCKED(verify): the exact query-parameter names for the advanced date/status
 *   filter could not be confirmed against the live interactive docs
 *   (https://api.monetizze.com.br/2.1/apidoc/ is JS-rendered and returned 403 to
 *   automated fetches). The adapter sends `dataInicio`/`dataFim` (the field names
 *   used in the callback payload) and filters defensively client-side as well.
 *
 * Products / programmes (listProgrammes / getProgramme):
 *   The help-centre states the API exposes product data, but no specific
 *   product-listing path or response shape could be confirmed from public
 *   sources. BLOCKED(verify): listProgrammes / getProgramme throw
 *   NotImplementedError rather than calling an invented endpoint.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('monetizze.client');

/**
 * The Monetizze Open API 2.1 base URL.
 * Source: https://help.monetizze.com.br/books/integracoes/page/api-monetizze
 *         https://github.com/Monetizze/ExemploPOSTCallback/issues/18
 */
export const MONETIZZE_BASE_URL = 'https://api.monetizze.com.br/2.1';

/** Header carrying the API access key, used only for the token exchange. */
export const MONETIZZE_KEY_HEADER = 'x_consumer_key';

/** Header carrying the account token, used for authenticated data calls. */
export const MONETIZZE_TOKEN_HEADER = 'token';

export interface MonetizzeRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Account token from the token exchange. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Monetizze API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Monetizze's documented field
 * names can vary across API versions. Treating every field as possibly absent
 * and preserving `rawNetworkData` is more robust than a schema that breaks on
 * drift.
 */
export async function monetizzeRequest<T>(input: MonetizzeRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'monetizze', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(MONETIZZE_BASE_URL, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.token, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'monetizze request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Monetizze ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'monetizze',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Monetizze ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Exchange the API access key for an account token.
 *
 * POST https://api.monetizze.com.br/2.1/token
 *   Header: x_consumer_key: <API access key>
 *   Response shape: an object carrying a token field. The exact field name is
 *   recorded defensively (`token` / `chave` / `access_token`) because the live
 *   interactive docs could not be fetched to confirm it. BLOCKED(verify).
 *
 * This function is called only from auth.ts (the token cache). Adapter
 * operations use the cached token via `getToken()`.
 */
export async function fetchToken(
  apiKey: string,
  resilience: ResilienceConfig,
): Promise<{ token: string; raw: unknown }> {
  const ctx: WithResilienceContext = { network: 'monetizze', operation: 'fetchToken' };

  return withResilience(
    ctx,
    async () => {
      const res = await fetch(`${MONETIZZE_BASE_URL}/token`, {
        method: 'POST',
        headers: {
          [MONETIZZE_KEY_HEADER]: apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(res.status, rawBody, `Monetizze token exchange → HTTP ${res.status}`);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'monetizze',
            operation: 'fetchToken',
            networkErrorBody: rawBody,
            message: 'Monetizze token endpoint returned a non-JSON body.',
            hint: 'Check MONETIZZE_API_KEY is the access key created via Ferramentas > API.',
          }),
        );
      }

      // The token field name is unconfirmed against live docs; read the common
      // candidates defensively. BLOCKED(verify).
      const token =
        firstString(parsed['token']) ??
        firstString(parsed['chave']) ??
        firstString(parsed['access_token']) ??
        firstString((parsed['data'] as Record<string, unknown> | undefined)?.['token']);

      if (!token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'monetizze',
            operation: 'fetchToken',
            networkErrorBody: rawBody,
            message: 'Monetizze token endpoint returned a response with no recognisable token field.',
            hint: 'Verify MONETIZZE_API_KEY is correct (created via Ferramentas > API in the Monetizze panel).',
          }),
        );
      }

      log.debug('monetizze token fetched');
      return { token, raw: parsed };
    },
    resilience,
  );
}

function firstString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    [MONETIZZE_TOKEN_HEADER]: token,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  // base includes a path prefix (/2.1); join carefully so the prefix survives.
  const normalisedBase = base.endsWith('/') ? base : `${base}/`;
  const normalisedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const url = new URL(normalisedPath, normalisedBase);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
