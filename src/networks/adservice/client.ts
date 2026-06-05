/**
 * Adservice HTTP client — the ONLY path Adservice adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, cookie
 *     header building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Adservice API surface (built from public documentation) -------------------
 *
 * Adservice is a Nordic publisher-side affiliate network (now part of the merged
 * Adtraction/Adservice group). Its first-party publisher API documentation lives
 * at https://publisher.adservice.com/doc/publisher/API/ (the index titles itself
 * "Adtraction Platform" since the merger).
 *
 * Base URL:
 *   https://api.adservice.com/cgi-bin/publisher/API/
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *           (documented endpoint: .../Statistics.pl/)
 *
 * Authentication (auth_model: custom):
 *   Two values, `UID` (the publisher/client ID) and `LoginToken`, must be supplied
 *   as COOKIES on every request. They are obtained via /Account.pl/loginToken.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *           https://www.perameter.com/docs/adservice-password-authentication-api
 *
 *   BLOCKED(verify): the exact request/response shape of /Account.pl/loginToken
 *   (whether it is a username/password POST that mints the token, or whether the
 *   publisher copies a long-lived UID + LoginToken pair directly from the account)
 *   could not be confirmed from the accessible public docs — the documentation
 *   host returns HTTP 403 to automated fetches. This adapter takes UID and
 *   LoginToken as configured credentials and sends them as cookies; the login
 *   exchange itself is treated as out of scope until a live account confirms it.
 *
 * Reporting endpoint (GET):
 *   GET .../Statistics.pl/
 *     ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
 *     [&camp_id=N][&country_id=N]
 *     [&group_by=camp_title|banner_id|agent_id|year|monthyear|weekyear|stamp|medianame|sub]
 *     [&showPending=1|0][&period=day|month][&currency=SEK|NOK|EUR|...][&limit=N]
 *   Returns AGGREGATE statistics (impressions, clicks, leads, earnings, pending
 *   conversions) grouped by the requested dimension — NOT row-level conversions
 *   or individual click events.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *
 * Campaign/programme endpoint:
 *   GET .../Campaigns.pl/ — campaign (programme) listing.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Campaigns_pl.html
 *   BLOCKED(verify): exact path, parameters, and response fields not confirmed.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adservice.client');

const SLUG = 'adservice';

/**
 * The Adservice publisher API base URL.
 * Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *         (documented endpoint api.adservice.com/cgi-bin/publisher/API/Statistics.pl/)
 */
export const ADSERVICE_BASE_URL = 'https://api.adservice.com/cgi-bin/publisher/API';

/** Documented reporting endpoint. */
export const STATISTICS_PATH = '/Statistics.pl/';

/**
 * Documented campaign (programme) listing endpoint.
 * BLOCKED(verify): exact path and response shape not confirmed against a live account.
 */
export const CAMPAIGNS_PATH = '/Campaigns.pl/';

export interface AdserviceCredentials {
  /** The publisher/client ID — sent as the `UID` cookie. */
  uid: string;
  /** The login token — sent as the `LoginToken` cookie. */
  loginToken: string;
}

export interface AdserviceRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** UID + LoginToken sent as cookies on the request. */
  credentials: AdserviceCredentials;
  method?: 'GET' | 'POST';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL (tests). */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Adservice API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: the public docs describe the
 * statistics dimensions but the exact field set is not confirmable from the
 * accessible documentation. Treating every field as possibly absent and
 * preserving `rawNetworkData` is more robust than a schema that breaks on drift.
 */
export async function adserviceRequest<T>(input: AdserviceRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? ADSERVICE_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.credentials),
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'adservice request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Adservice ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Adservice ${input.operation} returned HTTP ${res.status} with a non-JSON body (parse error: ${(err as Error).message})`,
            hint: 'The Adservice API returned a body that is not JSON. Check that UID and LoginToken are valid; an HTML login page is returned when the session is rejected.',
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Cookie header carrying UID + LoginToken.
 *
 * Adservice documents that both values must be supplied as cookies on every
 * request (Source: Statistics.pl docs). We do not send them as query params to
 * avoid leaking the LoginToken into URL logs.
 */
function buildHeaders(credentials: AdserviceCredentials): Record<string, string> {
  const cookie = `UID=${encodeURIComponent(credentials.uid)}; LoginToken=${encodeURIComponent(
    credentials.loginToken,
  )}`;
  return {
    Accept: 'application/json',
    Cookie: cookie,
  };
}

function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  // base already ends without a trailing slash; pathname begins with `/`.
  const joined = `${base.replace(/\/$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const url = new URL(joined);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
