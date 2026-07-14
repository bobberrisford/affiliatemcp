/**
 * Vault client for the hosted MCP transport (H4).
 *
 * Reads one network's decrypted credential record from the hosted Worker's
 * vault (`hosted/src/vault.ts`, H3) over HTTP, for exactly the user who owns
 * the request.
 *
 * Auth choice — reuse the caller's own session token, never a service key:
 * this call presents the SAME `Authorization: Bearer <amcps_…>` header the
 * MCP client sent to reach this transport in the first place. The vault route
 * behind it (`GET /vault/credentials/:network/reveal`, `hosted/src/routes/vault.ts`)
 * runs the identical `requireSession` guard every other vault route uses, so
 * it can only ever return the credentials of the token's own owner — there is
 * no service-level credential or elevated scope that could read a different
 * user's vault. This is what keeps "serves only that user's own requests"
 * true end to end, not just at this transport's own auth check.
 */

const NETWORK_SLUG_RE = /^[a-z0-9-]{1,64}$/;

export type VaultCredentialRecord = Record<string, string>;

/**
 * Fetch one network's decrypted credentials for the caller identified by
 * `bearerToken`. Returns `null` when the user has not connected that network
 * (the vault has nothing to reveal) — callers must treat that as "no
 * credential configured", never as an error, and never invent a substitute.
 * Throws `VaultUnavailableError` when the vault Worker itself could not be
 * reached or returned something other than a clean hit/miss (so a transport
 * outage is never silently swallowed into "not connected").
 */
export async function fetchVaultCredentials(
  network: string,
  bearerToken: string,
  vaultUrl: string,
): Promise<VaultCredentialRecord | null> {
  if (!NETWORK_SLUG_RE.test(network)) return null; // meta tools and malformed slugs never have vault entries

  let res: Response;
  try {
    res = await fetch(`${vaultUrl}/vault/credentials/${encodeURIComponent(network)}/reveal`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  } catch (err) {
    throw new VaultUnavailableError(`could not reach the hosted vault: ${(err as Error).message}`);
  }

  if (res.status === 404) return null;
  if (res.status === 401) {
    // The transport already verified this same token moments earlier via
    // `verifySessionRemote`; a 401 here means the token expired in the tiny
    // window between the two calls, or the two services disagree. Either
    // way, treat it the same as "not connected" would be wrong (it hides an
    // auth problem) — surface it as unavailable so the caller's envelope is
    // honest about what actually happened.
    throw new VaultUnavailableError('the hosted vault rejected the session token used to reach it');
  }
  if (!res.ok) {
    throw new VaultUnavailableError(`the hosted vault returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { credentials?: unknown };
  if (typeof body.credentials !== 'object' || body.credentials === null || Array.isArray(body.credentials)) {
    throw new VaultUnavailableError('the hosted vault returned a malformed credentials record');
  }
  return body.credentials as VaultCredentialRecord;
}

/** Thrown when the hosted vault cannot be reached or returns something other than a clean
 * hit/miss. Distinct from "not connected" so a vault outage is never mistaken for a user simply
 * not having set up a network yet. */
export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

/**
 * List the distinct networks the caller has connected (H6:
 * `docs/product/hosted-mvp-workstream.md`). Calls the same
 * `GET /vault/credentials` list route H5's connect flow uses, with the
 * caller's own session token — never a service credential. This is the one
 * read the Solo-tier network cap (`tier-gate.ts`) needs: the cap counts
 * DISTINCT connected networks, not tool calls, so the transport must know
 * the caller's full connected set before it can tell "still under five" from
 * "adding a sixth".
 */
export async function listConnectedNetworks(bearerToken: string, vaultUrl: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${vaultUrl}/vault/credentials`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  } catch (err) {
    throw new VaultUnavailableError(`could not reach the hosted vault: ${(err as Error).message}`);
  }
  if (res.status === 401) {
    throw new VaultUnavailableError('the hosted vault rejected the session token used to reach it');
  }
  if (!res.ok) {
    throw new VaultUnavailableError(`the hosted vault returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { networks?: unknown };
  if (!Array.isArray(body.networks) || !body.networks.every((n) => typeof n === 'string')) {
    throw new VaultUnavailableError('the hosted vault returned a malformed network list');
  }
  return body.networks as string[];
}
