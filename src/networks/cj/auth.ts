/**
 * CJ Affiliate auth + credential validation.
 *
 * CJ uses a Personal Access Token (PAT). The publisher creates it from
 * Account → Personal Access Tokens in the CJ dashboard; the token is
 * long-lived (no auto-rotation) and is sent as `Authorization: Bearer ...`
 * on every API call.
 *
 * --- The `derivedValues` pattern --------------------------------------------
 *
 * Most CJ GraphQL queries (commissions, transactions) require the publisher's
 * `companyId` as a variable. Asking the user to look that up manually is
 * friction; many publishers don't even know they have one. We bootstrap it:
 *
 *     1. User enters CJ_API_TOKEN.
 *     2. Wizard calls `verifyAuth()`.
 *     3. `verifyAuth()` runs `{ me { id companyId ... } }` against the
 *        commissions GraphQL endpoint, extracts `companyId`, returns it
 *        under `derivedValues.CJ_COMPANY_ID`.
 *     4. Wizard persists both credentials; the CJ_COMPANY_ID step becomes
 *        "auto-derived; press enter to accept".
 *
 * This is the canonical example of `derivedValues` in action — the same
 * pattern is documented in `src/networks/awin/auth.ts` for the Awin
 * `publisherId`.
 *
 * --- Why the `{ me }` query specifically ------------------------------------
 *
 *   - It's the smallest authenticated call CJ exposes.
 *   - It returns the company / publisher identity AND the companyId, so the
 *     same call powers auth validation AND derivation.
 *   - On a bad token CJ returns 401 (not a generic 5xx), so the resilience
 *     layer classifies it as `auth_error` and the error envelope is
 *     immediately actionable.
 *
 * If a future CJ schema change renames the `me` query (it has been stable
 * since CJ's GraphQL launch, but worth tracking), this is the only file that
 * needs to change.
 *
 * Future contributors: keep `verifyAuth` cheap. The setup wizard runs it
 * interactively; latency here is user-visible. `{ me }` is sub-second in
 * practice, well inside the 30s default timeout.
 */

import { cjGraphQL, CJ_GRAPHQL_COMMISSIONS } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('cj.auth');

/**
 * Minimal shape we read from the `{ me }` GraphQL response. CJ has been
 * known to add fields here over time; we read defensively.
 */
interface CjMe {
  id?: string;
  companyId?: string;
  // Some tenants nest the identity under a `company` object.
  company?: { id?: string; name?: string };
  // Newer schemas surface a human name on `me` directly.
  name?: string;
  email?: string;
}

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  derivedValues?: { CJ_COMPANY_ID?: string };
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify the CJ token via a minimal `{ me }` GraphQL query.
 *
 * On success we extract the `companyId` and return it as a derived value so
 * the setup wizard can skip the follow-up prompt.
 *
 * The query is deliberately tiny — fewer fields means fewer schema-drift
 * surprises if CJ changes a leaf node. We tolerate missing optional fields
 * defensively; the only field that genuinely matters is `companyId`, and even
 * that is graceful: a token with no derivable company still returns
 * `ok: true` so the user can see "auth worked but no company on token".
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('CJ_API_TOKEN', {
      network: 'cj',
      operation: 'verifyAuth',
      hint:
        'Generate a Personal Access Token in the CJ dashboard → Account → Personal Access Tokens.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const data = await cjGraphQL<{ me?: CjMe }>({
      operation: 'verifyAuth',
      endpoint: CJ_GRAPHQL_COMMISSIONS,
      // Keep the query tiny: companyId is what `derivedValues` needs; id +
      // name carry the human-readable identity. If a field is absent in a
      // particular tenant's schema, GraphQL returns it as null — fine.
      query: 'query { me { id companyId name email company { id name } } }',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const me = data?.me;
    const preferred = pickCompanyId(me);

    log.debug({ companyId: preferred }, 'cj verifyAuth succeeded');

    return {
      ok: true,
      identity: identityFor(me),
      derivedValues: preferred ? { CJ_COMPANY_ID: preferred } : undefined,
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'cj',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Resolve the companyId we will use for subsequent calls. Priority order:
 *   1. CJ_COMPANY_ID already in env — respect operator intent.
 *   2. `me.companyId` from the GraphQL response.
 *   3. `me.company.id` (alternative shape in some tenants).
 *   4. Undefined — means "no derivation possible".
 */
function pickCompanyId(me?: CjMe): string | undefined {
  const existing = getCredential('CJ_COMPANY_ID');
  if (existing) return existing;
  if (!me) return undefined;
  if (me.companyId) return String(me.companyId);
  if (me.company?.id) return String(me.company.id);
  return undefined;
}

function identityFor(me: CjMe | undefined): string {
  if (!me) return 'cj (no me payload)';
  const companyId = me.companyId ?? me.company?.id ?? 'unknown';
  const display = me.name ?? me.company?.name ?? me.email ?? '';
  return display ? `cj/${companyId} (${display})` : `cj/${companyId}`;
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * - `CJ_API_TOKEN`: writes the candidate into `process.env`, runs
 *   `verifyAuth()`, restores the previous value. Returns `ok` on success
 *   with the discovered identity in `message`.
 * - `CJ_COMPANY_ID`: format check (CJ company IDs are numeric strings; we
 *   accept any digits-only value of reasonable length). We do NOT verify
 *   via API because doing so requires a valid token and the user may edit
 *   this field in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'CJ_API_TOKEN') {
    const previous = process.env['CJ_API_TOKEN'];
    process.env['CJ_API_TOKEN'] = value;
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
          'Check the token at the CJ dashboard → Account → Personal Access Tokens. The token may be revoked, expired, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['CJ_API_TOKEN'];
      } else {
        process.env['CJ_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'CJ_COMPANY_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'CJ company ID must be a positive integer (digits only).',
        hint:
          'You can find your company ID in the CJ dashboard, or let the setup wizard derive it from your token.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for CJ.`,
    hint: 'CJ expects CJ_API_TOKEN (required) and CJ_COMPANY_ID (auto-derived from the token).',
  };
}
