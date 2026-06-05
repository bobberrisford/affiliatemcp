/**
 * FirstPromoter REST API (v2) HTTP client — the ONLY path this adapter uses for
 * network I/O. Structurally a copy of `src/networks/awin/client.ts` and
 * `src/networks/rewardful/client.ts`; read those for the rationale behind the
 * hard rules.
 *
 * --- FirstPromoter REST API surface (verify against ------------------------
 *     https://docs.firstpromoter.com/api-reference-v2/api-admin/introduction) -
 *
 *   Host:    https://api.firstpromoter.com
 *   Prefix:  /api/v2/company   (the admin / merchant surface)
 *   Auth:    two headers on every request —
 *              Authorization: Bearer {FIRSTPROMOTER_API_KEY}
 *              ACCOUNT-ID:    {FIRSTPROMOTER_ACCOUNT_ID}
 *   Paging:  header-driven — the response carries a `Link` header with a
 *            `rel="next"` URL when more pages exist. The client reads the next
 *            page's URL out of that header. List endpoints return a bare JSON
 *            array (no body-level pagination envelope).
 *   Dates:   ISO 8601. Monetary amounts are integer minor units (cents) —
 *            TODO(verify) against a live account.
 *   Limits:  documented rate limit → HTTP 429 (the resilience layer retries 429).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('firstpromoter.client');

export const FIRSTPROMOTER_BASE_URL = 'https://api.firstpromoter.com';
export const FIRSTPROMOTER_PATH_PREFIX = '/api/v2/company';
export const SLUG = 'firstpromoter';

export interface FirstPromoterRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/api/v2/company` prefix (e.g. `/referrals`). */
  path: string;
  /** FirstPromoter API key — sent as the Bearer token. */
  apiKey: string;
  /** FirstPromoter account id — sent as the `ACCOUNT-ID` header. */
  accountId: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export interface FirstPromoterResponse<T> {
  body: T;
  /** The `rel="next"` URL parsed from the `Link` header, if present. */
  nextUrl?: string;
}

/**
 * Issue a single request and return both the parsed body and the parsed
 * `rel="next"` link. The adapter loops on `nextUrl` to follow pagination.
 *
 * `input.path` may be an absolute URL (the `nextUrl` from a previous page); in
 * that case it is used verbatim rather than prefixed with `/api/v2/company`.
 */
export async function firstPromoterRequest<T>(
  input: FirstPromoterRequestInput,
): Promise<FirstPromoterResponse<T>> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = input.path.startsWith('http')
        ? input.path
        : buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiKey, input.accountId, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'firstpromoter request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `FirstPromoter ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      const nextUrl = parseNextLink(res.headers.get('link'));

      if (rawBody.trim() === '') {
        return { body: {} as T, nextUrl };
      }

      try {
        return { body: JSON.parse(rawBody) as T, nextUrl };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `FirstPromoter ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * FirstPromoter v2 auth: a Bearer token plus a separate `ACCOUNT-ID` header
 * naming the account the key belongs to. Both are required on every request.
 */
function buildHeaders(
  apiKey: string,
  accountId: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'ACCOUNT-ID': accountId,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${FIRSTPROMOTER_PATH_PREFIX}${rel}`, FIRSTPROMOTER_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Parse a `Link` header for the `rel="next"` URL. FirstPromoter v2 paginates
 * via this header (RFC 5988 / RFC 8288) rather than a body envelope. Returns
 * `undefined` when there is no next page.
 */
export function parseNextLink(linkHeader: string | null | undefined): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part.trim());
    if (match && match[1]) return match[1];
  }
  return undefined;
}

export { HttpStatusError };
