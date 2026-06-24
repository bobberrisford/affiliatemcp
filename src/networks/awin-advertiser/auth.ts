/**
 * Awin advertiser auth.
 *
 * Awin issues long-lived OAuth 2.0 bearer tokens from the publisher / advertiser
 * dashboard (Toolbox → API Credentials). The token is USER-scoped: one token
 * addresses every Awin account the underlying user is linked to — publisher
 * accounts AND advertiser accounts. Concrete consequence: the same token the
 * publisher adapter (`src/networks/awin/`) uses can power this adapter too.
 * The wizard surfaces that fact (see `./setup.ts`) but does not auto-copy.
 *
 * Awin's auth check endpoint is `GET /accounts`. The response is a flat list of
 * `{ accountId, accountName, accountType, userRole, ... }`. The account kind is
 * carried on `accountType` (`"advertiser"`/`"publisher"`) on the live API; we
 * read `accountType` first and fall back to `type` for aliased payloads, then
 * filter on that in `listBrands` (see `./adapter.ts`).
 *
 * Cardinal: never call `fetch` from this module. Auth verification goes via
 * `awinAdvRequest` from `./client.ts` so the read-only guard AND the 20-per-
 * minute token bucket always apply.
 */

import { awinAdvRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('awin-advertiser.auth');

export const SLUG = 'awin-advertiser';

/**
 * Build the Authorization header value for an Awin OAuth bearer token. We keep
 * this trivial helper so client.ts never has to know how Awin formats creds —
 * if Awin moves to a rotating-token flow, this is the only file that changes.
 */
export function bearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Minimal shape we read off `GET /accounts`. Awin returns an array of accounts.
 * We intentionally do NOT over-specify the schema here — the adapter's
 * transformer (see `./adapter.ts`) reads multiple field aliases defensively.
 */
export interface AwinAdvAccountRaw {
  accountId?: number | string;
  /** Some tenants surface `id` instead of `accountId`. */
  id?: number | string;
  accountName?: string;
  name?: string;
  /**
   * Live `/accounts` returns the account kind on `accountType` (e.g.
   * "advertiser"/"publisher"), not `type`. We read `accountType` first and fall
   * back to `type` for older/aliased payloads; reading `type` alone silently
   * filtered out every advertiser account.
   */
  accountType?: string;
  type?: string;
  /**
   * Live `/accounts` also returns a per-account `userRole`. Captured for
   * future tier/permission heuristics; not yet used to flip `apiEnabled`.
   */
  userRole?: string;
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
 * Verify an Awin advertiser token by hitting `GET /accounts`. The same
 * endpoint powers `listBrands` — we make the call here purely to confirm the
 * token authenticates.
 *
 * - Valid token, no advertiser accounts on it → 200 with an empty filter. We
 *   still return `ok: true` so the user sees "auth worked, no brands" rather
 *   than a confusing failure.
 * - Invalid token → Awin returns 401, which the client surfaces verbatim.
 * - 20-call-per-minute rate limit → the client's token bucket queues the
 *   call rather than failing fast (so this verification can take a moment if
 *   the user just blew the budget; preferable to a flapping wizard).
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('AWIN_ADVERTISER_API_TOKEN', {
      network: SLUG,
      operation: 'verifyAuth',
      hint:
        'Generate an OAuth token at the Awin dashboard → Toolbox → API Credentials. ' +
        'The token is user-scoped — if you already have AWIN_API_TOKEN configured for the ' +
        'publisher adapter, the same token usually works here too.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const accounts = await awinAdvRequest<AwinAdvAccountRaw[] | { accounts?: AwinAdvAccountRaw[] }>({
      operation: 'verifyAuth',
      path: '/accounts',
      token,
      resilience: DEFAULT_RESILIENCE,
    });
    const list: AwinAdvAccountRaw[] = Array.isArray(accounts)
      ? accounts
      : Array.isArray((accounts as { accounts?: AwinAdvAccountRaw[] }).accounts)
        ? ((accounts as { accounts: AwinAdvAccountRaw[] }).accounts)
        : [];
    const advertiserCount = list.filter(
      (a) => normaliseType(a.accountType ?? a.type) === 'advertiser',
    ).length;
    log.debug(
      { totalAccounts: list.length, advertiserCount },
      'awin-advertiser verifyAuth succeeded',
    );
    return {
      ok: true,
      identity:
        advertiserCount > 0
          ? `awin-advertiser/${advertiserCount}-advertiser-account${advertiserCount === 1 ? '' : 's'}`
          : 'awin-advertiser/no-advertiser-accounts',
    };
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

/**
 * Validate one credential field at wizard-entry time. Awin advertiser only
 * has one credential — the OAuth token. The validator writes the candidate
 * into `process.env`, runs `verifyAuth()`, restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AWIN_ADVERTISER_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Awin advertiser OAuth token is required.',
        hint:
          'Generate the token at the Awin dashboard → Toolbox → API Credentials. The same ' +
          'user-scoped token usually works for both the publisher and the advertiser surfaces.',
      };
    }
    const previous = process.env['AWIN_ADVERTISER_API_TOKEN'];
    process.env['AWIN_ADVERTISER_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity
            ? `Token verified against Awin /accounts (${result.identity}).`
            : 'Token verified.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token at the Awin dashboard → Toolbox → API Credentials. The token may be ' +
          'revoked, expired, or copied with leading/trailing whitespace. Note: Awin enforces a ' +
          '20-call-per-minute rate limit; back off and retry if you see 429 responses.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['AWIN_ADVERTISER_API_TOKEN'];
      } else {
        process.env['AWIN_ADVERTISER_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Awin advertiser.`,
    hint: 'Awin advertiser expects AWIN_ADVERTISER_API_TOKEN.',
  };
}

/**
 * Normalise Awin's `type` field. Awin returns "advertiser" / "publisher" in
 * lowercase on current tenants but we lower-case defensively in case a future
 * schema returns Title case.
 */
export function normaliseType(t: string | undefined): 'advertiser' | 'publisher' | 'unknown' {
  const s = String(t ?? '').toLowerCase();
  if (s === 'advertiser') return 'advertiser';
  if (s === 'publisher') return 'publisher';
  return 'unknown';
}

/**
 * Helper for the wizard: read the publisher Awin token if it exists. The setup
 * step surfaces the value (without copying) so the user can confirm-and-reuse.
 */
export function getPublisherToken(): string | undefined {
  return getCredential('AWIN_API_TOKEN');
}
