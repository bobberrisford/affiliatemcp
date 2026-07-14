/**
 * Encrypted credential vault (hosted workstream slice H3:
 * `docs/product/hosted-mvp-workstream.md`). Envelope encryption, WebCrypto
 * only, no third-party crypto dependency.
 *
 * Shape:
 *
 *   plaintext credential record
 *     --AES-256-GCM(per-user data key)-->  ciphertext, stored in KV
 *
 *   per-user data key (32 random bytes, generated on first store)
 *     --wrapped by a MasterKeyProvider-->  wrapped blob, stored in KV
 *
 * The data key is generated once per user and never rotates on its own; only
 * its WRAPPING changes on `rotateMasterKey`. That is what makes rotation cheap:
 * re-wrap one small key per user, never touch the (potentially many)
 * credential blobs it protects.
 *
 * `MasterKeyProvider` is the seam. This slice ships exactly one implementation,
 * `workerSecretMasterKey` (AES-256-GCM wrap using a Worker secret), because
 * that is what the accepted custody record's forward-looking KMS requirement
 * has not yet been resolved into a concrete choice — see the "Vault threat
 * model" section of `hosted/README.md` for the honest trade-off and the
 * decision this slice leaves for Rob. A future KMS-backed provider (for
 * example, one that calls AWS KMS's Decrypt/Encrypt over HTTP so the master
 * key never enters the Worker process) implements the same three-method
 * interface and drops in without touching anything in this file's stored
 * data shapes: every wrapped-key blob is tagged with `provider` and
 * `keyVersion`, so mixed-provider vaults (mid-migration) and rotations are
 * both representable on disk.
 *
 * KV shapes (see also `hosted/wrangler.toml` and `hosted/README.md`):
 *   vault:key:<userId>            -> StoredWrappedKey   (the wrapped per-user data key)
 *   vault:cred:<userId>:<network> -> StoredCredentialBlob (one per connected network)
 *
 * Logging discipline: this module never logs a credential value, a plaintext
 * byte, a data key, or a master key. Errors carry a closed set of `code`
 * values and a fixed, generic message; they never include the upstream
 * WebCrypto exception (which itself carries no secret material, but is not a
 * stable or meaningful string to expose to a caller either).
 */

// ── Wire types (exact JSON persisted in KV) ─────────────────────────────────

/** A credential record is opaque to the vault: whatever fields a network's
 * adapter needs (API key, secret, publisher id, …), always strings. */
export type CredentialRecord = Record<string, string>;

const ENCRYPTION_ALGORITHM = 'AES-256-GCM';

/** A master-key-wrapped data key, exactly as persisted under `vault:key:<userId>`. */
export interface StoredWrappedKey {
  v: 1;
  /** Which `MasterKeyProvider` wrapped this key — e.g. `"worker-secret"`. */
  provider: string;
  /** The provider's own key version at wrap time, for rotation bookkeeping. */
  keyVersion: number;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string; // base64, 12 bytes
  ciphertext: string; // base64, wrapped data key + GCM tag
  createdAt: number; // unix seconds
  rotatedAt?: number; // unix seconds, set on rotateMasterKey
}

/** One encrypted credential record, exactly as persisted under `vault:cred:<userId>:<network>`. */
export interface StoredCredentialBlob {
  v: 1;
  network: string;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string; // base64, 12 bytes
  ciphertext: string; // base64, encrypted CredentialRecord JSON + GCM tag
  createdAt: number;
  updatedAt: number;
}

// ── The MasterKeyProvider seam ───────────────────────────────────────────────

/** The wire form of a wrapped data key — what a `MasterKeyProvider` produces
 * and consumes. Deliberately identical to the fields persisted in
 * `StoredWrappedKey`, so a provider never needs to know about KV at all. */
export interface WrappedDataKey {
  provider: string;
  keyVersion: number;
  algorithm: string;
  iv: string;
  ciphertext: string;
}

/**
 * Wraps and unwraps per-user AES-256 data keys. Never touches a credential
 * blob directly: the vault only ever asks a provider to protect 32 bytes of
 * key material, so swapping providers (or provider versions, for rotation)
 * never requires re-encrypting stored credentials.
 *
 * `id` and `keyVersion` are stamped onto every blob the provider produces,
 * so a stored blob is self-describing: `rotateMasterKey` (below) uses that
 * tag to find blobs that still need re-wrapping under a newer provider.
 */
export interface MasterKeyProvider {
  readonly id: string;
  readonly keyVersion: number;
  wrapDataKey(rawKey: Uint8Array): Promise<WrappedDataKey>;
  unwrapDataKey(blob: WrappedDataKey): Promise<Uint8Array>;
}

const WORKER_SECRET_PROVIDER_ID = 'worker-secret';
const MASTER_KEY_LENGTH_BYTES = 32; // AES-256

/**
 * v1 `MasterKeyProvider`: wraps the per-user data key with AES-256-GCM using
 * a single Worker secret (`VAULT_MASTER_KEY`, base64 of 32 random bytes).
 * See `hosted/README.md` "Vault threat model" for what this design does and
 * does not protect against, and what a KMS-backed provider would change.
 *
 * `secretB64` is passed in directly (not the whole `Env`) so this stays a
 * pure, environment-agnostic factory: any future provider — including one
 * that talks to an external KMS over `fetch` — implements the same
 * `MasterKeyProvider` shape without this module needing to know about
 * Worker bindings.
 *
 * Rotation caveat: a stored blob is tagged with `(provider id, keyVersion)`,
 * not a fingerprint of the secret itself, so `rotateMasterKey` can only tell
 * "already rotated" apart from "still needs rotating" by that tag. Calling
 * `workerSecretMasterKey(newSecret)` with the SAME (default) `keyVersion` as
 * the key being replaced is indistinguishable, by tag, from the old one — the
 * rotation runbook (`hosted/README.md`) must always pass an incremented
 * `keyVersion` (and bump `VAULT_MASTER_KEY_VERSION`) for a rotation to be
 * detectable and resumable.
 */
export function workerSecretMasterKey(secretB64: string, keyVersion = 1): MasterKeyProvider {
  if (typeof secretB64 !== 'string' || secretB64.length === 0) {
    throw new VaultError('provider_misconfigured', 'VAULT_MASTER_KEY is not configured');
  }
  let rawSecret: Uint8Array;
  try {
    rawSecret = base64ToBytes(secretB64);
  } catch {
    throw new VaultError('provider_misconfigured', 'VAULT_MASTER_KEY is not valid base64');
  }
  if (rawSecret.length !== MASTER_KEY_LENGTH_BYTES) {
    throw new VaultError('provider_misconfigured', 'VAULT_MASTER_KEY must decode to 32 bytes');
  }

  const id = WORKER_SECRET_PROVIDER_ID;
  const keyPromise = importAesGcmKey(rawSecret, ['encrypt', 'decrypt']);

  return {
    id,
    keyVersion,
    async wrapDataKey(rawKey: Uint8Array): Promise<WrappedDataKey> {
      const masterKey = await keyPromise;
      const { iv, ciphertext } = await aesGcmEncrypt(masterKey, rawKey);
      return { provider: id, keyVersion, algorithm: ENCRYPTION_ALGORITHM, iv, ciphertext };
    },
    async unwrapDataKey(blob: WrappedDataKey): Promise<Uint8Array> {
      if (blob.provider !== id || blob.keyVersion !== keyVersion) {
        throw new VaultError(
          'provider_mismatch',
          'wrapped data key was produced by a different master-key provider or key version',
        );
      }
      const masterKey = await keyPromise;
      try {
        return await aesGcmDecrypt(masterKey, blob.iv, blob.ciphertext);
      } catch {
        // Auth-tag mismatch (wrong master key) and malformed ciphertext land
        // here identically — WebCrypto does not distinguish them, and this
        // module must not try to guess or expose which one occurred.
        throw new VaultError('unwrap_failed', 'failed to unwrap the data key');
      }
    },
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type VaultErrorCode =
  | 'not_found'
  | 'unwrap_failed'
  | 'decrypt_failed'
  | 'provider_mismatch'
  | 'provider_misconfigured'
  | 'invalid_record';

/** Structured, closed-vocabulary error. Never carries plaintext, key
 * material, or the underlying WebCrypto exception. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// ── KV key helpers ───────────────────────────────────────────────────────────

const VAULT_KEY_PREFIX = 'vault:key:';
const VAULT_CRED_PREFIX = 'vault:cred:';

const vaultKeyKey = (userId: string): string => `${VAULT_KEY_PREFIX}${userId}`;
const vaultCredPrefix = (userId: string): string => `${VAULT_CRED_PREFIX}${userId}:`;
const vaultCredKey = (userId: string, network: string): string => `${vaultCredPrefix(userId)}${network}`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Network slugs become part of a KV key; keep them to a safe, predictable
 * shape so a caller can never smuggle a colon or path segment into the
 * namespace (e.g. a "network" of `x:other-user` reaching outside its own
 * `vault:cred:<userId>:` prefix). */
const NETWORK_SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function isValidNetworkSlug(value: unknown): value is string {
  return typeof value === 'string' && NETWORK_SLUG_RE.test(value);
}

const MAX_CREDENTIAL_FIELDS = 32;
const MAX_CREDENTIAL_VALUE_LENGTH = 4096;

/** A credential record must be a flat object of non-empty string fields,
 * within modest size bounds. This is shape validation only — the vault does
 * not know or care what a network's fields mean. */
export function isValidCredentialRecord(value: unknown): value is CredentialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_CREDENTIAL_FIELDS) return false;
  return entries.every(
    ([key, val]) =>
      key.length > 0 && typeof val === 'string' && val.length > 0 && val.length <= MAX_CREDENTIAL_VALUE_LENGTH,
  );
}

// ── WebCrypto helpers (AES-256-GCM, used for both wrap and encrypt) ─────────

const GCM_IV_LENGTH_BYTES = 12; // 96-bit nonce, the recommended GCM size.
const DATA_KEY_LENGTH_BYTES = 32; // AES-256

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importAesGcmKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, usages);
}

async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = new Uint8Array(GCM_IV_LENGTH_BYTES);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext.buffer as ArrayBuffer);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function aesGcmDecrypt(key: CryptoKey, ivB64: string, ciphertextB64: string): Promise<Uint8Array> {
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  return new Uint8Array(decrypted);
}

function generateDataKey(): Uint8Array {
  const key = new Uint8Array(DATA_KEY_LENGTH_BYTES);
  crypto.getRandomValues(key);
  return key;
}

async function unwrapStoredKey(stored: StoredWrappedKey, provider: MasterKeyProvider): Promise<Uint8Array> {
  return provider.unwrapDataKey({
    provider: stored.provider,
    keyVersion: stored.keyVersion,
    algorithm: stored.algorithm,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
  });
}

/** Fetch this user's data key, unwrapping it with `provider`. Generates and
 * stores a brand-new one on first use — this is the ONLY path that creates a
 * data key, so it must only ever be called from `putCredentials`. */
async function getOrCreateRawDataKey(
  kv: KVNamespace,
  provider: MasterKeyProvider,
  userId: string,
): Promise<Uint8Array> {
  const key = vaultKeyKey(userId);
  const raw = await kv.get(key);
  if (raw) {
    const stored = JSON.parse(raw) as StoredWrappedKey;
    return unwrapStoredKey(stored, provider);
  }

  const dataKey = generateDataKey();
  const wrapped = await provider.wrapDataKey(dataKey);
  const stored: StoredWrappedKey = {
    v: 1,
    provider: wrapped.provider,
    keyVersion: wrapped.keyVersion,
    algorithm: ENCRYPTION_ALGORITHM,
    iv: wrapped.iv,
    ciphertext: wrapped.ciphertext,
    createdAt: nowSeconds(),
  };
  await kv.put(key, JSON.stringify(stored));
  return dataKey;
}

/** Fetch this user's EXISTING data key. Unlike `getOrCreateRawDataKey`, never
 * creates one: a missing data key while a credential blob exists would be
 * data corruption, not a "first store", so this surfaces `not_found` rather
 * than silently minting a key that cannot decrypt anything already stored. */
async function requireRawDataKey(kv: KVNamespace, provider: MasterKeyProvider, userId: string): Promise<Uint8Array> {
  const raw = await kv.get(vaultKeyKey(userId));
  if (!raw) throw new VaultError('not_found', 'no data key exists for this user');
  const stored = JSON.parse(raw) as StoredWrappedKey;
  return unwrapStoredKey(stored, provider);
}

// ── Public vault API ─────────────────────────────────────────────────────────

/**
 * Encrypt and store one network's credential record for a user. Generates
 * the user's data key on first call for that user (across all their
 * networks); every subsequent call, for any network, reuses it.
 */
export async function putCredentials(
  kv: KVNamespace,
  provider: MasterKeyProvider,
  userId: string,
  network: string,
  record: CredentialRecord,
): Promise<void> {
  const dataKeyRaw = await getOrCreateRawDataKey(kv, provider, userId);
  const aesKey = await importAesGcmKey(dataKeyRaw, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const { iv, ciphertext } = await aesGcmEncrypt(aesKey, plaintext);

  const key = vaultCredKey(userId, network);
  const existingRaw = await kv.get(key);
  const createdAt = existingRaw ? (JSON.parse(existingRaw) as StoredCredentialBlob).createdAt : nowSeconds();

  const stored: StoredCredentialBlob = {
    v: 1,
    network,
    algorithm: ENCRYPTION_ALGORITHM,
    iv,
    ciphertext,
    createdAt,
    updatedAt: nowSeconds(),
  };
  await kv.put(key, JSON.stringify(stored));
}

/**
 * Decrypt and return one network's credential record, or `null` if the user
 * has not connected that network. Decryption happens here, at call time,
 * only: the plaintext is never cached, and this function is the only place
 * in the vault that ever holds it in memory.
 */
export async function getCredentials(
  kv: KVNamespace,
  provider: MasterKeyProvider,
  userId: string,
  network: string,
): Promise<CredentialRecord | null> {
  const raw = await kv.get(vaultCredKey(userId, network));
  if (!raw) return null;
  const stored = JSON.parse(raw) as StoredCredentialBlob;

  const dataKeyRaw = await requireRawDataKey(kv, provider, userId);
  const aesKey = await importAesGcmKey(dataKeyRaw, ['decrypt']);

  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(aesKey, stored.iv, stored.ciphertext);
  } catch {
    throw new VaultError('decrypt_failed', 'failed to decrypt the stored credential');
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as CredentialRecord;
}

/** List the networks a user has connected. Never touches, decrypts, or
 * returns credential values — only the network slugs found in the KV key
 * names themselves. */
export async function listNetworks(kv: KVNamespace, userId: string): Promise<string[]> {
  const prefix = vaultCredPrefix(userId);
  const networks: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) networks.push(entry.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return networks.sort();
}

/** Remove one network's credential. Idempotent: deleting a network the user
 * never connected is not an error. Does not touch the user's data key or any
 * other network's blob. */
export async function deleteCredential(kv: KVNamespace, userId: string, network: string): Promise<void> {
  await kv.delete(vaultCredKey(userId, network));
}

/**
 * Complete deletion for one user: every credential blob and the wrapped data
 * key itself. After this resolves, `getCredentials` for any network returns
 * `null` and a fresh `putCredentials` call would mint an entirely new data
 * key — there is nothing left to recover or re-derive.
 */
export async function deleteUser(kv: KVNamespace, userId: string): Promise<void> {
  const prefix = vaultCredPrefix(userId);
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    await Promise.all(page.keys.map((entry) => kv.delete(entry.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await kv.delete(vaultKeyKey(userId));
}

export interface RotationSummary {
  /** Data keys re-wrapped under `newProvider`. */
  rotated: number;
  /** Data keys left untouched because they were not tagged with
   * `oldProvider`'s id and key version (already rotated, or wrapped by a
   * provider this call was not asked to migrate). */
  skipped: number;
}

/**
 * Re-wrap every user's data key from `oldProvider` to `newProvider`. Credential
 * blobs are never read, decrypted, or rewritten: rotation only ever changes
 * how the (unchanged) data key is protected, which is the entire point of
 * separating the data key from its wrapping. Safe to re-run: an interrupted
 * rotation leaves already-rotated keys tagged with `newProvider` and picks up
 * only the remaining `oldProvider`-tagged ones on the next call.
 */
export async function rotateMasterKey(
  kv: KVNamespace,
  oldProvider: MasterKeyProvider,
  newProvider: MasterKeyProvider,
): Promise<RotationSummary> {
  let rotated = 0;
  let skipped = 0;
  let cursor: string | undefined;

  do {
    const page = await kv.list({ prefix: VAULT_KEY_PREFIX, cursor });
    for (const entry of page.keys) {
      const raw = await kv.get(entry.name);
      if (!raw) continue;
      const stored = JSON.parse(raw) as StoredWrappedKey;

      if (stored.provider !== oldProvider.id || stored.keyVersion !== oldProvider.keyVersion) {
        skipped += 1;
        continue;
      }

      const dataKeyRaw = await unwrapStoredKey(stored, oldProvider);
      const rewrapped = await newProvider.wrapDataKey(dataKeyRaw);
      const next: StoredWrappedKey = {
        v: 1,
        provider: rewrapped.provider,
        keyVersion: rewrapped.keyVersion,
        algorithm: ENCRYPTION_ALGORITHM,
        iv: rewrapped.iv,
        ciphertext: rewrapped.ciphertext,
        createdAt: stored.createdAt,
        rotatedAt: nowSeconds(),
      };
      await kv.put(entry.name, JSON.stringify(next));
      rotated += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { rotated, skipped };
}
