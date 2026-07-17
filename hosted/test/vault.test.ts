/**
 * Vault module tests: envelope encryption round-trip, wrong-master-key
 * failure, per-user isolation, complete deletion, master-key rotation, and
 * that nothing ever logs a secret. Uses an in-memory KV fake (with `list`
 * support, unlike `test/worker.test.ts`'s simpler fake, since the vault
 * needs prefix enumeration for `listNetworks`, `deleteUser`, and
 * `rotateMasterKey`). No real Cloudflare KV, no `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteCredential,
  deleteUser,
  getCredentials,
  isValidCredentialRecord,
  isValidNetworkSlug,
  listNetworks,
  putCredentials,
  rotateMasterKey,
  VaultError,
  workerSecretMasterKey,
} from '../src/vault.js';

function fakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => {
      void cursor; // the fake never paginates; every call returns the full match in one page.
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

async function randomMasterKeyB64(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workerSecretMasterKey validation', () => {
  it('rejects a missing secret', () => {
    expect(() => workerSecretMasterKey('')).toThrow(VaultError);
  });

  it('rejects a secret that is not valid base64', () => {
    expect(() => workerSecretMasterKey('not base64!!')).toThrow(VaultError);
  });

  it('rejects a secret that does not decode to 32 bytes', () => {
    expect(() => workerSecretMasterKey(btoa('too-short'))).toThrow(VaultError);
  });
});

describe('round-trip encrypt/decrypt', () => {
  it('putCredentials then getCredentials returns the identical record', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    const record = { apiKey: 'sekret-key-1', publisherId: '12345' };

    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', record);
    const result = await getCredentials(kv, provider, 'hosted_usr_a', 'awin');

    expect(result).toEqual(record);
  });

  it('never stores the plaintext credential value anywhere in KV', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'sekret-plaintext-marker' });

    for (const value of kv.store.values()) {
      expect(value).not.toContain('sekret-plaintext-marker');
    }
  });

  it('reuses the same data key across two networks for the same user', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });
    await putCredentials(kv, provider, 'hosted_usr_a', 'cj', { apiKey: 'two' });

    // Only one wrapped data key is ever created for this user, however many
    // networks they connect.
    expect(kv.store.has('vault:key:hosted_usr_a')).toBe(true);
    const awin = await getCredentials(kv, provider, 'hosted_usr_a', 'awin');
    const cj = await getCredentials(kv, provider, 'hosted_usr_a', 'cj');
    expect(awin).toEqual({ apiKey: 'one' });
    expect(cj).toEqual({ apiKey: 'two' });
  });

  it('getCredentials returns null for a network the user never connected', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });

    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'impact')).toBeNull();
  });
});

describe('wrong-master-key failure', () => {
  it('getCredentials throws when unwrapping with a different master key', async () => {
    const kv = fakeKV();
    const providerA = workerSecretMasterKey(await randomMasterKeyB64());
    const providerB = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, providerA, 'hosted_usr_a', 'awin', { apiKey: 'one' });

    await expect(getCredentials(kv, providerB, 'hosted_usr_a', 'awin')).rejects.toThrow(VaultError);
  });

  it('the failure is a structured VaultError with a closed-vocabulary code, not an exposed WebCrypto detail', async () => {
    const kv = fakeKV();
    const providerA = workerSecretMasterKey(await randomMasterKeyB64());
    const providerB = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, providerA, 'hosted_usr_a', 'awin', { apiKey: 'one' });

    try {
      await getCredentials(kv, providerB, 'hosted_usr_a', 'awin');
      throw new Error('expected getCredentials to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      // Both providers share the same (id, keyVersion) tag by default — that
      // tag distinguishes PROVIDERS, not secrets — so this is an auth-tag
      // failure at unwrap time, not a tag mismatch caught earlier. See
      // "provider_mismatch" tests below for the tag-mismatch path.
      expect((err as VaultError).code).toBe('unwrap_failed');
      expect((err as VaultError).message).not.toMatch(/OperationError|DOMException/);
    }
  });

  it('a stale keyVersion tag is caught as provider_mismatch before any unwrap is attempted', async () => {
    const kv = fakeKV();
    const providerV1 = workerSecretMasterKey(await randomMasterKeyB64(), 1);
    const providerV2SameSecretDifferentVersion = workerSecretMasterKey(await randomMasterKeyB64(), 2);
    await putCredentials(kv, providerV1, 'hosted_usr_a', 'awin', { apiKey: 'one' });

    await expect(
      getCredentials(kv, providerV2SameSecretDifferentVersion, 'hosted_usr_a', 'awin'),
    ).rejects.toMatchObject({ code: 'provider_mismatch' });
  });
});

describe('per-user isolation', () => {
  it("user A's data key cannot decrypt user B's blob", async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'a-secret' });
    await putCredentials(kv, provider, 'hosted_usr_b', 'awin', { apiKey: 'b-secret' });

    // Swap user B's stored blob under user A's key path — simulates user A's
    // data key ever being pointed at user B's ciphertext (e.g. a KV mix-up).
    const bBlob = await kv.get('vault:cred:hosted_usr_b:awin');
    expect(bBlob).not.toBeNull();
    await kv.put('vault:cred:hosted_usr_a:impact', bBlob as string);

    await expect(getCredentials(kv, provider, 'hosted_usr_a', 'impact')).rejects.toThrow(VaultError);
    // Meanwhile each user's own data still decrypts correctly.
    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'awin')).toEqual({ apiKey: 'a-secret' });
    expect(await getCredentials(kv, provider, 'hosted_usr_b', 'awin')).toEqual({ apiKey: 'b-secret' });
  });

  it('deleting one user never affects another user’s credentials', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'a-secret' });
    await putCredentials(kv, provider, 'hosted_usr_b', 'awin', { apiKey: 'b-secret' });

    await deleteUser(kv, 'hosted_usr_a');

    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'awin')).toBeNull();
    expect(await getCredentials(kv, provider, 'hosted_usr_b', 'awin')).toEqual({ apiKey: 'b-secret' });
  });
});

describe('deleteCredential', () => {
  it('removes one network without touching another', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });
    await putCredentials(kv, provider, 'hosted_usr_a', 'cj', { apiKey: 'two' });

    await deleteCredential(kv, 'hosted_usr_a', 'awin');

    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'awin')).toBeNull();
    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'cj')).toEqual({ apiKey: 'two' });
  });

  it('is idempotent: deleting a network never connected is not an error', async () => {
    const kv = fakeKV();
    await expect(deleteCredential(kv, 'hosted_usr_a', 'never-connected')).resolves.toBeUndefined();
  });
});

describe('listNetworks', () => {
  it('lists connected network slugs and never their values', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'secret-value-x' });
    await putCredentials(kv, provider, 'hosted_usr_a', 'cj', { apiKey: 'secret-value-y' });
    await putCredentials(kv, provider, 'hosted_usr_b', 'impact', { apiKey: 'someone-elses' });

    const networks = await listNetworks(kv, 'hosted_usr_a');
    expect(networks.sort()).toEqual(['awin', 'cj']);
    expect(JSON.stringify(networks)).not.toContain('secret-value');
  });

  it('returns an empty list for a user with no connections', async () => {
    const kv = fakeKV();
    expect(await listNetworks(kv, 'hosted_usr_nobody')).toEqual([]);
  });
});

describe('complete deletion', () => {
  it('getCredentials returns null for every network after deleteUser', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });
    await putCredentials(kv, provider, 'hosted_usr_a', 'cj', { apiKey: 'two' });

    await deleteUser(kv, 'hosted_usr_a');

    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'awin')).toBeNull();
    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'cj')).toBeNull();
  });

  it('enumerates as gone: no vault:key or vault:cred entry remains for the deleted user', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });
    await putCredentials(kv, provider, 'hosted_usr_a', 'cj', { apiKey: 'two' });

    await deleteUser(kv, 'hosted_usr_a');

    const remaining = Array.from(kv.store.keys()).filter((k) => k.includes('hosted_usr_a'));
    expect(remaining).toEqual([]);
  });

  it('a fresh putCredentials after deleteUser mints an entirely new data key', async () => {
    const kv = fakeKV();
    const provider = workerSecretMasterKey(await randomMasterKeyB64());
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one' });
    const firstWrappedKey = kv.store.get('vault:key:hosted_usr_a');

    await deleteUser(kv, 'hosted_usr_a');
    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: 'one-again' });
    const secondWrappedKey = kv.store.get('vault:key:hosted_usr_a');

    expect(secondWrappedKey).not.toBe(firstWrappedKey);
    expect(await getCredentials(kv, provider, 'hosted_usr_a', 'awin')).toEqual({ apiKey: 'one-again' });
  });
});

describe('rotation re-wrap', () => {
  it('old blobs decrypt after rotateMasterKey with the new provider', async () => {
    const kv = fakeKV();
    const providerV1 = workerSecretMasterKey(await randomMasterKeyB64(), 1);
    const providerV2 = workerSecretMasterKey(await randomMasterKeyB64(), 2);

    await putCredentials(kv, providerV1, 'hosted_usr_a', 'awin', { apiKey: 'unchanged-secret' });
    const credentialBlobBefore = kv.store.get('vault:cred:hosted_usr_a:awin');

    const summary = await rotateMasterKey(kv, providerV1, providerV2);
    expect(summary.rotated).toBe(1);
    expect(summary.skipped).toBe(0);

    // Credential blobs are untouched by rotation: same ciphertext, same IV.
    expect(kv.store.get('vault:cred:hosted_usr_a:awin')).toBe(credentialBlobBefore);

    // But the SAME plaintext still comes back, now unwrapped via the new provider.
    expect(await getCredentials(kv, providerV2, 'hosted_usr_a', 'awin')).toEqual({ apiKey: 'unchanged-secret' });
    // The old provider can no longer unwrap the (now re-wrapped) data key.
    await expect(getCredentials(kv, providerV1, 'hosted_usr_a', 'awin')).rejects.toThrow(VaultError);
  });

  it('rotates every user in the vault, and is safe to re-run (idempotent on already-rotated keys)', async () => {
    const kv = fakeKV();
    const providerV1 = workerSecretMasterKey(await randomMasterKeyB64(), 1);
    const providerV2 = workerSecretMasterKey(await randomMasterKeyB64(), 2);

    await putCredentials(kv, providerV1, 'hosted_usr_a', 'awin', { apiKey: 'a' });
    await putCredentials(kv, providerV1, 'hosted_usr_b', 'cj', { apiKey: 'b' });

    const first = await rotateMasterKey(kv, providerV1, providerV2);
    expect(first.rotated).toBe(2);

    // Re-running with the same (now stale) oldProvider finds nothing left to
    // rotate — every key is already tagged with providerV2.
    const second = await rotateMasterKey(kv, providerV1, providerV2);
    expect(second.rotated).toBe(0);
    expect(second.skipped).toBe(2);

    expect(await getCredentials(kv, providerV2, 'hosted_usr_a', 'awin')).toEqual({ apiKey: 'a' });
    expect(await getCredentials(kv, providerV2, 'hosted_usr_b', 'cj')).toEqual({ apiKey: 'b' });
  });
});

describe('no plaintext in logs', () => {
  it('a full lifecycle including a wrong-master-key failure never logs a credential value, the master key, or the data key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const kv = fakeKV();
    const secretMarker = 'sekret-value-should-never-log';
    const masterKeyB64 = await randomMasterKeyB64();
    const provider = workerSecretMasterKey(masterKeyB64);
    const wrongProvider = workerSecretMasterKey(await randomMasterKeyB64());

    await putCredentials(kv, provider, 'hosted_usr_a', 'awin', { apiKey: secretMarker });
    await getCredentials(kv, provider, 'hosted_usr_a', 'awin');
    try {
      await getCredentials(kv, wrongProvider, 'hosted_usr_a', 'awin');
    } catch {
      // expected: exercising the failure path is the point of this test.
    }
    await rotateMasterKey(kv, provider, wrongProvider);
    await deleteUser(kv, 'hosted_usr_a');

    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.join(' '));
    for (const line of allCalls) {
      expect(line).not.toContain(secretMarker);
      expect(line).not.toContain(masterKeyB64);
    }
    // vault.ts does not log at all today; this test also guards against a
    // future change quietly starting to log through these two functions.
    expect(allCalls).toEqual([]);
  });
});

describe('input validation helpers', () => {
  it('isValidNetworkSlug accepts lowercase-hyphen slugs and rejects anything that could smuggle a KV key segment', () => {
    expect(isValidNetworkSlug('awin')).toBe(true);
    expect(isValidNetworkSlug('cj-affiliate')).toBe(true);
    expect(isValidNetworkSlug('')).toBe(false);
    expect(isValidNetworkSlug('Awin')).toBe(false);
    expect(isValidNetworkSlug('awin:other-user')).toBe(false);
    expect(isValidNetworkSlug('../escape')).toBe(false);
    expect(isValidNetworkSlug(42)).toBe(false);
  });

  it('isValidCredentialRecord accepts a flat string record and rejects nested or empty shapes', () => {
    expect(isValidCredentialRecord({ apiKey: 'x' })).toBe(true);
    expect(isValidCredentialRecord({})).toBe(false);
    expect(isValidCredentialRecord({ apiKey: '' })).toBe(false);
    expect(isValidCredentialRecord({ apiKey: 123 })).toBe(false);
    expect(isValidCredentialRecord({ nested: { apiKey: 'x' } })).toBe(false);
    expect(isValidCredentialRecord([])).toBe(false);
    expect(isValidCredentialRecord(null)).toBe(false);
    expect(isValidCredentialRecord('not-an-object')).toBe(false);
  });
});
