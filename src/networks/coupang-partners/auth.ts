/**
 * Coupang Partners HMAC signing + credential validation.
 *
 * Coupang Partners (Korea) uses an HMAC-SHA256 request-signing scheme rather
 * than a bearer token. The publisher self-issues an Access Key + Secret Key
 * pair from the Coupang Partners dashboard (쿠팡 파트너스 → 도구 → 오픈 API; the
 * API menu is available once the account is approved and has reached the
 * minimum sales threshold to unlock Open API access).
 *
 * Authorization header format (verified — see CEA scheme below):
 *
 *   Authorization: CEA algorithm=HmacSHA256, access-key={accessKey},
 *                  signed-date={signedDate}, signature={signatureHex}
 *
 * The signature is computed PER REQUEST over the message:
 *
 *   message = signedDate + METHOD + path + query
 *
 * where:
 *   - signedDate is the request time in GMT formatted `yyMMdd'T'HHmmss'Z'`
 *     (e.g. `260604T091500Z`).
 *   - METHOD is the upper-case HTTP method (`GET`, `POST`, ...).
 *   - path is the request path WITHOUT the leading scheme/host and WITHOUT the
 *     `?` (e.g. `/v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission`).
 *   - query is the raw query string WITHOUT the leading `?` (empty string when
 *     there is no query).
 *   - signature is the lowercase hex HMAC-SHA256 of `message` keyed by the
 *     Secret Key.
 *
 * Sources (verified 2026-06-04):
 *   - Coupang Partners "Create HMAC Signature":
 *     https://partner-developers.coupangcorp.com/hc/en-us/articles/360053719371-Create-HMAC-Signature
 *   - Working public reference implementation (commission report):
 *     https://github.com/nicecoding1/python_example/blob/main/coupang_commission.py
 *   - Public Python wrapper covering deeplink + product endpoints:
 *     https://github.com/JEJEMEME/PCoupangAPI
 *
 * Because the credentials are signing keys (not a token that can be exchanged),
 * there is no module-level token cache here — each request is signed afresh.
 * `verifyAuth()` therefore makes the cheapest real signed call we have (a
 * 1-day reports/commission window) and reports whether the signature was
 * accepted.
 */

import { createHmac } from 'node:crypto';

import { coupangRequest, REPORTS_COMMISSION_PATH } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('coupang-partners.auth');

const SLUG = 'coupang-partners';

export const ACCESS_KEY_FIELD = 'COUPANG_PARTNERS_ACCESS_KEY';
export const SECRET_KEY_FIELD = 'COUPANG_PARTNERS_SECRET_KEY';

// ---------------------------------------------------------------------------
// HMAC signing — the load-bearing, deterministic core of this adapter.
// ---------------------------------------------------------------------------

/**
 * Format a Date as Coupang's `signed-date` string: `yyMMdd'T'HHmmss'Z'` in GMT.
 *
 * Example: 2026-06-04T09:15:00Z → `260604T091500Z`.
 *
 * Deterministic given the input Date — tests inject a fixed clock so the
 * produced signature is reproducible.
 */
export function formatSignedDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yy = pad(now.getUTCFullYear() % 100);
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const min = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${yy}${mm}${dd}T${hh}${min}${ss}Z`;
}

export interface HmacInput {
  method: string;
  /** Path WITHOUT scheme/host and WITHOUT the `?` (e.g. `/v2/.../commission`). */
  path: string;
  /** Raw query string WITHOUT the leading `?`. Empty string when no query. */
  query: string;
  accessKey: string;
  secretKey: string;
  /** Injectable clock so the produced header is deterministic in tests. */
  now?: Date;
  /** Override the signed-date directly (tests). Takes precedence over `now`. */
  signedDate?: string;
}

/**
 * Build the full `Authorization` header value for a Coupang Partners request.
 *
 * The signed message is `signedDate + METHOD + path + query`. The signature is
 * the lowercase hex HMAC-SHA256 of that message keyed by the Secret Key.
 *
 * Returns both the header value and the `signedDate` actually used so callers
 * (and tests) can assert on it.
 */
export function buildAuthorizationHeader(input: HmacInput): {
  authorization: string;
  signedDate: string;
} {
  const method = input.method.toUpperCase();
  const signedDate = input.signedDate ?? formatSignedDate(input.now ?? new Date());
  const message = `${signedDate}${method}${input.path}${input.query}`;
  const signature = createHmac('sha256', input.secretKey).update(message).digest('hex');
  const authorization = `CEA algorithm=HmacSHA256, access-key=${input.accessKey}, signed-date=${signedDate}, signature=${signature}`;
  return { authorization, signedDate };
}

// ---------------------------------------------------------------------------
// Credential accessors
// ---------------------------------------------------------------------------

export function requireAccessKey(operation: string): string {
  return requireCredential(ACCESS_KEY_FIELD, {
    network: SLUG,
    operation,
    hint:
      'Set COUPANG_PARTNERS_ACCESS_KEY in ~/.affiliate-mcp/.env. ' +
      'Issue it yourself in the Coupang Partners dashboard under 도구(Tools) → 오픈 API (Open API).',
  });
}

export function requireSecretKey(operation: string): string {
  return requireCredential(SECRET_KEY_FIELD, {
    network: SLUG,
    operation,
    hint:
      'Set COUPANG_PARTNERS_SECRET_KEY in ~/.affiliate-mcp/.env. ' +
      'It is shown alongside the Access Key in the Coupang Partners dashboard under 도구(Tools) → 오픈 API (Open API).',
  });
}

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

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
 * Verify the Coupang Partners credentials by making the cheapest real signed
 * call we have: a single-day `reports/commission` window.
 *
 * Why this call: Coupang Partners does not expose a `/me`-style identity
 * endpoint. A signed reports call that returns 200 proves the Access Key +
 * Secret Key sign correctly and are authorised; a 401/403 proves they are not.
 *
 * Never throws — returns `{ ok: false }` on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let accessKey: string;
  let secretKey: string;
  try {
    accessKey = requireAccessKey('verifyAuth');
    secretKey = requireSecretKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  // Use a single day so the payload is small. Coupang expects YYYYMMDD.
  const day = formatYyyymmdd(new Date());

  try {
    await coupangRequest<unknown>({
      operation: 'verifyAuth',
      method: 'GET',
      path: REPORTS_COMMISSION_PATH,
      query: { startDate: day, endDate: day, page: 0 },
      accessKey,
      secretKey,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `coupang-partners/access-key:${redactKey(accessKey)}`;
    log.debug({ identity }, 'coupang-partners verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check COUPANG_PARTNERS_ACCESS_KEY and COUPANG_PARTNERS_SECRET_KEY in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

// ---------------------------------------------------------------------------
// Credential validation (wizard-entry)
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * - COUPANG_PARTNERS_ACCESS_KEY: format check only. Validating it alone
 *   requires the secret, so the live check is deferred to the secret step.
 * - COUPANG_PARTNERS_SECRET_KEY: writes the candidate into `process.env`, runs
 *   `verifyAuth()` (which signs a real call), then restores the previous value.
 *   If the Access Key is not yet set, returns a format-only pass with a hint.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === ACCESS_KEY_FIELD) {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Coupang Partners Access Key must not be empty.',
        hint: 'Issue it in the Coupang Partners dashboard under 도구(Tools) → 오픈 API (Open API).',
      };
    }
    return {
      ok: true,
      message: 'Access Key format OK; will validate against the API after the Secret Key is entered.',
    };
  }

  if (field === SECRET_KEY_FIELD) {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Coupang Partners Secret Key must not be empty.',
        hint: 'It is shown alongside the Access Key under 도구(Tools) → 오픈 API (Open API).',
      };
    }
    const accessKey = getCredential(ACCESS_KEY_FIELD);
    if (!accessKey) {
      return {
        ok: true,
        message:
          'Secret Key format accepted; live validation deferred until the Access Key is set.',
      };
    }

    const previous = process.env[SECRET_KEY_FIELD];
    process.env[SECRET_KEY_FIELD] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Coupang Partners API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check both keys at the Coupang Partners dashboard → 도구(Tools) → 오픈 API. ' +
          'A rejected signature usually means the Secret Key is wrong or the keys belong to different accounts.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[SECRET_KEY_FIELD];
      } else {
        process.env[SECRET_KEY_FIELD] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Coupang Partners.`,
    hint: `Coupang Partners expects ${ACCESS_KEY_FIELD} and ${SECRET_KEY_FIELD}.`,
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Coupang report endpoints take dates as `YYYYMMDD` (no separators). */
export function formatYyyymmdd(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function redactKey(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

void log;
