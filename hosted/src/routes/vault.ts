/**
 * H3 vault routes: store, list, and remove per-network credentials for the
 * authenticated user. Every handler requires a valid session
 * (`requireSession`, `./guard.ts`) and never returns a decrypted credential
 * value over HTTP — this surface exists for the connect flow (H5) to write
 * credentials and check what is connected, not to read them back. Decrypting
 * a credential for actual use is H4's remote-transport concern, calling
 * `getCredentials` from `../vault.js` directly at call time.
 */

import type { Env } from '../env.js';
import { vaultMasterKeyProvider } from '../env.js';
import { json } from '../http.js';
import {
  deleteCredential,
  isValidCredentialRecord,
  isValidNetworkSlug,
  listNetworks,
  putCredentials,
  VaultError,
} from '../vault.js';
import { requireSession } from './guard.js';

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
  const auth = await requireSession(request, env, cors);
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
  const auth = await requireSession(request, env, cors);
  if (auth instanceof Response) return auth;

  if (!isValidNetworkSlug(network)) {
    return json({ error: 'invalid_network' }, { status: 400 }, cors);
  }

  await deleteCredential(env.HOSTED_VAULT, auth.userId, network);
  // Idempotent: deleting a network never connected is not an error.
  return json({ ok: true, network }, { status: 200 }, cors);
}
