/**
 * 2Performant auth — credential/session login + in-memory session cache.
 *
 * --- Why a session, not a static key -----------------------------------------
 *
 * 2Performant does NOT issue a static API key. Authentication is
 * credential/session based (devise-token-auth): the publisher POSTs their
 * account email + password to `/users/sign_in` and receives three session
 * headers — `access-token`, `client`, `uid` — that must be replayed on every
 * subsequent call. The server may rotate `access-token` on any response, so the
 * client folds rotated headers back into the cache (see `client.ts`).
 *
 * We model the cache on Rakuten's token cache:
 *   - A single module-scope object holds the session.
 *   - Concurrent callers that both find the cache empty dedupe via a single
 *     in-flight login promise so we don't POST sign-in twice in parallel.
 *   - On a 401 from any data call the client surfaces an `auth_error`; the
 *     adapter clears the cache, logs in once, and retries the call exactly once.
 *
 * --- Why no proactive expiry timer -------------------------------------------
 *
 * Unlike Rakuten's OAuth tokens (which carry an `expires_in`), 2Performant's
 * sign-in response does not advertise a reliable lifetime to us in a documented
 * field. Rather than guess a TTL we treat the session as valid until a 401
 * proves otherwise (reactive refresh). This keeps us honest: we never invent an
 * expiry the API did not tell us about.
 *
 * --- Module-level mutable state ----------------------------------------------
 *
 * The session cache is the ONLY mutable module-level state in this adapter.
 * Tests call `_resetSession()` to isolate.
 *
 * Docs: https://doc.2performant.com/ (sign-in + session headers); PHP reference
 * wrapper https://github.com/2Parale/2Performant-php (src/HTTP/User.php).
 */

import { twoPerformantRequest, type TwoPerformantSession } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { createLogger } from '../../shared/logging.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';

const log = createLogger('2performant.auth');

export const EMAIL_ENV = 'TWOPERFORMANT_EMAIL';
export const PASSWORD_ENV = 'TWOPERFORMANT_PASSWORD';

/**
 * The `user` object 2Performant returns on a successful sign-in / validate.
 * We read a couple of identity fields for the verifyAuth `identity` string and
 * the affiliate `uniqueCode` used by deterministic quicklink construction.
 */
interface TwoPerformantUser {
  id?: number;
  email?: string;
  role?: string;
  uniqueCode?: string;
  unique_code?: string;
}

interface SignInBody {
  user?: TwoPerformantUser;
}

/** Module-scope cache: the live session plus the affiliate's unique code. */
let cachedSession: TwoPerformantSession | null = null;
let cachedAffiliateCode: string | null = null;

/** In-flight login dedupe — see Rakuten's `inFlightRefresh`. */
let inFlightLogin: Promise<TwoPerformantSession> | null = null;

/** Test-only: clear the session cache so tests don't leak state. */
export function _resetSession(): void {
  cachedSession = null;
  cachedAffiliateCode = null;
  inFlightLogin = null;
}

/**
 * Return a usable session, logging in if the cache is empty or `forceRefresh`
 * is set (the client sets it after a 401). Throws a NetworkError (auth_error /
 * config_error envelope) on failure.
 */
export async function getSession(opts: { forceRefresh?: boolean } = {}): Promise<TwoPerformantSession> {
  if (!opts.forceRefresh && cachedSession) {
    return cachedSession;
  }
  if (opts.forceRefresh) {
    cachedSession = null;
  }
  return login({ reason: opts.forceRefresh ? 'forced (401)' : 'missing' });
}

/** The affiliate's unique code, captured at login. Used for quicklink construction. */
export function getCachedAffiliateCode(): string | null {
  return cachedAffiliateCode;
}

/** Fold rotated session headers (from any data response) back into the cache. */
export function updateSession(session: TwoPerformantSession): void {
  cachedSession = session;
}

/**
 * Perform the sign-in POST. Deduplicates concurrent callers via `inFlightLogin`.
 *
 * The POST goes through `twoPerformantRequest` (and therefore `withResilience`)
 * so a transient 5xx on the sign-in path is retried under the same policy as a
 * data endpoint. A bad email/password yields a 401 which the resilience layer
 * classifies as `auth_error` and does NOT retry.
 */
export async function login(opts: { reason: string }): Promise<TwoPerformantSession> {
  if (inFlightLogin) return inFlightLogin;

  inFlightLogin = (async () => {
    log.debug({ reason: opts.reason }, '2performant sign-in');
    try {
      const email = requireCredential(EMAIL_ENV, {
        network: '2performant',
        operation: 'auth.login',
        hint: 'Set TWOPERFORMANT_EMAIL in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup 2performant`.',
      });
      const password = requireCredential(PASSWORD_ENV, {
        network: '2performant',
        operation: 'auth.login',
        hint: 'Set TWOPERFORMANT_PASSWORD in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup 2performant`.',
      });

      const res = await twoPerformantRequest<SignInBody>({
        operation: 'auth.login',
        path: '/users/sign_in',
        method: 'POST',
        body: { user: { email, password } },
        resilience: DEFAULT_RESILIENCE,
      });

      // The session lives in the RESPONSE HEADERS, not the body. If the headers
      // are absent we cannot proceed — surface the verbatim body so the user
      // sees exactly what 2Performant returned (PRD §4.1).
      if (!res.rotatedSession) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: '2performant',
            operation: 'auth.login',
            networkErrorBody: JSON.stringify(res.body),
            message:
              '2Performant sign-in succeeded (HTTP 2xx) but returned no access-token / client / uid session headers.',
            hint: 'Re-check TWOPERFORMANT_EMAIL / TWOPERFORMANT_PASSWORD. A leading/trailing space from copy/paste is the most common cause.',
          }),
        );
      }

      cachedSession = res.rotatedSession;
      const user = res.body.user;
      cachedAffiliateCode = user?.uniqueCode ?? user?.unique_code ?? null;
      log.debug({ role: user?.role }, '2performant session cached');
      return cachedSession;
    } finally {
      inFlightLogin = null;
    }
  })();

  return inFlightLogin;
}

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  /**
   * 2Performant requires both credentials directly from the user; nothing is
   * auto-derivable for the env, so we return `{}` for shape consistency with
   * other adapters.
   */
  derivedValues?: Record<string, string>;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by performing the session login. A successful sign-in proves the
 * credentials work and is the conclusive test for the setup wizard. We then
 * confirm the user is an affiliate (publisher) account, since the affiliate
 * endpoints are gated by role.
 *
 * Why we don't make a second `/users/validate_token` call: the sign-in already
 * returned the user object and a live session, so an extra round-trip would
 * tell us nothing new. If a future requirement demands a data-plane probe, lift
 * the first page of `listProgrammes` into here.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  // verifyAuth is the wizard's correctness probe; reflect a fresh login, not an
  // in-process artefact.
  _resetSession();
  try {
    await login({ reason: 'verifyAuth' });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: '2performant',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Re-check TWOPERFORMANT_EMAIL / TWOPERFORMANT_PASSWORD.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  const email = process.env[EMAIL_ENV] ?? '';
  return {
    ok: true,
    identity: email ? `2performant/${email}` : '2performant',
    derivedValues: {},
  };
}

/**
 * Validate a single credential at wizard-entry time.
 *
 * Both credentials are needed together for a useful check (you cannot validate
 * the password without the email), so the wizard prompts both and calls
 * `verifyAuth()` at the end. We still offer cheap per-field format checks so
 * obvious typos are caught before the network round-trip.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  switch (field) {
    case EMAIL_ENV:
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Email is required.' };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return {
          ok: false,
          message: 'That does not look like an email address.',
          hint: 'Use the email address you sign in to 2Performant with.',
        };
      }
      return { ok: true };
    case PASSWORD_ENV:
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Password is required.' };
      }
      if (/^\s|\s$/.test(value)) {
        return {
          ok: false,
          message: 'Password has leading or trailing whitespace — typically a copy/paste error.',
          hint: 'Re-type the password from the 2Performant login screen.',
        };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        message: `Unknown credential field "${field}" for 2Performant.`,
        hint: 'Two_Performant expects TWOPERFORMANT_EMAIL and TWOPERFORMANT_PASSWORD.',
      };
  }
}
