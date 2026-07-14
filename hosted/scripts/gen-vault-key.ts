/**
 * Generate a fresh master key for the credential vault's v1 provider,
 * `workerSecretMasterKey` (`src/vault.ts`).
 *
 *   npm run gen-vault-key
 *
 * Prints 32 random bytes, base64-encoded — the Worker secret
 * `VAULT_MASTER_KEY`. Used the same way for the FIRST key and for every
 * ROTATION: generate a new one here, set it as the new secret under a new
 * `VAULT_MASTER_KEY_VERSION`, then run the rotation procedure in
 * `hosted/README.md` to re-wrap every stored data key onto it before removing
 * the old version. The key is printed once and never stored here — capture
 * it now. Runs on Node 20+ (WebCrypto), the same primitive the Worker uses.
 */

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function main(): void {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  console.log(
    [
      '# AES-256 master key for the affiliate-mcp hosted credential vault',
      '',
      '## Worker secret VAULT_MASTER_KEY (keep secret; set with):',
      '##   npx wrangler secret put VAULT_MASTER_KEY',
      '## Pair with a VAULT_MASTER_KEY_VERSION bump in wrangler.toml on rotation.',
      toB64(key),
      '',
    ].join('\n'),
  );
}

main();

// Force this file to be treated as a module (not a global script) so its
// top-level declarations do not collide with scripts/gen-keypair.ts, which
// has the same shape without any import/export of its own.
export {};
