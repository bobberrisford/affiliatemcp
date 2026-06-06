/**
 * ShareASale HTTP client — the ONLY path ShareASale adapter methods use for
 * network I/O.
 *
 * Why this file exists separately from `adapter.ts` (mirrors Awin's client.ts —
 * read that file for the full rationale):
 *   - Adapter methods speak in normalised domain types; they must not be
 *     entangled with URL construction, header building, JSON/CSV parsing, or
 *     status handling.
 *   - The resilience layer (timeout, retry, circuit breaker) wraps every
 *     outgoing call exactly once, here, so no adapter method can bypass it.
 *
 * --- The ShareASale auth quirk: per-request HMAC-SHA256 signing --------------
 *
 * ShareASale is a US network. Although it is Awin-owned it runs on a SEPARATE
 * account and a SEPARATE API with a different authentication scheme, so this
 * adapter is standalone and does NOT reuse the Awin adapter.
 *
 * Every request sends two custom headers (NOT an `Authorization` bearer):
 *
 *   x-ShareASale-Date:           an RFC 1123 GMT timestamp, e.g.
 *                                "Thu, 14 Apr 2011 22:44:22 GMT".
 *   x-ShareASale-Authentication: the SHA-256 hex digest of a canonical
 *                                signature string keyed on the API secret.
 *
 * The signature string is, verbatim from the ShareASale API documentation
 * (account.shareasale.com/a-apimanager.cfm; mirrored at
 * resources.affiliate.com/article/135-api-credentials-shareasale):
 *
 *   {APIToken}:{x-ShareASale-Date}:{action}:{APISecretKey}
 *
 * hashed with SHA-256 and emitted as a hex string. The documented worked
 * example pins this:
 *
 *   token  = "NGc6dg5e9URups5o"
 *   secret = "ATj7vd8b7CCjeq9yQUo8cc2w3OThqe2e"
 *   action = "bannerList"
 *   date   = "Thu, 14 Apr 2011 22:44:22 GMT"
 *   string = "NGc6dg5e9URups5o:Thu, 14 Apr 2011 22:44:22 GMT:bannerList:ATj7vd8b7CCjeq9yQUo8cc2w3OThqe2e"
 *   hash   = "78D54A3051AE0AAAF022AA2DA230B97D5219D82183FEFF71E2D53DEC6057D9F1"
 *
 * Note the documented example hash is upper-case; the server compares
 * case-insensitively, so we emit the lower-case hex `crypto` produces and the
 * unit test asserts a case-insensitive match against the published vector.
 *
 * The `action` mixed into the signature MUST be the exact `action` query
 * param sent on the wire, and the date header MUST be the same value used in
 * the signature — so we compute the date once and reuse it (see `signRequest`).
 *
 * We use Node's built-in `crypto` (`createHash`) — no new dependency.
 *
 * Hard rules (mirrored from Awin client.ts):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import { createHash } from 'node:crypto';

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('shareasale.client');

export const SHAREASALE_SLUG = 'shareasale';

/**
 * The ShareASale API root. The affiliate API answers on `w.cfm`; the query
 * string carries `affiliateId`, `token`, `version`, and `action`. Centralised
 * so a test harness can override it without touching adapter code.
 */
export const SHAREASALE_BASE_URL = 'https://api.shareasale.com';

/**
 * The affiliate API path. ShareASale serves both the merchant and affiliate
 * APIs from `/w.cfm`; the `action` plus the `affiliateId` param scope the call
 * to the affiliate surface.
 */
export const SHAREASALE_API_PATH = '/w.cfm';

/**
 * The API version. ShareASale's current documented version is 3.0; the
 * affiliate reporting actions accept it. Pinned here so a version bump is a
 * one-line change reviewable in isolation.
 */
export const SHAREASALE_API_VERSION = '3.0';

export interface ShareasaleCredentials {
  /** The affiliate (publisher) account id. Sent as the `affiliateId` query param. */
  affiliateId: string;
  /** The API token — the public half. Sent as the `token` query param AND mixed into the signature. */
  token: string;
  /** The API secret key — the secret half. Used as the HMAC material; never sent on the wire. */
  secretKey: string;
}

export interface ShareasaleRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * The ShareASale `action` verb, e.g. "merchantStatus" / "activity".
   * This exact value is BOTH sent as the `action` query param AND mixed into
   * the signature string, so the two cannot drift.
   */
  action: string;
  /** API credential triple. Passed in so the read happens once in the adapter. */
  credentials: ShareasaleCredentials;
  /**
   * Extra query string parameters (date filters, merchantId, etc.). Values that
   * are `undefined` are skipped. `affiliateId`, `token`, `version`, and
   * `action` are added by the client — do not pass them here.
   */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
  /**
   * Test-only: pin the Date used for signing so the signature is deterministic.
   * Production callers never set this — the live Date is generated per call.
   */
  now?: Date;
}

/**
 * Format a Date as the RFC 1123 GMT string ShareASale expects in the
 * `x-ShareASale-Date` header and inside the signature. Node's `toUTCString()`
 * produces exactly the documented shape, e.g. "Thu, 14 Apr 2011 22:44:22 GMT".
 */
export function formatShareasaleDate(d: Date): string {
  return d.toUTCString();
}

/**
 * Compute the two ShareASale auth headers for a request.
 *
 * Exported (and pure) so the unit test can assert the signature and date header
 * are present and deterministic for a fixed input without any HTTP — and so the
 * published worked example can be pinned as a regression vector.
 *
 * Signature string: `{token}:{date}:{action}:{secretKey}` → SHA-256 hex.
 */
export function signRequest(input: {
  action: string;
  credentials: ShareasaleCredentials;
  date: Date;
}): Record<string, string> {
  const dateHeader = formatShareasaleDate(input.date);
  const signatureString =
    input.credentials.token +
    ':' +
    dateHeader +
    ':' +
    input.action +
    ':' +
    input.credentials.secretKey;
  const auth = createHash('sha256').update(signatureString).digest('hex');
  return {
    'x-ShareASale-Date': dateHeader,
    'x-ShareASale-Authentication': auth,
  };
}

/**
 * Issue a single ShareASale API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: ShareASale's
 * reporting surface is weakly documented and has not been verified against a
 * live account at commit time. Over-specifying a schema here would force the
 * client into "is this a valid response?", which belongs in the adapter's
 * defensive transformers. Adapter transformers MUST tolerate missing keys.
 *
 * Note: the affiliate API can return JSON or CSV depending on the action; we
 * request JSON and the adapter transformers read the parsed body defensively.
 */
export async function shareasaleRequest<T>(input: ShareasaleRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SHAREASALE_SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const date = input.now ?? new Date();
      const headers: Record<string, string> = {
        ...signRequest({ action: input.action, credentials: input.credentials, date }),
        Accept: 'application/json',
      };

      const url = buildUrl(input);

      const init: RequestInit = { method: 'GET', headers };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, action: input.action, operation: input.operation }, 'shareasale request');

      const res = await fetch(url, init);

      // Read the body once: needed both for success (decode JSON) and failure
      // (surface verbatim on the envelope).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `ShareASale ${input.operation} GET ${input.action} → HTTP ${res.status}`,
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
            network: SHAREASALE_SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `ShareASale ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the full URL with the four mandatory query params plus any extras.
 *
 * `affiliateId`, `token`, `version`, and `action` are always present. We use
 * `URL` + `URLSearchParams` rather than string concatenation because the date
 * filters and merchant ids must be URL-encoded safely.
 */
function buildUrl(input: ShareasaleRequestInput): string {
  const url = new URL(SHAREASALE_API_PATH, SHAREASALE_BASE_URL);
  url.searchParams.set('affiliateId', input.credentials.affiliateId);
  url.searchParams.set('token', input.credentials.token);
  url.searchParams.set('version', SHAREASALE_API_VERSION);
  url.searchParams.set('action', input.action);
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
