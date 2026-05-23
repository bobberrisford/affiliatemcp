/**
 * CJ Affiliate advertiser HTTP client — the ONLY path adapter methods use for I/O.
 *
 * READ-ONLY at v0.1. CJ does publish a small number of advertiser-side
 * mutations (commission status overrides, action approvals) but those are
 * NOT in scope for this adapter. The client enforces this at two layers:
 *
 *   1. The HTTP method is hard-coded `POST` (GraphQL is always POST) but the
 *      GraphQL document is parsed before the request goes out: if the
 *      outbound query contains a `mutation` or `subscription` operation, the
 *      client throws a `config_error` envelope and never touches the wire.
 *
 *   2. The query strings live in `./queries.ts` and are exported as constants;
 *      a future contributor cannot accidentally ship a write by editing the
 *      adapter alone.
 *
 * The brand-side surface is much more sensitive than the publisher side (you
 * can move money on it, in principle), so defence-in-depth matters here.
 *
 * Mirror of the publisher CJ client (`src/networks/cj/client.ts`):
 *   - Bearer-PAT auth via `Authorization: Bearer <token>`.
 *   - Every call funnelled through `withResilience` so timeout/retry/circuit
 *     policy applies once, uniformly.
 *   - On non-2xx, throw `HttpStatusError(status, rawBody, ...)` so the
 *     verbatim CJ response body reaches the error envelope (PRD §15.4 / 4.1).
 *   - On 200-with-`errors`, surface as `HttpStatusError(200, body, ...)` so
 *     the upstream GraphQL message is preserved verbatim.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { bearerAuthHeader, SLUG } from './auth.js';

const log = createLogger('cj-advertiser.client');

/** The single GraphQL endpoint for the CJ advertiser surface. */
export const CJ_ADVERTISER_GRAPHQL = 'https://commissions.api.cj.com/query';

/** Canonical base URL recorded in `network.json`. */
export const CJ_ADVERTISER_BASE_URL = 'https://commissions.api.cj.com';

export interface CjAdvGraphQLInput {
  /** The canonical operation name. Used as the breaker key and on error envelopes. */
  operation: AnyOperation;
  /** Endpoint (currently always `CJ_ADVERTISER_GRAPHQL` — kept explicit for parity with `src/networks/cj`). */
  endpoint: string;
  /** GraphQL query document. MUST start with `query` (mutation / subscription rejected). */
  query: string;
  /** Variables for the query. */
  variables?: Record<string, unknown>;
  /** Personal Access Token. */
  token: string;
  /** Resilience knobs. Per-op profile lives in adapter.ts. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Standard GraphQL response envelope. CJ may return 200 with `errors` populated.
 */
interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string; path?: unknown; extensions?: unknown }>;
}

/**
 * The read-only guard.
 *
 * Strategy: strip GraphQL comments and string literals, then look at the
 * first non-whitespace operation keyword. If it's not `query`, refuse.
 *
 * We deliberately do NOT do a full GraphQL parse here — the goal is a robust
 * pattern match that catches every realistic write attempt without pulling
 * `graphql-js` into the dependency tree. The trade-off: a pathological string
 * literal that contained the word "mutation" used to fool a naive regex; this
 * implementation strips strings first, so that vector is closed.
 *
 * Exported for unit testing.
 */
export function assertReadOnlyQuery(query: string, operation: string): void {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: 'CJ advertiser client received an empty GraphQL document.',
      }),
    );
  }

  // Strip line comments (#...) and string literals so neither can disguise a
  // mutation/subscription keyword.
  const stripped = query
    // Remove triple-quoted block strings.
    .replace(/"""[\s\S]*?"""/g, '""')
    // Remove single-quoted strings.
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    // Remove # line comments to end of line.
    .replace(/#[^\n]*/g, '');

  // Scan every operation definition in the document. GraphQL permits multiple
  // operations in one document; we require every one to be a `query`.
  // The keyword appears at the start of an operation definition, optionally
  // followed by a name and a variable definitions block. We match
  // `mutation`/`subscription` anywhere they appear as a standalone token.
  const writeKeyword = /\b(mutation|subscription)\b/i;
  const m = writeKeyword.exec(stripped);
  if (m) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `CJ advertiser adapter is read-only at v0.1; refusing GraphQL ${(m[1] ?? 'write').toLowerCase()} operation.`,
        hint:
          'This adapter only issues GraphQL `query` operations. To enable writes a future PR must ' +
          'lift this guard explicitly AND the operator must understand the brand-side surface that ' +
          'they are exposing.',
      }),
    );
  }

  // Defensively confirm at least one `query` keyword (or a shorthand `{` for
  // unnamed query, which GraphQL permits). If we see neither, reject —
  // unrecognised top-level constructs are not safe to send.
  const looksLikeQuery = /\bquery\b/i.test(stripped) || /^\s*\{/.test(stripped);
  if (!looksLikeQuery) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message:
          'CJ advertiser client could not identify the GraphQL document as a query operation.',
        hint:
          'All cj-advertiser GraphQL documents must begin with `query` (named or anonymous). ' +
          'Mutations and subscriptions are not permitted.',
      }),
    );
  }
}

/**
 * Issue a GraphQL request through the resilience layer.
 *
 * Walks the same path as `src/networks/cj/client.ts.cjGraphQL`: read the body
 * once, JSON-decode on success, surface verbatim on failure.
 */
export async function cjAdvGraphQL<T>(input: CjAdvGraphQLInput): Promise<T> {
  // Hard read-only guard. Runs BEFORE any wire I/O so a mis-edited query
  // never reaches CJ. This is the defence-in-depth referenced in the
  // adapter's network.json `known_limitations`.
  assertReadOnlyQuery(input.query, input.operation);

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: bearerAuthHeader(input.token),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables ?? {},
        }),
      };
      if (input.signal) init.signal = input.signal;

      log.debug(
        { endpoint: input.endpoint, operation: input.operation },
        'cj-advertiser graphql request',
      );

      const res = await fetch(input.endpoint, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `CJ advertiser ${input.operation} POST ${input.endpoint} → HTTP ${res.status}`,
        );
      }

      let envelope: GraphQLEnvelope<T>;
      try {
        envelope = JSON.parse(rawBody) as GraphQLEnvelope<T>;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CJ advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }

      if (envelope.errors && envelope.errors.length > 0) {
        throw new HttpStatusError(
          200,
          rawBody,
          `CJ advertiser ${input.operation} GraphQL errors: ${envelope.errors
            .map((e) => e.message ?? '(no message)')
            .join('; ')}`,
        );
      }

      if (envelope.data === undefined) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CJ advertiser ${input.operation} returned a GraphQL envelope with no data and no errors.`,
          }),
        );
      }

      return envelope.data;
    },
    input.resilience,
  );
}

export { HttpStatusError };
