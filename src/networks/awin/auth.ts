/**
 * Awin auth + credential validation.
 *
 * Awin uses a long-lived OAuth2 bearer token (the publisher generates it from
 * their dashboard; it does not auto-rotate). That means:
 *   - No refresh flow is required for v0.1 — we treat the token as a static
 *     secret loaded from `AWIN_API_TOKEN`. If Awin moves to rotating tokens,
 *     this is the only file that needs to change.
 *   - The auth-check endpoint is `GET /accounts?type=publisher`, which doubles as the source
 *     of the publisher ID (see `verifyAuth` below).
 *
 * --- The `derivedValues` pattern ---------------------------------------------
 *
 * Why this matters: affiliate networks often expose a single user-facing
 * credential (the token) but require additional identifiers for every actual
 * API call (publisher ID, account ID, etc.). Asking the user to look up those
 * identifiers manually is friction that derails setup; many publishers simply
 * don't know they have one.
 *
 * The `derivedValues` pattern lets the setup wizard skip those follow-up
 * prompts by extracting them from the auth-check response. Concretely:
 *
 *     1. User enters AWIN_API_TOKEN.
 *     2. Wizard calls `verifyAuth()`.
 *     3. `verifyAuth()` calls GET /accounts?type=publisher, finds the publisher ID, returns
 *        `{ ok: true, derivedValues: { AWIN_PUBLISHER_ID: '<id>' } }`.
 *     4. Wizard persists both credentials. The AWIN_PUBLISHER_ID step is shown
 *        as "auto-derived; press enter to accept" rather than a blank prompt.
 *
 * When this pattern applies to other networks:
 *   - CJ: token → companyId (GET /v3/publishers via GraphQL).
 *   - Impact: account SID + token → derived nothing (no auto-discovery).
 *   - Rakuten: account API → site IDs.
 *
 * Where the wizard consumes this: `src/cli/setup.ts` (Chunk 4 — does not exist
 * yet). The wizard reads `derivedValues` from the result of `verifyAuth()` and
 * stitches them into the persisted env. If the wizard isn't aware of the
 * field, the data is harmless — adapters fall back to a separate prompt.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible. Awin's `/accounts`
 * endpoint is small and fast, so a 30s timeout is plenty.
 */

import { awinRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('awin.auth');

/**
 * The minimal shape we read off Awin's `GET /accounts?type=publisher` response.
 * Awin returns an envelope with account rows. We also keep legacy publisher
 * field fallbacks so older fixtures or endpoint variants do not break
 * derivation. We do not over-specify the shape — see `client.ts` for the
 * rationale.
 */
interface AwinAccount {
  accountId?: number;
  accountName?: string;
  accountType?: string;
  userRole?: string;
  // Legacy / old-fixture fallbacks.
  publisherId?: number; // newer schema
  id?: number; // older schema fallback
  name?: string;
}

interface AwinAccountsEnvelope {
  userId?: number;
  accounts?: AwinAccount[];
}

/**
 * Successful verifyAuth result. `derivedValues` is the consumer hook described
 * in the file-level comment above.
 */
export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  derivedValues?: { AWIN_PUBLISHER_ID?: string };
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify the Awin token by hitting `GET /accounts?type=publisher`.
 *
 * Why this endpoint specifically:
 *   - It's the smallest authenticated call in the current Awin surface (returns
 *     one row per publisher account the token has access to).
 *   - It also returns the publisher ID, which downstream operations need —
 *     so the same call powers validation AND the derivedValues pattern.
 *   - It rejects with a clean 401 on a bad token (not a generic 5xx), so the
 *     error envelope is actionable.
 *
 * On success we attempt to derive `AWIN_PUBLISHER_ID` from the response. If
 * the response is empty (a token attached to no publisher accounts — rare but
 * possible), we still return `ok: true` so the user can see "auth worked but
 * no publishers" rather than a confusing failure.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  // requireCredential throws a NetworkError with a config_error envelope when
  // the token is missing. We surface it as a `VerifyAuthFail` so the wizard
  // can render the hint inline.
  let token: string;
  try {
    token = requireCredential('AWIN_API_TOKEN', {
      network: 'awin',
      operation: 'verifyAuth',
      hint: 'Generate a token at the Awin publisher dashboard → Account → API.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await awinRequest<AwinAccountsEnvelope | AwinAccount[]>({
      operation: 'verifyAuth',
      path: '/accounts',
      query: { type: 'publisher' },
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    // Awin returns an array. The user may have multiple publisher accounts on
    // a single token — in that case we prefer the env override (AWIN_PUBLISHER_ID
    // already set) and otherwise pick the first. We do NOT silently auto-pick
    // when there are multiple; we surface the choice in `derivedValues` so the
    // wizard can confirm.
    const list = normaliseAccountsResponse(response);
    const preferred = pickPublisherId(list);

    log.debug({ count: list.length, preferred }, 'awin verifyAuth succeeded');

    return {
      ok: true,
      identity: list.length > 0 ? identityFor(list[0]) : 'awin (no publisher accounts on token)',
      derivedValues: preferred ? { AWIN_PUBLISHER_ID: preferred } : undefined,
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'awin',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Build the publisher id we will use for subsequent calls. Priority order:
 *   1. Already set in env (`AWIN_PUBLISHER_ID`) — respect operator intent.
 *   2. The first publisher in the API response.
 *   3. Undefined — means "no derivation possible".
 *
 * Awin's response uses `publisherId` in newer schemas and `id`/`accountId`
 * in older ones; we accept either. A future Awin schema change becomes a
 * one-line addition here.
 */
function normaliseAccountsResponse(response: AwinAccountsEnvelope | AwinAccount[]): AwinAccount[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response.accounts) ? response.accounts : [];
}

function pickPublisherId(list: AwinAccount[]): string | undefined {
  const existing = getCredential('AWIN_PUBLISHER_ID');
  if (existing) return existing;
  const first = list.find((account) => account.accountType === 'publisher') ?? list[0];
  if (!first) return undefined;
  const id = first.publisherId ?? first.id ?? first.accountId;
  return id !== undefined ? String(id) : undefined;
}

function identityFor(p: AwinAccount | undefined): string {
  if (!p) return 'awin';
  const id = p.publisherId ?? p.id ?? p.accountId;
  const name = p.accountName ?? p.name ?? '';
  return name ? `awin/${id} (${name})` : `awin/${id ?? 'unknown'}`;
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Why per-field rather than a single "validate everything" call:
 *   - Live validation between prompts means typos are caught immediately —
 *     "your token is invalid" is dramatically more useful than "setup failed
 *     after you entered six fields".
 *   - Each field has a different kind of check. `AWIN_API_TOKEN` requires a
 *     network call. `AWIN_PUBLISHER_ID` only needs format validation (positive
 *     integer).
 *
 * Behaviour:
 *   - `AWIN_API_TOKEN`: writes the candidate into `process.env`, runs
 *     `verifyAuth()`, restores the previous value. Returns `ok` on success
 *     with the discovered publisher in `message`.
 *   - `AWIN_PUBLISHER_ID`: format check (positive integer string). We do not
 *     verify by API call because doing so requires a token and the user may be
 *     editing this field in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AWIN_API_TOKEN') {
    const previous = process.env['AWIN_API_TOKEN'];
    process.env['AWIN_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'token verified',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token at the Awin dashboard → Account → API. The token may be revoked, expired, or copied with leading/trailing whitespace.',
      };
    } finally {
      // Restore the previous value so a failed validation doesn't poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['AWIN_API_TOKEN'];
      } else {
        process.env['AWIN_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'AWIN_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Awin publisher ID must be a positive integer.',
        hint: 'You can find your publisher ID in the Awin dashboard URL after login.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Awin.`,
    hint: 'Awin expects AWIN_API_TOKEN (required) and AWIN_PUBLISHER_ID (optional, auto-derived).',
  };
}
