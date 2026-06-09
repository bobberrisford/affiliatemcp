/**
 * Involve Asia auth — API key + secret exchanged for a short-lived bearer
 * token, with an in-memory token cache. Modelled on Rakuten's auth.ts.
 *
 * --- The auth model ----------------------------------------------------------
 *
 * Involve Asia does not use a long-lived static token. Instead the publisher
 * holds an API **key** and **secret** (Dashboard → Tools → API). These are
 * exchanged via `POST /authenticate` (form params `key`, `secret`) for a
 * **bearer token** that the docs state expires in ~2 hours. Data endpoints
 * then send `Authorization: Bearer <token>`.
 *
 * (Verify against https://help.involve.asia/hc/en-us/articles/360029841771 —
 * "API Key and Secret are required to generate the API token; the generated
 * API token will expire in 2 hours".)
 *
 * --- Why the cache pattern ---------------------------------------------------
 *
 * The token is short-lived but reusable for ~2 hours. Re-authenticating on
 * every call would add an auth round-trip to every operation and burn the
 * authenticate endpoint's own rate budget. The cache here is a single
 * module-scope object `{ token, expiresAt }`, refreshed proactively when the
 * remaining lifetime drops below the margin, and reactively on a 401 from a
 * data endpoint (see client.ts). This is the ONLY module-level mutable state
 * in the adapter folder.
 *
 * Concurrency: Node is single-threaded; `inFlightRefresh` deduplicates two
 * callers that notice staleness at the same time so only one round-trips the
 * authenticate endpoint.
 *
 * --- The credentials shape ---------------------------------------------------
 *
 * Two credentials, both supplied by the user; no derivation is possible (the
 * authenticate response returns only the token). `verifyAuth` returns
 * `derivedValues: {}` for shape consistency with the other adapters.
 */

import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { HttpStatusError, withResilience, DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { createLogger } from '../../shared/logging.js';
import { INVOLVE_ASIA_BASE_URL } from './client.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';

const log = createLogger('involve-asia.auth');

/** The authenticate endpoint. Lives directly under the API base. */
function authenticateUrl(): string {
  return `${INVOLVE_ASIA_BASE_URL.replace(/\/$/, '')}/authenticate`;
}

interface TokenCacheEntry {
  token: string;
  /** Epoch ms; the time at which we treat the token as expired. */
  expiresAt: number;
}

/** Module-scope cache. The single piece of mutable state in the adapter. */
let cache: TokenCacheEntry | null = null;

/**
 * In-flight refresh deduplication. If callers A and B both notice the token is
 * stale at the same time, only one hits the network; the other awaits the
 * same promise.
 */
let inFlightRefresh: Promise<string> | null = null;

/**
 * Involve Asia tokens last ~2 hours. The authenticate response does not return
 * an explicit lifetime, so we assume the documented 2h and refresh proactively
 * with a generous margin. If a token is revoked early, the 401-refresh path in
 * client.ts still recovers it.
 */
const ASSUMED_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours
/** Refresh proactively when this many ms remain on the lifetime. */
const PROACTIVE_REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Test-only: clear the cache so an isolated test does not leak token state
 * into another test.
 */
export function _resetTokenCache(): void {
  cache = null;
  inFlightRefresh = null;
}

/**
 * Return a usable access token, refreshing if necessary. Throws a NetworkError
 * (auth_error envelope) on failure.
 *
 * `forceRefresh` is set by the client after a 401. The refresh is surfaced at
 * debug level so the recovery path is observable (no silent retries).
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
    log.debug({ reason: opts.reason, url: authenticateUrl() }, 'involve-asia token refresh');
    try {
      const key = requireCredential('INVOLVE_ASIA_API_KEY', {
        network: 'involve-asia',
        operation: 'auth.refreshToken',
        hint: 'Set INVOLVE_ASIA_API_KEY in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup involve-asia`. Find it at Dashboard → Tools → API.',
      });
      const secret = requireCredential('INVOLVE_ASIA_API_SECRET', {
        network: 'involve-asia',
        operation: 'auth.refreshToken',
        hint: 'Set INVOLVE_ASIA_API_SECRET in ~/.affiliate-mcp/.env. Find it at Dashboard → Tools → API.',
      });

      const exchanged = await exchangeForToken(key, secret);
      cache = exchanged;
      log.debug({ expiresAt: new Date(exchanged.expiresAt).toISOString() }, 'involve-asia token cached');
      return exchanged.token;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

interface AuthenticateResponse {
  status?: string;
  message?: string;
  // Involve Asia wraps the token under `data`. We read both the wrapped and a
  // top-level fallback defensively, since the surface is weakly documented.
  data?: { token?: string };
  token?: string;
}

/**
 * Round-trip the authenticate endpoint and parse its response.
 *
 * The exchange goes through `withResilience` so a transient 5xx on the auth
 * path is retried under the same policy as a data endpoint — we do not want a
 * single gateway hiccup on the auth path to fail every adapter method in the
 * same process.
 *
 * This is one of only two sanctioned `fetch` sites in the folder (the data
 * client is the other). It lives here rather than in client.ts because the
 * authenticate call cannot itself depend on `getAccessToken` — that would be
 * circular.
 */
async function exchangeForToken(key: string, secret: string): Promise<TokenCacheEntry> {
  const body = new URLSearchParams({ key, secret }).toString();

  return withResilience(
    { network: 'involve-asia', operation: 'auth.tokenExchange' },
    async () => {
      const res = await fetch(authenticateUrl(), {
        method: 'POST',
        headers: {
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
          `Involve Asia token exchange → HTTP ${res.status}`,
        );
      }
      let parsed: AuthenticateResponse;
      try {
        parsed = JSON.parse(raw) as AuthenticateResponse;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'involve-asia',
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message: `Involve Asia authenticate endpoint returned non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
      const token = parsed.data?.token ?? parsed.token;
      if (!token) {
        // A 200 with no token is an upstream auth misconfiguration the user
        // must see. Preserve the verbatim body (PRD §4.1).
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'involve-asia',
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message:
              'Involve Asia authenticate endpoint returned HTTP 200 but no token field.',
            hint: 'Re-check INVOLVE_ASIA_API_KEY and INVOLVE_ASIA_API_SECRET at Dashboard → Tools → API.',
          }),
        );
      }
      // The response carries no explicit lifetime; assume the documented ~2h.
      return {
        token,
        expiresAt: Date.now() + ASSUMED_TOKEN_LIFETIME_MS,
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
  /** No derivation possible — both credentials are user-supplied. */
  derivedValues?: Record<string, string>;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by exchanging the key + secret for a token.
 *
 * A successful token exchange already proves the credentials work — the
 * authenticate call is the conclusive test for a setup wizard, so we do not
 * make an extra data-plane call here (keeps verifyAuth cheap; the wizard runs
 * it inline). The cache is reset first so verifyAuth reflects a fresh exchange
 * rather than an in-process artefact.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  _resetTokenCache();
  try {
    await refreshToken({ reason: 'verifyAuth' });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: 'involve-asia',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Re-check INVOLVE_ASIA_API_KEY / INVOLVE_ASIA_API_SECRET. Trailing whitespace from a copy/paste is the most common cause.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  // Involve Asia's authenticate response does not return an account identifier,
  // so the most honest identity we can offer is the network slug. The token
  // exchange having succeeded is the meaningful signal.
  return {
    ok: true,
    identity: 'involve-asia (token issued)',
    derivedValues: {},
  };
}

/**
 * Validate a single credential at wizard-entry time.
 *
 * Both credentials are needed together for a useful live check (the secret
 * cannot be validated without the key), so the wizard's flow is: prompt both,
 * then call `verifyAuth()`. For ergonomics we still offer per-field emptiness /
 * whitespace checks so obvious typos are caught before the network round-trip.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  switch (field) {
    case 'INVOLVE_ASIA_API_KEY':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'API key is required.' };
      }
      if (/\s/.test(value)) {
        return {
          ok: false,
          message: 'API key contains whitespace — typically a copy/paste error.',
          hint: 'Re-copy the key from Dashboard → Tools → API; it does not contain spaces.',
        };
      }
      return { ok: true };
    case 'INVOLVE_ASIA_API_SECRET': {
      if (!value || value.trim() === '') {
        return { ok: false, message: 'API secret is required.' };
      }
      if (/\s/.test(value)) {
        return {
          ok: false,
          message: 'API secret contains whitespace — typically a copy/paste error.',
          hint: 'Re-copy the secret from Dashboard → Tools → API; it does not contain spaces.',
        };
      }
      // With the secret entered we can run the full exchange. Set the candidate
      // into the environment, verify, then restore the previous value so a
      // failed validation does not poison subsequent operations in-process.
      const previous = process.env['INVOLVE_ASIA_API_SECRET'];
      process.env['INVOLVE_ASIA_API_SECRET'] = value;
      try {
        const result = await verifyAuth();
        if (result.ok) {
          return { ok: true, message: result.identity ?? 'credentials verified' };
        }
        return {
          ok: false,
          message: result.reason,
          hint: 'Check the key and secret at Dashboard → Tools → API. They may be revoked or copied with stray whitespace.',
        };
      } finally {
        if (previous === undefined) {
          delete process.env['INVOLVE_ASIA_API_SECRET'];
        } else {
          process.env['INVOLVE_ASIA_API_SECRET'] = previous;
        }
      }
    }
    default:
      return {
        ok: false,
        message: `Unknown credential field "${field}" for Involve Asia.`,
        hint: 'Involve Asia expects INVOLVE_ASIA_API_KEY and INVOLVE_ASIA_API_SECRET.',
      };
  }
}
