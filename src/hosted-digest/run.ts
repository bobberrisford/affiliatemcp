/**
 * Per-user digest composition (workstream slice H6, redesigned per Rob's
 * 2026-07-14 decision — see `hosted/README.md`, "Digest orchestration and
 * token scopes"). The ORCHESTRATION (who to run for, when, which digest
 * types, and the email send) lives in the hosted Worker's scheduled handler
 * (`hosted/src/digest.ts`); this module composes ONE user's digest text
 * when asked, using the caller-supplied, digest-scoped, per-user session
 * token against the hosted Worker's existing vault list/reveal routes,
 * exactly as the hosted MCP transport uses them — this is a second caller
 * of the H1 seam and H4 vault-client, not a parallel reimplementation.
 *
 * This module never sees an email address, never enumerates users, and
 * holds no credential of its own: everything it can read is bounded by the
 * one token the caller presented, for the one user that token names, for
 * the few minutes it lives.
 *
 * Never logs digest contents. One stderr line per compose request lives in
 * `server.ts` (userId, digestType, timestamp, outcome) — the same
 * "never payloads" audit contract as `src/hosted-transport/audit.ts`.
 */

import type { NetworkSlug } from '../shared/types.js';
import { getAdapter } from '../shared/registry.js';
import { runInRequestContext } from '../shared/request-context.js';
import { resolveCredentialOverlay } from '../hosted-transport/dispatch.js';
import { listConnectedNetworks } from '../hosted-transport/vault-client.js';

// Side-effect import: registers every network adapter with the shared registry, matching
// `mcp-server.ts`'s own import — this service calls adapters directly, so it needs the same
// registration, not just the tool-generation layer.
import '../networks/index.js';

import {
  composeEarningsDigest,
  composeUnpaidCommissionsDigest,
  type ComposedDigest,
  type DigestType,
  type NetworkEarningsResult,
} from './compose.js';

const DIGEST_WINDOW_DAYS = 7;

function weekPeriod(): { from: string; to: string; label: string } {
  const to = new Date();
  const from = new Date(to.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().split('T')[0] as string;
  return { from: from.toISOString(), to: to.toISOString(), label: `${iso(from)} to ${iso(to)}` };
}

/** Read one network's `EarningsSummary` under the given user's identity, using the caller's own
 * digest-scoped token for the vault read — never invents a result on failure. */
async function readNetworkEarnings(
  userId: string,
  network: NetworkSlug,
  bearerToken: string,
  vaultUrl: string,
  period: { from: string; to: string },
): Promise<NetworkEarningsResult> {
  const overlay = await resolveCredentialOverlay(network, 'hosted_digest_earnings', bearerToken, vaultUrl);
  if (!overlay.ok) {
    return { network, ok: false, message: overlay.envelope.message };
  }
  const adapter = getAdapter(network);
  if (!adapter) {
    return { network, ok: false, message: `no adapter is registered for network "${network}"` };
  }
  try {
    const summary = await runInRequestContext({ identity: userId, credentials: overlay.credentials }, () =>
      adapter.getEarningsSummary({ from: period.from, to: period.to }),
    );
    return { network, ok: true, summary };
  } catch (err) {
    return { network, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Compose one digest for one user: list their connected networks (with the
 * caller's token, via the vault), read each network's earnings through the
 * H1 seam, and render the requested digest type. Throws
 * `VaultUnavailableError` when the vault itself cannot be reached or
 * rejects the token — `server.ts` maps that to an honest HTTP status
 * rather than an empty digest.
 */
export async function composeDigestForUser(
  vaultUrl: string,
  userId: string,
  digestType: DigestType,
  bearerToken: string,
): Promise<ComposedDigest> {
  const period = weekPeriod();
  const networks = await listConnectedNetworks(bearerToken, vaultUrl);

  const results: NetworkEarningsResult[] = [];
  for (const network of networks) {
    results.push(await readNetworkEarnings(userId, network, bearerToken, vaultUrl, period));
  }

  return digestType === 'unpaid-commissions'
    ? composeUnpaidCommissionsDigest(results, period.label)
    : composeEarningsDigest(results, period.label);
}
