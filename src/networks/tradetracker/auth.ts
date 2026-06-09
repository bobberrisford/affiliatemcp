/**
 * TradeTracker auth + session management + credential validation.
 *
 * TradeTracker's affiliate SOAP service is session-based, not token-based:
 *
 *   1. `authenticate(customerID, passphrase, sandbox, locale, demo)` opens a
 *      server-side session and returns a `Set-Cookie` (a PHP-style session id).
 *   2. Every subsequent call replays that cookie on the `Cookie` header.
 *   3. The session expires server-side after a period of inactivity; when a
 *      call comes back unauthenticated we re-authenticate transparently.
 *
 * Credentials (from `~/.affiliate-mcp/.env`):
 *   - `TRADETRACKER_CUSTOMER_ID` — the customer ID from Account → Web Services.
 *   - `TRADETRACKER_PASSPHRASE`  — the API passphrase from the same screen.
 *   - `TRADETRACKER_SITE_ID`     — the affiliate site ID most affiliate calls
 *     require (getCampaigns, getConversionTransactions, getClickTransactions).
 *
 * --- Session caching ---------------------------------------------------------
 *
 * The session cookie is cached in module scope keyed by customer ID. The
 * adapter calls `getSession()` before every operation; it returns the cached
 * cookie or authenticates to obtain one. On an unauthenticated response the
 * adapter calls `invalidateSession()` and retries once (see `withSession`).
 *
 * Why module scope rather than the resilience layer: the cookie is shared state
 * the resilience layer knows nothing about; centralising it here keeps the
 * client.ts purely transport. Tests reset it via `_resetSessionForTests()`.
 *
 * Never throw from `verifyAuth` — it is invoked by error handlers. Failures are
 * returned as `{ ok: false, reason, envelope }`.
 */

import {
  tradeTrackerRequest,
  findFirst,
  childText,
  escapeXml,
} from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tradetracker.auth');

const SLUG = 'tradetracker';

/**
 * Default locale for the SOAP `authenticate` call. TradeTracker accepts a
 * POSIX-style locale (e.g. `en_GB`, `nl_NL`); we default to UK English because
 * the product is UK-English throughout. This affects only the locale of any
 * server-localised strings, not the data.
 */
export const DEFAULT_LOCALE = 'en_GB';

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

// ---------------------------------------------------------------------------
// Credential reads
// ---------------------------------------------------------------------------

export function requireCustomerId(operation: string): string {
  return requireCredential('TRADETRACKER_CUSTOMER_ID', {
    network: SLUG,
    operation,
    hint:
      'Find your customer ID in the TradeTracker affiliate dashboard under ' +
      'Account → Web Services. Set it as TRADETRACKER_CUSTOMER_ID.',
  });
}

export function requirePassphrase(operation: string): string {
  return requireCredential('TRADETRACKER_PASSPHRASE', {
    network: SLUG,
    operation,
    hint:
      'Find your API passphrase in the TradeTracker affiliate dashboard under ' +
      'Account → Web Services (alongside the customer ID). Set it as TRADETRACKER_PASSPHRASE.',
  });
}

export function requireSiteId(operation: string): string {
  return requireCredential('TRADETRACKER_SITE_ID', {
    network: SLUG,
    operation,
    hint:
      'Your affiliate site ID is shown in the TradeTracker dashboard under ' +
      'Affiliate Sites. Set it as TRADETRACKER_SITE_ID.',
  });
}

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

interface SessionCache {
  /** The cookie key the session was opened for (customer ID). */
  customerId: string;
  /** The `Cookie` header value to replay on subsequent calls. */
  cookie: string;
}

let cachedSession: SessionCache | undefined;

/** Test-only: clear the cached session so each test authenticates fresh. */
export function _resetSessionForTests(): void {
  cachedSession = undefined;
}

/**
 * Reduce a raw `Set-Cookie` header to the `name=value` pair we replay. We send
 * only the first cookie pair (the session id); attributes such as `path` and
 * `HttpOnly` are not part of the `Cookie` request header.
 */
export function cookieFromSetCookie(setCookie: string): string {
  const first = setCookie.split(',')[0] ?? setCookie;
  const pair = first.split(';')[0] ?? first;
  return pair.trim();
}

/**
 * Authenticate against TradeTracker and cache the resulting session cookie.
 *
 * Returns the cookie to replay. Throws a `NetworkError` (config_error for
 * missing credentials, network_api_error otherwise) on failure so callers can
 * surface a populated envelope.
 */
export async function authenticate(operation: string): Promise<string> {
  const customerId = requireCustomerId(operation);
  const passphrase = requirePassphrase(operation);

  const bodyXml =
    `<customerID>${escapeXml(customerId)}</customerID>` +
    `<passphrase>${escapeXml(passphrase)}</passphrase>` +
    `<sandbox>false</sandbox>` +
    `<locale>${escapeXml(DEFAULT_LOCALE)}</locale>` +
    `<demo>false</demo>`;

  const { setCookie } = await tradeTrackerRequest({
    operation,
    method: 'authenticate',
    bodyXml,
    resilience: DEFAULT_RESILIENCE,
  });

  if (!setCookie) {
    // Authentication that returns no session cookie is unusable — surface it
    // rather than caching an empty session that fails every later call.
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation,
        message:
          'TradeTracker authenticate did not return a session cookie; the customer ID or passphrase is likely incorrect.',
        hint: 'Re-check TRADETRACKER_CUSTOMER_ID and TRADETRACKER_PASSPHRASE in Account → Web Services.',
      }),
    );
  }

  const cookie = cookieFromSetCookie(setCookie);
  cachedSession = { customerId, cookie };
  log.debug({ customerId }, 'tradetracker authenticated; session cached');
  return cookie;
}

/**
 * Return a usable session cookie, authenticating if the cache is empty or
 * belongs to a different customer ID. Operations call this before each request.
 */
export async function getSession(operation: string): Promise<string> {
  const customerId = requireCustomerId(operation);
  if (cachedSession && cachedSession.customerId === customerId) {
    return cachedSession.cookie;
  }
  return authenticate(operation);
}

/** Drop the cached session so the next `getSession` re-authenticates. */
export function invalidateSession(): void {
  cachedSession = undefined;
}

/**
 * Run `fn(cookie)` with a valid session, retrying once on an authentication
 * failure (expired session). The retry re-authenticates and replays the call;
 * any other error propagates unchanged.
 *
 * Detecting "session expired" without a documented marker: TradeTracker
 * surfaces an unauthenticated call as a SOAP fault whose message mentions the
 * session/authentication. We re-auth once when an error looks like that, then
 * give up so we never loop on a genuinely bad credential.
 */
export async function withSession<T>(
  operation: string,
  fn: (cookie: string) => Promise<T>,
): Promise<T> {
  const cookie = await getSession(operation);
  try {
    return await fn(cookie);
  } catch (err) {
    if (looksLikeSessionExpiry(err)) {
      log.debug({ operation }, 'tradetracker session expired; re-authenticating');
      invalidateSession();
      const fresh = await authenticate(operation);
      return fn(fresh);
    }
    throw err;
  }
}

function looksLikeSessionExpiry(err: unknown): boolean {
  if (!(err instanceof NetworkError)) return false;
  const msg = `${err.envelope.message} ${err.envelope.networkErrorBody ?? ''}`.toLowerCase();
  return (
    msg.includes('not authenticated') ||
    msg.includes('authentication') ||
    msg.includes('session') ||
    msg.includes('not logged in')
  );
}

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

/**
 * Verify the configured credentials by authenticating and reading back the
 * affiliate site list — the cheapest authenticated affiliate call that also
 * confirms the credentials address a real account.
 *
 * The identity string combines the customer ID with the first affiliate site
 * name, which is the most recognisable label for a TradeTracker affiliate.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let customerId: string;
  try {
    customerId = requireCustomerId('verifyAuth');
    requirePassphrase('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const cookie = await authenticate('verifyAuth');
    const { root } = await tradeTrackerRequest({
      operation: 'verifyAuth',
      method: 'getAffiliateSites',
      bodyXml: '',
      cookie,
      resilience: DEFAULT_RESILIENCE,
    });

    // Read the first affiliate site name for a friendly identity, if present.
    const firstSite = findFirst(root, 'affiliateSite');
    const siteName = firstSite ? childText(firstSite, 'name') : undefined;
    const identity = siteName
      ? `tradetracker/customer/${customerId} (${siteName})`
      : `tradetracker/customer/${customerId}`;

    log.debug({ identity }, 'tradetracker verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * TRADETRACKER_CUSTOMER_ID / TRADETRACKER_PASSPHRASE:
 *   When both are available, write the candidate into process.env and run
 *   verifyAuth(), restoring the prior value afterwards. Otherwise a presence
 *   check only (authenticate needs both the customer ID and the passphrase).
 *
 * TRADETRACKER_SITE_ID:
 *   Format check only — must be a positive integer. We cannot confirm it
 *   without the customer ID and passphrase, which may not be entered yet.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'TRADETRACKER_SITE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'TradeTracker affiliate site ID must be a positive integer.',
        hint: 'It is shown in the TradeTracker dashboard under Affiliate Sites.',
      };
    }
    return { ok: true };
  }

  if (field === 'TRADETRACKER_CUSTOMER_ID' || field === 'TRADETRACKER_PASSPHRASE') {
    const other =
      field === 'TRADETRACKER_CUSTOMER_ID' ? 'TRADETRACKER_PASSPHRASE' : 'TRADETRACKER_CUSTOMER_ID';
    const haveOther = getCredential(other) !== undefined;
    if (!haveOther) {
      if (value.trim() === '') {
        return { ok: false, message: `${field} must not be empty.` };
      }
      return {
        ok: true,
        message: `Recorded; will be verified once both ${field} and ${other} are set.`,
      };
    }

    const previous = process.env[field];
    process.env[field] = value;
    invalidateSession();
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the customer ID and passphrase in the TradeTracker dashboard under ' +
          'Account → Web Services. The passphrase can be regenerated there.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = previous;
      }
      invalidateSession();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for TradeTracker.`,
    hint: 'TradeTracker expects TRADETRACKER_CUSTOMER_ID, TRADETRACKER_PASSPHRASE, and TRADETRACKER_SITE_ID.',
  };
}
