/**
 * Tradedoubler auth + credential validation.
 *
 * Tradedoubler's modern publisher API (connect.tradedoubler.com) uses OAuth2
 * bearer tokens obtained via the Resource Owner Password Credentials (ROPC)
 * flow. This module handles token acquisition and caching.
 *
 * Required credentials:
 *   - TRADEDOUBLER_CLIENT_ID       — OAuth2 client ID from Tradedoubler dashboard
 *   - TRADEDOUBLER_CLIENT_SECRET   — OAuth2 client secret (shown only once on creation)
 *   - TRADEDOUBLER_USERNAME        — Tradedoubler account username / email
 *   - TRADEDOUBLER_PASSWORD        — Tradedoubler account password
 *   - TRADEDOUBLER_ORGANIZATION_ID — the publisher's numeric organisation ID
 *
 * Token endpoint:
 *   POST https://connect.tradedoubler.com/uaa/oauth/token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=password&username=<username>&password=<password>
 *
 * Auth check endpoint:
 *   GET /usermanagement/users/me
 *   → Returns current user details; 401 on a bad token.
 */

import { tradedoublerRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { TD_SLUG } from './endpoints/shared.js';

const log = createLogger('tradedoubler.auth');

const TD_TOKEN_URL = 'https://connect.tradedoubler.com/uaa/oauth/token';

interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

// In-process token cache — avoids a token request on every API call.
// Expires 55 minutes after acquisition (tokens are typically valid for 1 hour).
let cachedToken: string | undefined;
let cacheExpiresAt: number = 0;
const TOKEN_CACHE_TTL_MS = 55 * 60 * 1000;

/** Invalidate the in-process token cache (used in tests and on auth failure). */
export function _clearTokenCache(): void {
  cachedToken = undefined;
  cacheExpiresAt = 0;
}

/** Pre-seed the token cache with a known value — test use only. */
export function _seedTokenCache(token: string): void {
  cachedToken = token;
  cacheExpiresAt = Date.now() + TOKEN_CACHE_TTL_MS;
}

/**
 * Fetch a new bearer token from Tradedoubler's OAuth2 ROPC endpoint.
 * Throws `NetworkError` if credentials are missing or the request fails.
 */
export async function fetchOAuthToken(): Promise<string> {
  const clientId = requireCredential('TRADEDOUBLER_CLIENT_ID', {
    network: TD_SLUG,
    operation: 'fetchOAuthToken',
    hint:
      'Create an API client in the Tradedoubler dashboard → Tools → API Info → Clients. ' +
      'Set TRADEDOUBLER_CLIENT_ID in ~/.affiliate-mcp/.env.',
  });
  const clientSecret = requireCredential('TRADEDOUBLER_CLIENT_SECRET', {
    network: TD_SLUG,
    operation: 'fetchOAuthToken',
    hint:
      'The client secret is shown once when creating the API client in Tradedoubler dashboard. ' +
      'Set TRADEDOUBLER_CLIENT_SECRET in ~/.affiliate-mcp/.env.',
  });
  const username = requireCredential('TRADEDOUBLER_USERNAME', {
    network: TD_SLUG,
    operation: 'fetchOAuthToken',
    hint: 'Set TRADEDOUBLER_USERNAME to your Tradedoubler account email in ~/.affiliate-mcp/.env.',
  });
  const password = requireCredential('TRADEDOUBLER_PASSWORD', {
    network: TD_SLUG,
    operation: 'fetchOAuthToken',
    hint: 'Set TRADEDOUBLER_PASSWORD to your Tradedoubler account password in ~/.affiliate-mcp/.env.',
  });

  const basicCredential = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  /*const basicCredential = requireCredential('TRADEDOUBLER_HASHED_CLIENT', {
    network: TD_SLUG,
    operation: 'fetchOAuthToken',
    hint: 'Set TRADEDOUBLER_HASHED_CLIENT in ~/.affiliate-mcp/.env.',
  });*/
  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });

  const requestHeaders = {
    'Authorization': `Basic ${basicCredential}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const requestBody = body.toString();


  const res = await fetch(TD_TOKEN_URL, {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
  });
  const rawHeaders = JSON.stringify(requestHeaders);
  const rawBody = await res.text();

  // DEBUG — write response directly to stderr so it's visible even if Pino redacts it.
  process.stderr.write(
    JSON.stringify({
      debug: 'tradedoubler fetchOAuthToken response',
      httpStatus: res.status,
      rawBody,
    }) + '\n',
  );

  if (!res.ok) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: TD_SLUG,
        operation: 'fetchOAuthToken',
        httpStatus: res.status,
        networkErrorBody: rawBody,
        message: `Tradedoubler OAuth token request failed with HTTP ${res.status}: ${requestBody}|${basicCredential}|${requestHeaders}|${rawHeaders}`,
      }),
    );
  }

  let parsed: OAuthTokenResponse;
  try {
    parsed = JSON.parse(rawBody) as OAuthTokenResponse;
  } catch {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: TD_SLUG,
        operation: 'fetchOAuthToken',
        httpStatus: res.status,
        networkErrorBody: rawBody,
        message: 'Tradedoubler OAuth token endpoint returned non-JSON response.',
      }),
    );
  }

  if (!parsed.access_token) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: TD_SLUG,
        operation: 'fetchOAuthToken',
        networkErrorBody: rawBody,
        message: 'Tradedoubler OAuth token response did not include access_token.',
      }),
    );
  }

  return parsed.access_token;
}

/**
 * Return a valid bearer token, using the in-process cache when possible.
 * Fetches a fresh token if the cache is empty or expired.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cacheExpiresAt) {
    log.debug('tradedoubler getAccessToken: returning cached token');
    return cachedToken;
  }

  const token = await fetchOAuthToken();
  cachedToken = token;
  cacheExpiresAt = now + TOKEN_CACHE_TTL_MS;
  log.debug('tradedoubler getAccessToken: token acquired and cached');
  return token;
}

/**
 * Minimal shape of the /usermanagement/users/me response.
 */
interface TdUserMe {
  id?: number | string;
  email?: string;
  firstName?: string;
  lastName?: string;
  organisationId?: number | string;
  organizationId?: number | string;
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
 * Verify Tradedoubler credentials by obtaining an OAuth2 token and then calling
 * GET /usermanagement/users/me.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const user = await tradedoublerRequest<TdUserMe>({
      operation: 'verifyAuth',
      path: '/usermanagement/users/me',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const id = user.id ?? user.organisationId ?? user.organizationId;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '';
    const identity = name ? `tradedoubler/${id} (${name})` : `tradedoubler/${id ?? 'unknown'}`;

    log.debug({ id, name }, 'tradedoubler verifyAuth succeeded');

    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      // A 401 means the freshly-obtained token was rejected — clear the cache.
      _clearTokenCache();
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: TD_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * When all four OAuth credentials are present, performs a live token request.
 * TRADEDOUBLER_ORGANIZATION_ID: format check only (positive integer).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  const oauthFields = [
    'TRADEDOUBLER_CLIENT_ID',
    'TRADEDOUBLER_CLIENT_SECRET',
    'TRADEDOUBLER_USERNAME',
    'TRADEDOUBLER_PASSWORD',
  ] as const;

  if ((oauthFields as readonly string[]).includes(field)) {
    // Temporarily set the new value so fetchOAuthToken can read all four fields.
    const previous = process.env[field];
    process.env[field] = value;
    _clearTokenCache();

    try {
      // Only attempt a live check if all four credentials are present.
      const allPresent = oauthFields.every((f) => {
        const v = process.env[f];
        return v !== undefined && v.trim() !== '';
      });

      if (!allPresent) {
        // Can't validate in isolation — accept the value and defer the live
        // check to when all four fields have been entered.
        return { ok: true, message: 'Saved — full auth check will run once all credentials are set.' };
      }

      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check TRADEDOUBLER_CLIENT_ID, TRADEDOUBLER_CLIENT_SECRET, TRADEDOUBLER_USERNAME, and TRADEDOUBLER_PASSWORD.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = previous;
      }
      _clearTokenCache();
    }
  }

  if (field === 'TRADEDOUBLER_ORGANIZATION_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Tradedoubler organisation ID must be a positive integer.',
        hint:
          'Find your organisation ID in the Tradedoubler dashboard URL after login, or ' +
          'in Account → Organisation settings.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Tradedoubler.`,
    hint:
      'Tradedoubler expects TRADEDOUBLER_CLIENT_ID, TRADEDOUBLER_CLIENT_SECRET, ' +
      'TRADEDOUBLER_USERNAME, TRADEDOUBLER_PASSWORD, and TRADEDOUBLER_ORGANIZATION_ID.',
  };
}

/**
 * Read the current credential values without requiring them (used in setup
 * to offer a "skip" when the token has already been validated).
 */
export function getOrgId(): string | undefined {
  return getCredential('TRADEDOUBLER_ORGANIZATION_ID');
}
