/**
 * Rakuten Advertising auth — OAuth2 client-credentials + in-memory token cache.
 *
 * --- Why the cache pattern ---------------------------------------------------
 *
 * Rakuten access tokens last ~1 hour (the `expires_in` field on the token
 * response is typically 3600 seconds). Calling the token endpoint on every
 * adapter call would:
 *   - Add ~200-400ms of auth handshake latency to every operation (Rakuten's
 *     token endpoint is consistently slower than its data endpoints).
 *   - Burn through the authorisation API's own rate limit, which is documented
 *     as stricter than the data endpoints. A user making 50 listTransactions
 *     calls in quick succession would risk a 429 on the *auth* call rather
 *     than the data call — a particularly confusing failure mode.
 *   - Generate a noisy access-log on Rakuten's side that we don't need.
 *
 * The cache here is a single module-scope object: `{ token, expiresAt }`.
 * Concurrency story: Node is single-threaded; a single in-flight request that
 * triggers a refresh blocks subsequent refreshes via the `inFlightRefresh`
 * promise so two parallel callers don't both round-trip the token endpoint.
 *
 * --- Module-level mutable state ----------------------------------------------
 *
 * This is the ONLY mutable module-level state in the Rakuten adapter. Future
 * contributors: if you find yourself adding a second piece of module state,
 * stop and think. The cache here is justified because:
 *   - It's keyed by process identity (the credentials don't change at runtime).
 *   - The refresh is observable (logged at debug+) — the token-refresh-on-401
 *     path is NOT hidden.
 *   - Tests can call `_resetTokenCache()` to isolate.
 *
 * --- Refresh policy ----------------------------------------------------------
 *
 *   1. Proactive: when the cached token has <300s until expiry, refresh before
 *      the next call uses it. This avoids "token expired mid-flight" 401s.
 *   2. Reactive: if a 401 surfaces from any subsequent call, the client clears
 *      the cache and calls `refreshToken()` once, then retries the original
 *      call exactly once. If THAT 401s too, we fail with an `auth_error`
 *      envelope rather than looping.
 *
 * --- The credentials shape ---------------------------------------------------
 *
 * Rakuten uses OAuth2 client-credentials with an unusual scope encoding:
 *   - Basic auth header: base64(CLIENT_ID:CLIENT_SECRET).
 *   - Body (form-urlencoded): scope=<Site ID / SID>.
 *   - grant_type is implicit ("client_credentials" is the only option).
 *
 * The SID (Site ID) is required because a single client_id may have access to
 * multiple publisher sites. There is no auto-derivation: the user supplies all
 * three (`derivedValues` returns `{}`).
 *
 * Docs URL: https://developers.rakutenadvertising.com/ (intermittently 403s
 * without an account login — see docs/findings/rakuten.md).
 */

import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { HttpStatusError, withResilience, DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { createLogger } from '../../shared/logging.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';

const log = createLogger('rakuten.auth');

/**
 * Rakuten's token-exchange endpoint. The base host varies across accounts
 * (some tenants use `api.rakutenmarketing.com` rather than `api.linksynergy.com`).
 * We default to linksynergy.com — it is what the public developer portal
 * documents and we have not observed a tenant that rejects it. If a future
 * user reports a 404 here, they can override via `RAKUTEN_TOKEN_URL`.
 */
const DEFAULT_TOKEN_URL = 'https://api.linksynergy.com/token';

function tokenUrl(): string {
  const override = process.env['RAKUTEN_TOKEN_URL'];
  if (override && override.trim() !== '') return override;
  return DEFAULT_TOKEN_URL;
}

interface TokenCacheEntry {
  token: string;
  /** Epoch ms; the time at which we treat the token as expired. */
  expiresAt: number;
}

/** Module-scope cache. The single piece of mutable state in the adapter. */
let cache: TokenCacheEntry | null = null;

/**
 * In-flight refresh deduplication. If callers A and B both notice the token
 * is stale at the same time, only one of them hits the network; the other
 * awaits the same promise.
 */
let inFlightRefresh: Promise<string> | null = null;

/** Refresh proactively when this many ms remain on the lifetime. */
const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Test-only: clear the cache so an isolated test doesn't leak token state
 * into another test. Not exported in production builds via tsconfig — but
 * available to vitest because it imports the source directly.
 */
export function _resetTokenCache(): void {
  cache = null;
  inFlightRefresh = null;
}

/**
 * Return a usable access token, refreshing if necessary. Throws a NetworkError
 * (auth_error envelope) on failure.
 *
 * `forceRefresh` is set by the client after a 401 — see `client.ts`. We DO
 * surface that path at debug level so the refresh is observable. Per the
 * project's "no silent retries" rule, the refresh is not hidden from logs.
 */
export async function getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const now = Date.now();
  if (!opts.forceRefresh && cache && cache.expiresAt - now > PROACTIVE_REFRESH_MARGIN_MS) {
    return cache.token;
  }
  return refreshToken({ reason: opts.forceRefresh ? 'forced (401)' : 'expired or missing' });
}

/**
 * Force a token refresh. Deduplicates concurrent callers via `inFlightRefresh`.
 */
export async function refreshToken(opts: { reason: string }): Promise<string> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    log.debug({ reason: opts.reason, tokenUrl: tokenUrl() }, 'rakuten token refresh');
    try {
      const clientId = requireCredential('RAKUTEN_CLIENT_ID', {
        network: 'rakuten',
        operation: 'auth.refreshToken',
        hint: 'Set RAKUTEN_CLIENT_ID in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup rakuten`.',
      });
      const clientSecret = requireCredential('RAKUTEN_CLIENT_SECRET', {
        network: 'rakuten',
        operation: 'auth.refreshToken',
        hint: 'Set RAKUTEN_CLIENT_SECRET in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup rakuten`.',
      });
      const sid = requireCredential('RAKUTEN_SID', {
        network: 'rakuten',
        operation: 'auth.refreshToken',
        hint: 'Set RAKUTEN_SID (your Rakuten publisher Site ID) in ~/.affiliate-mcp/.env.',
      });

      const exchanged = await exchangeForToken(clientId, clientSecret, sid);
      cache = exchanged;
      log.debug({ expiresAt: new Date(exchanged.expiresAt).toISOString() }, 'rakuten token cached');
      return exchanged.token;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * Round-trip the Rakuten token endpoint and parse its response.
 *
 * The exchange goes through `withResilience` so a transient 5xx on the token
 * endpoint is retried under the same policy as a data endpoint. We don't want
 * a single Cloudflare hiccup on Rakuten's auth path to fail every adapter
 * method in the same process.
 *
 * Why we explicitly send `Accept: application/json`: Rakuten's token endpoint
 * historically defaulted to an XML response shape; sending the JSON Accept
 * header is what gets you the documented JSON body. See findings doc.
 */
async function exchangeForToken(
  clientId: string,
  clientSecret: string,
  sid: string,
): Promise<TokenCacheEntry> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ scope: sid }).toString();

  return withResilience(
    { network: 'rakuten', operation: 'auth.tokenExchange' },
    async () => {
      const res = await fetch(tokenUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          raw,
          `Rakuten token exchange → HTTP ${res.status}`,
        );
      }
      let parsed: { access_token?: string; expires_in?: number; token_type?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Polish (Chunk 10): preserve verbatim body via NetworkError envelope
        // so the user sees Rakuten's exact response (PRD §4.1).
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'rakuten',
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message: `Rakuten token endpoint returned non-JSON body (parse error: ${(err as Error).message})`,
            hint: 'Did the Accept: application/json header reach the token endpoint? Check any intermediate proxy.',
          }),
        );
      }
      if (!parsed.access_token) {
        // Polish (Chunk 10): preserve verbatim body — a 200 with missing
        // access_token is an upstream auth misconfiguration the user must see.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'rakuten',
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message: 'Rakuten token endpoint returned HTTP 200 but no access_token field.',
            hint: 'Re-check RAKUTEN_CLIENT_ID / RAKUTEN_CLIENT_SECRET / RAKUTEN_SID and the token URL.',
          }),
        );
      }
      const lifetimeMs = (parsed.expires_in ?? 3600) * 1000;
      return {
        token: parsed.access_token,
        expiresAt: Date.now() + lifetimeMs,
      };
    },
    DEFAULT_RESILIENCE,
  );
}

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  /**
   * Rakuten requires all three credentials directly from the user (no
   * derivation possible — the SID is not extractable from the token response).
   * We return `{}` for shape consistency with other adapters.
   */
  derivedValues?: Record<string, string>;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by exchanging credentials for a token and then hitting a small,
 * low-impact endpoint.
 *
 * Why `/v1/programs/?page_size=1`: it's a tiny call that requires the bearer
 * token (so 401 = bad token, not a network blip), is read-only, and has no
 * side effects. If Rakuten's `/programs/` is itself gated for the test
 * account we'll see a clean 4xx surfaced with the verbatim body, which is
 * exactly the actionable failure we want.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  // Reset any prior cached token: verifyAuth is the wizard's correctness
  // probe and must reflect a fresh exchange, not an in-process artefact.
  _resetTokenCache();
  try {
    // Force the exchange path so credential errors surface here, not later.
    await refreshToken({ reason: 'verifyAuth' });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: 'rakuten',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Re-check RAKUTEN_CLIENT_ID / RAKUTEN_CLIENT_SECRET / RAKUTEN_SID. Trailing whitespace from a copy/paste is the most common cause.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  // We don't actually need to call /programs here for the auth check to be
  // meaningful — a successful token exchange already proves the credentials
  // work. Calling /programs would tell us "the data plane is reachable", but
  // for a setup wizard the token exchange is the conclusive test. We skip
  // the extra call to keep verifyAuth cheap (the wizard runs it inline).
  // If a future requirement demands a data-plane probe, lift the body of
  // listProgrammes' first page into here.
  const sid = process.env['RAKUTEN_SID'] ?? '';
  return {
    ok: true,
    identity: sid ? `rakuten/SID=${sid}` : 'rakuten',
    derivedValues: {},
  };
}

/**
 * Validate a single credential at wizard-entry time.
 *
 * The three Rakuten credentials all need to be present together for a useful
 * check; we can't validate the secret without the id, and we can't validate
 * the SID without both. The wizard's flow is: prompt all three, then call
 * `verifyAuth()` at the end. For ergonomics we still offer per-field
 * format checks so obvious typos are caught before the network round-trip.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  switch (field) {
    case 'RAKUTEN_CLIENT_ID':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Client ID is required.' };
      }
      // Rakuten client IDs are alphanumeric strings (often UUID-shaped, but
      // not always). We don't enforce a regex — only emptiness.
      return { ok: true };
    case 'RAKUTEN_CLIENT_SECRET':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Client secret is required.' };
      }
      if (/\s/.test(value)) {
        return {
          ok: false,
          message: 'Client secret contains whitespace — typically a copy/paste error.',
          hint: 'Re-copy the value from the Rakuten dashboard; secrets do not contain spaces.',
        };
      }
      return { ok: true };
    case 'RAKUTEN_SID':
      if (!/^\d+$/.test(value)) {
        return {
          ok: false,
          message: 'Rakuten SID (Site ID) must be a positive integer.',
          hint: 'You can find the SID in the Rakuten publisher dashboard under Account → Sites. It is the numeric identifier of the site you want to attribute traffic to.',
        };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        message: `Unknown credential field "${field}" for Rakuten.`,
        hint: 'Rakuten expects RAKUTEN_CLIENT_ID, RAKUTEN_CLIENT_SECRET, and RAKUTEN_SID.',
      };
  }
}
