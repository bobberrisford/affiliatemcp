/**
 * eBay Partner Network auth — OAuth2 client-credentials flow.
 *
 * EPN's API uses standard eBay developer OAuth2 application tokens. The
 * publisher registers an "application" in the eBay developer portal, receives
 * a client ID and client secret, and exchanges them for a short-lived access
 * token via `POST /identity/v1/oauth2/token` (token endpoint shared with the
 * rest of eBay's APIs). The token is then sent as `Authorization: Bearer ...`
 * on every API call.
 *
 * Why a token cache lives in this file:
 *   - The client-credentials token has a documented two-hour TTL. Refreshing
 *     it on every API call wastes ~150ms and a request budget.
 *   - The cache is the ONLY module-level mutable state allowed in this folder
 *     (matches the Rakuten precedent). It is local to the process; tests reset
 *     it via the exported `_resetTokenCache` helper.
 *
 * Reference: src/networks/rakuten/auth.ts — the canonical example of an
 * OAuth2 token cache living alongside the adapter. eBay's flow is simpler
 * (no refresh token; just re-do the client-credentials exchange when the
 * cached token expires).
 *
 * --- derivedValues -----------------------------------------------------------
 *
 * EPN exposes a per-account `campaignId` that is required for tracking-link
 * construction. The campaign ID is NOT derivable from the client credentials
 * alone — the user must read it from the EPN dashboard ("Campaigns" → "Smart
 * Link" → the numeric column). We therefore prompt for it explicitly via
 * `setupSteps` rather than deriving it. This is documented in
 * `docs/networks/ebay.md`.
 *
 * The verifyAuth call's `identity` is the eBay developer username inferred
 * from the token response (the response carries no profile data, so we use
 * the client ID prefix as the identity stand-in — honest about what we know).
 */

import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { HttpStatusError, withResilience, DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('ebay.auth');

/**
 * eBay's OAuth2 token endpoint. Centralised so the test harness can override
 * via the EBAY_TOKEN_URL env var (a deliberate seam for the OAuth flow tests).
 */
export const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

/**
 * The scope EPN's reporting / Smart Link endpoints require. The application
 * scope `https://api.ebay.com/oauth/api_scope` is the lowest-privilege scope
 * that grants partner-side reporting access (per eBay developer docs).
 */
export const EBAY_DEFAULT_SCOPE = 'https://api.ebay.com/oauth/api_scope';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

let cachedToken: CachedToken | null = null;

/** Test-only: reset the token cache so each test starts with a clean slate. */
export function _resetTokenCache(): void {
  cachedToken = null;
}

/**
 * Return an access token, minting a new one if the cached value is missing or
 * expired. Refreshes ~30s before the documented expiry to avoid races with
 * in-flight requests.
 *
 * Why we refresh slightly early: eBay sometimes returns 401 on a token whose
 * client clock says "valid for 4 more seconds". Pre-emptive refresh costs one
 * token exchange every two hours and removes that race.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const now = Date.now();
  if (
    !opts?.forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt > now + 30_000 // 30s safety window
  ) {
    return cachedToken.accessToken;
  }

  const clientId = requireCredential('EBAY_CLIENT_ID', {
    network: 'ebay',
    operation: 'verifyAuth',
    hint:
      'Generate a Production application key set at https://developer.ebay.com/my/keys. ' +
      'Copy the App ID (Client ID) into EBAY_CLIENT_ID.',
  });
  const clientSecret = requireCredential('EBAY_CLIENT_SECRET', {
    network: 'ebay',
    operation: 'verifyAuth',
    hint:
      'Copy the Cert ID (Client Secret) from your Production application key set at ' +
      'https://developer.ebay.com/my/keys.',
  });
  const scope = getCredential('EBAY_OAUTH_SCOPE') ?? EBAY_DEFAULT_SCOPE;

  const tokenUrl = getCredential('EBAY_TOKEN_URL') ?? EBAY_TOKEN_URL;

  // Client-credentials grant: HTTP Basic with client_id:client_secret + a
  // form-urlencoded body declaring the grant type and the requested scope.
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('scope', scope);

  const ctx = { network: 'ebay' as const, operation: 'verifyAuth' as const };
  const response = await withResilience(
    ctx,
    async () => {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      const rawBody = await res.text();
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `eBay OAuth token exchange → HTTP ${res.status}`,
        );
      }
      try {
        return JSON.parse(rawBody) as {
          access_token?: string;
          expires_in?: number;
          token_type?: string;
        };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'ebay',
            operation: 'verifyAuth',
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `eBay OAuth token endpoint returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    DEFAULT_RESILIENCE,
  );

  if (!response.access_token) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'auth_error',
        network: 'ebay',
        operation: 'verifyAuth',
        message:
          'eBay OAuth response missing access_token. Check that your application is enabled for the EPN scope.',
        hint:
          'In the eBay developer portal, confirm the application has been enrolled in the Partner Network ' +
          'and that the production keys are not still pending review.',
        networkErrorBody: JSON.stringify(response),
      }),
    );
  }

  // Default eBay client-credentials TTL is 7200 seconds; respect the
  // server-provided value where present.
  const ttlSeconds = typeof response.expires_in === 'number' ? response.expires_in : 7200;
  cachedToken = {
    accessToken: response.access_token,
    expiresAt: now + ttlSeconds * 1000,
    scope,
  };
  log.debug({ ttlSeconds, scope }, 'minted eBay access token');
  return cachedToken.accessToken;
}

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify the eBay credentials by exchanging them for an access token.
 *
 * Why the token exchange IS the auth check: eBay's OAuth endpoint refuses bad
 * client IDs / secrets with a clean 401 (the error body names the failed
 * field). A successful exchange therefore proves the credentials are valid
 * without making any further EPN API call — keeps the wizard's validation
 * step cheap and fast.
 *
 * Identity: the client ID. We deliberately do NOT call any other eBay
 * endpoint here to derive a richer identity; the user knows which application
 * they configured, and pretending to fetch a username from the token alone
 * would be invention.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('EBAY_CLIENT_ID', {
      network: 'ebay',
      operation: 'verifyAuth',
      hint: 'Run `affiliate-mcp setup ebay` to provide EBAY_CLIENT_ID.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Force a refresh so verifyAuth always exercises the live exchange.
    // Otherwise a stale cached token from a previous (valid) session would
    // mask a credential rotation that the user expected to fail.
    await getAccessToken({ forceRefresh: true });
    return {
      ok: true,
      identity: `ebay/${clientId}`,
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: 'ebay',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Field rules:
 *   - `EBAY_CLIENT_ID`: format-only. The id is required to attempt validation
 *     of the secret, so we defer the live check until the secret is entered.
 *     This mirrors the Rakuten OAuth2 wizard pattern.
 *   - `EBAY_CLIENT_SECRET`: writes the candidate into process.env alongside
 *     the already-entered client id, runs verifyAuth, restores both. Returns
 *     `ok: true` with the discovered identity on success.
 *   - `EBAY_CAMPAIGN_ID`: format-only (numeric). The campaign ID does not have
 *     a cheap "exists?" endpoint on EPN's API; we accept any positive
 *     integer and let the first real call surface a mismatch as an envelope.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EBAY_CLIENT_ID') {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(value)) {
      return {
        ok: false,
        message: 'eBay client IDs are at least 8 characters from [A-Za-z0-9_-].',
        hint:
          'Check the App ID (Client ID) at https://developer.ebay.com/my/keys. ' +
          'Copy the Production value — not the Sandbox value.',
      };
    }
    return {
      ok: true,
      message: 'Client ID format looks valid; will validate against eBay after the secret is entered.',
    };
  }

  if (field === 'EBAY_CLIENT_SECRET') {
    const previousSecret = process.env['EBAY_CLIENT_SECRET'];
    process.env['EBAY_CLIENT_SECRET'] = value;
    _resetTokenCache();
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'eBay credentials verified.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm both EBAY_CLIENT_ID and EBAY_CLIENT_SECRET come from the SAME Production application ' +
          'at https://developer.ebay.com/my/keys, and that the application is enrolled in the Partner Network.',
      };
    } finally {
      if (previousSecret === undefined) {
        delete process.env['EBAY_CLIENT_SECRET'];
      } else {
        process.env['EBAY_CLIENT_SECRET'] = previousSecret;
      }
      _resetTokenCache();
    }
  }

  if (field === 'EBAY_CAMPAIGN_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'eBay campaign IDs are positive integers.',
        hint:
          'Find your campaign ID at https://partnernetwork.ebay.com/ → Campaigns → the numeric column. ' +
          'If no campaign exists yet, create one before continuing.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for eBay.`,
    hint:
      'eBay expects EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID), and EBAY_CAMPAIGN_ID (numeric).',
  };
}
