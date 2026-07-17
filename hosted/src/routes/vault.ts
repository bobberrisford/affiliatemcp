/**
 * H3 vault routes: store, list, and remove per-network credentials for the
 * authenticated user. The store/list/delete handlers below never return a
 * decrypted credential value over HTTP — that surface exists for the connect
 * flow (H5) to write credentials and check what is connected, not to read
 * them back.
 *
 * `handleRevealCredentials` (H4, added with the remote MCP transport) is the
 * one deliberate exception: this file's original header comment anticipated
 * H4 calling `getCredentials` (`../vault.js`) directly, in-process, which
 * would have been true had the transport run inside this Worker. H4's own
 * investigation found that infeasible — the transport needs the full adapter
 * registry (`src/networks/**`, ~120k lines, plus `pino` and `node:fs`-based
 * config that are not Workers-portable) and runs as a Node service instead
 * (see `hosted/README.md`, "H4: remote MCP transport lives in the root
 * workspace"). A Node process cannot reach a Worker's KV bindings directly,
 * so this route exists to serve exactly what `getCredentials` would have
 * returned in-process, over HTTP, to the ONE caller entitled to it: it runs
 * the identical `requireSession` guard every other route here uses, so it can
 * only ever return the calling session's own credentials, never another
 * user's — the custody record's "serves only that user's own requests" holds
 * exactly as before, just across one more network hop.
 */

import type { Env } from '../env.js';
import { vaultMasterKeyProvider } from '../env.js';
import { json } from '../http.js';
import {
  deleteCredential,
  getCredentials,
  isValidCredentialRecord,
  isValidNetworkSlug,
  listNetworks,
  putCredentials,
  VaultError,
} from '../vault.js';
// Scope split (H6, `./guard.ts`): the two READ routes the scheduled digest
// needs — list and reveal — accept any valid session, including the
// short-lived digest-scoped tokens `src/digest.ts` mints (both still serve
// only the token's own userId). The two WRITE routes — store and delete —
// require a full session: the digest has no business writing credentials, so
// its token cannot.
import { requireFullSession, requireSession } from './guard.js';

interface PutCredentialsBody {
  network?: unknown;
  credentials?: unknown;
}

function vaultErrorCode(err: unknown): string {
  return err instanceof VaultError ? err.code : 'unknown';
}

// ── POST /vault/credentials ─────────────────────────────────────────────────
export async function handlePutCredentials(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  let body: PutCredentialsBody;
  try {
    body = (await request.json()) as PutCredentialsBody;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (!isValidNetworkSlug(body.network)) {
    return json({ error: 'invalid_network' }, { status: 400 }, cors);
  }
  if (!isValidCredentialRecord(body.credentials)) {
    return json({ error: 'invalid_credentials' }, { status: 400 }, cors);
  }

  try {
    const provider = vaultMasterKeyProvider(env);
    await putCredentials(env.HOSTED_VAULT, provider, auth.userId, body.network, body.credentials);
  } catch (err) {
    // Never log the credential values themselves — only the closed-vocabulary
    // VaultError code and the (opaque) userId and network slug.
    console.error(`[vault] put failed userId=${auth.userId} network=${body.network} code=${vaultErrorCode(err)}`);
    return json({ error: 'vault_error' }, { status: 500 }, cors);
  }

  return json({ ok: true, network: body.network }, { status: 200 }, cors);
}

// ── GET /vault/credentials ───────────────────────────────────────────────────
// Lists the networks this user has connected. Never the values.
export async function handleListCredentials(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireSession(request, env, cors);
  if (auth instanceof Response) return auth;

  const networks = await listNetworks(env.HOSTED_VAULT, auth.userId);
  return json({ networks }, { status: 200 }, cors);
}

// ── DELETE /vault/credentials/:network ──────────────────────────────────────
export async function handleDeleteCredential(
  request: Request,
  env: Env,
  network: string,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  if (!isValidNetworkSlug(network)) {
    return json({ error: 'invalid_network' }, { status: 400 }, cors);
  }

  await deleteCredential(env.HOSTED_VAULT, auth.userId, network);
  // Idempotent: deleting a network never connected is not an error.
  return json({ ok: true, network }, { status: 200 }, cors);
}

// ── GET /vault/credentials/:network/reveal ──────────────────────────────────
// H4's remote MCP transport calls this, over HTTP, with the SAME session
// token the calling MCP client authenticated with — see the file-header
// comment for why this is the one route that decrypts and returns a
// credential value. Returns 404 (never a decrypted placeholder or empty
// success) when the user has not connected this network; H4 must treat that
// as "not configured", not invent one.
export async function handleRevealCredentials(
  request: Request,
  env: Env,
  network: string,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireSession(request, env, cors);
  if (auth instanceof Response) return auth;

  if (!isValidNetworkSlug(network)) {
    return json({ error: 'invalid_network' }, { status: 400 }, cors);
  }

  try {
    const provider = vaultMasterKeyProvider(env);
    const credentials = await getCredentials(env.HOSTED_VAULT, provider, auth.userId, network);
    if (!credentials) {
      return json({ error: 'not_found' }, { status: 404 }, cors);
    }
    return json({ network, credentials }, { status: 200 }, cors);
  } catch (err) {
    // Never log the credential values themselves — only the closed-vocabulary
    // VaultError code and the (opaque) userId and network slug.
    console.error(`[vault] reveal failed userId=${auth.userId} network=${network} code=${vaultErrorCode(err)}`);
    return json({ error: 'vault_error' }, { status: 500 }, cors);
  }
}
