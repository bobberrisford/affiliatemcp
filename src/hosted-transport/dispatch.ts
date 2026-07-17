/**
 * Pure/testable helpers for the hosted MCP transport's `tools/call` dispatch
 * (H4). The actual SDK-typed request handler lives in `mcp-server.ts`, kept
 * close to `src/server.ts`'s own handler so the two are easy to compare; this
 * module holds the hosted-only decisions that handler calls into: the
 * per-user rate-limit check and the vault-credential resolution.
 */

import type { NetworkErrorEnvelope, NetworkSlug } from '../shared/types.js';
import { buildErrorEnvelope } from '../shared/errors.js';
import { fetchVaultCredentials, VaultUnavailableError, type VaultCredentialRecord } from './vault-client.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';

/** Meta tools (`affiliate_list_networks`, etc.) never have vault-stored credentials — they are not
 * network adapters and `classifyToolForTelemetry` reports their network as `"meta"`. */
export const META_NETWORK = 'meta';

export type CredentialOverlayResult =
  | { ok: true; credentials: Record<string, string> }
  | { ok: false; envelope: NetworkErrorEnvelope };

/**
 * Resolve the request-context credential overlay for one tool call.
 *
 * - Meta tools, and any network the vault has nothing stored for, resolve to
 *   an EMPTY overlay — `{}` — never a fabricated or partial credential. An
 *   empty overlay makes `getCredential`/`requireCredential`
 *   (`src/shared/config.ts`) fall through to `process.env` (empty on this
 *   process by design: no local credentials live here) and throw the SAME
 *   `config_error` envelope a local, unconfigured install would. That is the
 *   "existing unconfigured-credential guidance envelope" the workstream brief
 *   asks for — this function deliberately does nothing special to produce it.
 * - A vault reachability failure is NOT the same fact as "not connected" and
 *   must not be reported as one; it surfaces as its own `network_unavailable`
 *   envelope instead.
 */
export async function resolveCredentialOverlay(
  network: NetworkSlug,
  operation: string,
  bearerToken: string,
  vaultUrl: string,
): Promise<CredentialOverlayResult> {
  if (network === META_NETWORK) return { ok: true, credentials: {} };

  let record: VaultCredentialRecord | null;
  try {
    record = await fetchVaultCredentials(network, bearerToken, vaultUrl);
  } catch (err) {
    const message =
      err instanceof VaultUnavailableError
        ? err.message
        : `unexpected error reading the hosted vault: ${(err as Error).message}`;
    return {
      ok: false,
      envelope: buildErrorEnvelope({
        type: 'network_unavailable',
        network,
        operation,
        message: `Could not read stored credentials from the hosted vault: ${message}`,
        hint: 'This is a hosted-transport/vault connectivity problem, not a credential or network API error. Retry shortly.',
      }),
    };
  }
  return { ok: true, credentials: record ?? {} };
}

/**
 * Per-user token-bucket check for one tool call. Returns `undefined` when the
 * call is within the user's limit, or a ready-to-return `rate_limit` envelope
 * when it is not — an honest MCP tool result (`isError: true` with this
 * envelope as content), never an HTTP 429 or a thrown transport error, per
 * the brief's "structured 429-style MCP error result".
 */
export function checkRateLimit(
  limiter: TokenBucketRateLimiter,
  userId: string,
  network: NetworkSlug,
  operation: string,
): NetworkErrorEnvelope | undefined {
  if (limiter.consume(userId)) return undefined;
  return buildErrorEnvelope({
    type: 'rate_limit',
    network,
    operation,
    message: 'Hosted per-user rate limit exceeded for this account. Wait and retry.',
    hint: 'Limits are per-user and refill continuously; a brief pause is normally enough.',
  });
}
