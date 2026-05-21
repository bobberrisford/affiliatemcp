/**
 * CJ Affiliate HTTP client — the ONLY path CJ adapter methods use for I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - CJ exposes a GraphQL + REST hybrid surface. Keeping URL/header
 *     construction, body shaping, and the resilience-layer wrapping in one
 *     place means adapter methods stay focused on "what the operation means",
 *     not "what shape the HTTP wire looks like".
 *   - The resilience policy (timeout, retries, circuit breaker — see
 *     `src/shared/resilience.ts`) is sanctioned to wrap any callable. We
 *     funnel every CJ call through `withResilience` so the policy is applied
 *     once, uniformly, with no chance of an adapter method bypassing it.
 *   - Hard rule (PRD §15.4 / principle 4.1): on any non-2xx, throw
 *     `HttpStatusError(status, rawBody, message)` so the verbatim CJ response
 *     body reaches the error envelope. Never paraphrase.
 *
 * --- CJ API surface map (verify against https://developers.cj.com/) ---------
 *
 *   GraphQL (Publisher Commissions):    https://commissions.api.cj.com/query
 *     - publisherCommissions(...)        transactions / commissions
 *     - me { id companyId ... }          identity + companyId discovery
 *
 *   GraphQL (Advertiser Lookup):        https://ads.api.cj.com/query
 *     - advertisers(...)                 list / search advertisers (programmes)
 *     - advertiser(advertiserId: ...)    single advertiser detail
 *
 *   REST (Link Builder):                https://link-builder.api.cj.com/v1/links
 *     - POST /v1/links                   mint a deep link
 *
 *   Legacy click-redirect URL pattern:  https://www.dpbolvw.net/click-{pid}-{aid}
 *     - Deterministic; no API call needed.
 *
 * --- Why three endpoints, one client ----------------------------------------
 *
 * CJ's modern surface is GraphQL but the two GraphQL endpoints have different
 * schemas (commissions vs advertisers) and the link-builder is REST. Rather
 * than three clients, we provide:
 *
 *   - `cjGraphQL<T>({ endpoint, query, variables, ... })` — handles both
 *     GraphQL endpoints; caller picks which one via the `endpoint` field.
 *   - `cjRest<T>({ baseUrl, path, method, body, ... })` — REST calls
 *     (link-builder, legacy report endpoints if reachable).
 *
 * Both go through `withResilience`. Both throw `HttpStatusError` on non-2xx.
 *
 * GraphQL bears one extra subtlety: CJ may return HTTP 200 with an `errors`
 * array in the JSON body (the standard GraphQL convention). We surface that
 * as an `HttpStatusError(200, body, ...)` so the verbatim body still reaches
 * the envelope — the user gets to see CJ's actual error message, not a
 * sanitised "the call failed".
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('cj.client');

/**
 * CJ's GraphQL endpoints.
 *
 * The two endpoints have separate schemas. Adapter methods pass the one they
 * need explicitly so that swapping endpoints (or pointing at a CJ staging
 * environment in future) is a single-field change rather than a string match
 * inside the client.
 */
export const CJ_GRAPHQL_COMMISSIONS = 'https://commissions.api.cj.com/query';
export const CJ_GRAPHQL_ADS = 'https://ads.api.cj.com/query';

/** REST base for the link-builder. */
export const CJ_REST_LINK_BUILDER = 'https://link-builder.api.cj.com';

/**
 * The canonical CJ API hostname that we record in `network.json`. Documenting
 * one canonical host keeps the manifest schema simple — individual endpoints
 * live here.
 */
export const CJ_BASE_URL = 'https://api.cj.com';

export interface CjGraphQLInput {
  /** The canonical operation name. Used as the breaker key and on error envelopes. */
  operation: AnyOperation;
  /** Which GraphQL endpoint to hit. */
  endpoint: typeof CJ_GRAPHQL_COMMISSIONS | typeof CJ_GRAPHQL_ADS;
  /** GraphQL query / mutation document. */
  query: string;
  /** Variables for the query. */
  variables?: Record<string, unknown>;
  /** Personal Access Token. */
  token: string;
  /** Resilience knobs for this specific call. Per-op profile lives in adapter.ts. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

export interface CjRestInput {
  /** The canonical operation name. */
  operation: AnyOperation;
  /** Full base URL (e.g. CJ_REST_LINK_BUILDER) — paths are joined relative. */
  baseUrl: string;
  /** Path beginning with `/`. */
  path: string;
  /** HTTP method. Defaults to GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. `undefined` values skipped. */
  query?: Record<string, string | number | undefined>;
  /** JSON body for POST/PUT. */
  body?: unknown;
  /** Personal Access Token. */
  token: string;
  /** Resilience config. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal`. */
  signal?: AbortSignal;
}

/**
 * Standard GraphQL response envelope. CJ may return `data` with `null` fields
 * AND populated `errors` — the GraphQL spec permits this. We treat any
 * non-empty `errors` array as a failure even when `data` is partially present,
 * because partial data without a way to know "what's missing" is a footgun.
 */
interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string; path?: unknown; extensions?: unknown }>;
}

/**
 * Issue a GraphQL request through the resilience layer.
 *
 * Why we read the body once: we need it twice — JSON-decode on success, and
 * surface verbatim on failure. Reading once also avoids the rare-but-real bug
 * where `res.text()` and `res.json()` race on streamed responses.
 *
 * Why we synthesise an `HttpStatusError(200, body, ...)` on GraphQL errors:
 * the resilience layer's retry policy keys off HTTP status. A 200-with-errors
 * is conceptually a failure but the policy is "never retry 4xx except 429";
 * a synthesised 200 falls through to "no retry" which is correct — repeating
 * a malformed query gets the same error.
 */
export async function cjGraphQL<T>(input: CjGraphQLInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'cj', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const init: RequestInit = {
        method: 'POST',
        headers: buildHeaders(input.token, true),
        body: JSON.stringify({
          query: input.query,
          variables: input.variables ?? {},
        }),
      };
      if (input.signal) init.signal = input.signal;

      log.debug(
        { endpoint: input.endpoint, operation: input.operation },
        'cj graphql request',
      );

      const res = await fetch(input.endpoint, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `CJ ${input.operation} POST ${input.endpoint} → HTTP ${res.status}`,
        );
      }

      // Parse the GraphQL envelope. We don't trust the body to be JSON even
      // on a 200 — CJ has occasionally responded with an HTML maintenance
      // page through their CDN. Surface that verbatim.
      let envelope: GraphQLEnvelope<T>;
      try {
        envelope = JSON.parse(rawBody) as GraphQLEnvelope<T>;
      } catch (err) {
        // Polish (Chunk 10): emit a NetworkError preserving the verbatim body
        // (PRD §4.1) rather than collapsing into a generic Error string.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'cj',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CJ ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }

      if (envelope.errors && envelope.errors.length > 0) {
        // PRD principle 4.1: keep the verbatim body. The user sees the actual
        // CJ error message, not a paraphrase. We synthesise status 200 — the
        // HTTP request *did* succeed; the failure is GraphQL-level.
        throw new HttpStatusError(
          200,
          rawBody,
          `CJ ${input.operation} GraphQL errors: ${envelope.errors
            .map((e) => e.message ?? '(no message)')
            .join('; ')}`,
        );
      }

      if (envelope.data === undefined) {
        // Polish (Chunk 10): a 200 with neither `data` nor `errors` is malformed
        // by spec; emit a NetworkError with the verbatim body (PRD §4.1) rather
        // than a generic Error.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'cj',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CJ ${input.operation} returned a GraphQL envelope with no data and no errors.`,
          }),
        );
      }

      return envelope.data;
    },
    input.resilience,
  );
}

/**
 * Issue a REST request through the resilience layer.
 *
 * Used for the link-builder endpoint and any future REST-only CJ surface
 * (legacy report endpoints for click data, if we reach them).
 */
export async function cjRest<T>(input: CjRestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'cj', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.baseUrl, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.token, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) init.signal = input.signal;

      log.debug({ url, method: init.method, operation: input.operation }, 'cj rest request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `CJ ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // Polish (Chunk 10): preserve verbatim networkErrorBody via NetworkError.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'cj',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CJ ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build Authorization + content headers. CJ uses Bearer auth with the PAT.
 */
function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose a REST URL with query string. URLSearchParams handles encoding for
 * any awkward characters (CJ's REST query values are tame in practice, but
 * we use the same hygiene as the Awin client for consistency).
 */
function buildUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw / catch HttpStatusError without reaching
// into shared/resilience directly. The boundary stays clean: everything
// network-shaped goes through ./client.
export { HttpStatusError };
