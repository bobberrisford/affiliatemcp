/**
 * Lomadee HTTP client — the ONLY path Lomadee adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, response parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - Lomadee exposes several distinct request shapes (JSON offers API, an XML
 *     sales-report API, a deeplink API). Centralising them here keeps the adapter
 *     free of transport detail.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Lomadee API surface (verified against public documentation, 2026-06-04) ----
 *
 * Auth model: `custom`. Lomadee identifies the caller with an app-token plus a
 * sourceId, both carried in the request URL (path / query) rather than an
 * Authorization header. The app-token is self-serve from the affiliate panel:
 * "Credenciais de API" → "Gerar Token".
 *   Source: https://developer.socialsoul.com.vc/lab/tutoriais/afiliados/pra-que-serve-o-app-token-e-como-criar.html
 *           https://developer.lomadee.com/
 *
 * Offers API (base: https://api.lomadee.com):
 *   GET /v3/{appToken}/offer/_search?keyword={kw}&sourceId={sourceId}&page={n}
 *   GET /v3/{appToken}/offer/_bestsellers?sourceId={sourceId}
 *   Response JSON: { offers: [{ id, name, link, price, store: { id, name },
 *                    category: { id, name }, ... }], pagination: {...} }
 *   Used by listProgrammes / getProgramme to surface the merchant stores the
 *   publisher can promote.
 *   Source: https://developer.socialsoul.com.vc/afiliados/ofertas/v1/
 *           https://github.com/lomadee/api-v2-jsclient (offer/_search, offer/_bestsellers)
 *
 * Deeplink API (base: https://api.lomadee.com):
 *   GET /service/createLinks/lomadee/{appToken}/?sourceId={sourceId}&link1={url}
 *   Response JSON: { status: { code }, links: [{ id, link, redirectLink, originalLink }] }
 *   "Lomadeezar" any advertiser URL into a trackable affiliate link.
 *   Source: https://developer.socialsoul.com.vc/afiliados/deeplink/
 *           Live createLinks pattern: .../service/createLinks/lomadee/{appId}/?sourceId=...&link1=...
 *
 * Reports API — "Consulte suas vendas" (base: https://api.lomadee.com):
 *   GET /api/lomadee/createToken/?user={email}&password={password}
 *     → { status, token, message }  (a report-scoped token, distinct from the app-token)
 *   GET /api/lomadee/reportTransaction?publisherId={publisherId}&token={token}
 *     → XML document listing the consultant's sales (period up to 90 days from start).
 *   Source: https://developer.socialsoul.com.vc/afiliados/relatorios/recursos/consulte-suas-vendas/
 *   BLOCKED(verify): the exact XML element/attribute names of reportTransaction are
 *   not published in any indexable source. The XML parser below is defensive and the
 *   verbatim document is preserved on every transaction's rawNetworkData. Live-account
 *   verification is required before promoting claim_status beyond 'experimental'.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('lomadee.client');

const NETWORK = 'lomadee';

/**
 * The single production base URL for every Lomadee API used by this adapter
 * (offers, deeplink, reports). Verified from the developer documentation and
 * community SDKs.
 * Source: https://developer.lomadee.com/
 */
export const LOMADEE_BASE_URL = 'https://api.lomadee.com';

export interface LomadeeJsonRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  method?: 'GET' | 'POST';
  /** Query string parameters. Values that are `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

export interface LomadeeTextRequestInput extends LomadeeJsonRequestInput {
  /** Accept header to advertise. Defaults to XML, which the report API returns. */
  accept?: string;
}

/**
 * Issue a single Lomadee JSON request under the resilience policy (offers,
 * deeplink). Lomadee carries auth in the URL, so there is no Authorization
 * header to build.
 */
export async function lomadeeJsonRequest<T>(input: LomadeeJsonRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: NETWORK, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(LOMADEE_BASE_URL, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: { Accept: 'application/json' },
      };
      if (input.signal) init.signal = input.signal;

      log.debug({ url, method: init.method, operation: input.operation }, 'lomadee json request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Lomadee ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: NETWORK,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Lomadee ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Issue a single Lomadee request whose response is plain text / XML (the sales
 * report). Returns the verbatim body string; parsing into domain records happens
 * in the adapter where the upstream shape is preserved on `rawNetworkData`.
 */
export async function lomadeeTextRequest(input: LomadeeTextRequestInput): Promise<string> {
  const ctx: WithResilienceContext = { network: NETWORK, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(LOMADEE_BASE_URL, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: { Accept: input.accept ?? 'application/xml, text/xml, */*' },
      };
      if (input.signal) init.signal = input.signal;

      log.debug({ url, method: init.method, operation: input.operation }, 'lomadee text request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Lomadee ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      return rawBody;
    },
    input.resilience,
  );
}

function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
