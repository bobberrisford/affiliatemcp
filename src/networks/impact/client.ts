/**
 * Impact HTTP client — the ONLY path Impact adapter methods use for network I/O.
 *
 * Why this file is structurally identical to `src/networks/awin/client.ts` but
 * isolated in its own folder: Impact has known flakiness (PRD §9.3) and this
 * file carries Impact-specific workarounds. Future contributors writing other
 * adapters should mirror the *shape* of `awin/client.ts` — not this file.
 *
 * Per AGENTS.md / PRD §9.3, every Impact-specific workaround in this folder is
 * prefixed `// IMPACT-WORKAROUND:` so it greps cleanly. Do NOT propagate those
 * workarounds to other networks.
 *
 * Hard rules (same as every adapter):
 *   1. Do NOT call `fetch` from `adapter.ts` directly — go through `impactRequest`.
 *   2. Do NOT add a second client that bypasses `withResilience`.
 *   3. On a non-2xx response throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('impact.client');

/**
 * Impact's root host. The Mediapartners surface lives under
 * `/Mediapartners/{AccountSID}/...` — the account SID is part of the URL, not
 * just the auth header. We pass `accountSid` through `impactRequest` rather
 * than baking it into a per-publisher base URL so credentials remain a runtime
 * input (testable, swappable, mockable).
 */
export const IMPACT_BASE_URL = 'https://api.impact.com';

export interface ImpactRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /**
   * Path WITHIN the Mediapartners namespace, beginning with `/`.
   * Example: `/Campaigns`, `/Actions`, `/TrackingValueRequests`.
   * The client prepends `/Mediapartners/{accountSid}` automatically.
   */
  path: string;
  /** Impact AccountSID — also the path segment. */
  accountSid: string;
  /** Impact AuthToken — the Basic-auth password. */
  authToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /**
   * Body for POST/PUT requests. Impact's POST endpoints (notably
   * /TrackingValueRequests) accept application/x-www-form-urlencoded form
   * bodies rather than JSON; pass a Record<string,string> for form encoding,
   * or any other type for JSON encoding.
   */
  body?: Record<string, string> | unknown;
  /** Set true to force form-urlencoded body encoding. Default: JSON. */
  formEncoded?: boolean;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Impact API request under the resilience policy.
 *
 * The response type `T` is not validated at runtime — see the matching note in
 * `awin/client.ts`. Impact's surface drifts (see findings doc) so adapter
 * transformers MUST read every field defensively.
 */
export async function impactRequest<T>(input: ImpactRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'impact', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.accountSid, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.accountSid, input.authToken, input.body, input.formEncoded),
      };
      if (input.body !== undefined) {
        if (input.formEncoded || isPlainStringRecord(input.body)) {
          // IMPACT-WORKAROUND: Impact's POST endpoints (notably
          // /TrackingValueRequests) accept application/x-www-form-urlencoded
          // bodies. Sending JSON to those endpoints yields a 415 with an
          // unhelpful body. Form-encode when the caller passes a plain
          // string-record body OR explicitly opts in via `formEncoded`.
          init.body = encodeForm(input.body as Record<string, string>);
        } else {
          init.body = JSON.stringify(input.body);
        }
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'impact request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Impact occasionally
      // serves an HTML 502 from the edge despite valid auth — preserving the
      // raw text means the user sees the actual content rather than a
      // paraphrase.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Impact ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // IMPACT-WORKAROUND: Impact sometimes returns a literal `null` body on
      // empty lists, sometimes `{}`, sometimes the documented `{ Actions: [] }`
      // shape. Normalise empty/null bodies to `{}` here; the transformer in
      // the adapter then reads the expected array key defensively.
      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // Polish (Chunk 10): emit a NetworkError carrying the verbatim body
        // (PRD §4.1) so the user sees the actual response Impact returned —
        // often XML when the JSON Accept header is dropped at the edge.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'impact',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Impact ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Authorization + Accept headers.
 *
 * IMPACT-WORKAROUND: we ALWAYS send `Accept: application/json`. Some Impact
 * endpoints default to XML when this header is absent, and XML breaks our
 * `JSON.parse` path. The cost of being explicit is one extra header byte;
 * the benefit is removing an entire failure mode.
 */
function buildHeaders(
  accountSid: string,
  authToken: string,
  body: unknown,
  formEncoded: boolean | undefined,
): Record<string, string> {
  // HTTP Basic: base64("AccountSID:AuthToken").
  // Buffer is available in Node.js; this file does not run in the browser.
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  };
  if (body !== undefined) {
    if (formEncoded || isPlainStringRecord(body)) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      headers['Content-Type'] = 'application/json';
    }
  }
  return headers;
}

/**
 * Compose the full URL with query string.
 *
 * The `/Mediapartners/{accountSid}` prefix is prepended here so adapter
 * methods write only the operation-relative path (e.g. `/Campaigns`,
 * `/Actions`). This keeps the call sites readable.
 */
function buildUrl(
  accountSid: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const safeAccount = encodeURIComponent(accountSid);
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const fullPath = `/Mediapartners/${safeAccount}${rel}`;
  const url = new URL(fullPath, IMPACT_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function encodeForm(rec: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(rec)) {
    params.set(k, v);
  }
  return params.toString();
}

function isPlainStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
