/**
 * Generate an Ed25519 keypair for hosted-session token signing.
 *
 *   npm run gen-keypair
 *
 * Prints only the PRIVATE key (PKCS8 DER, base64) — the Worker secret
 * SESSION_SIGNING_KEY. Unlike the issuer Worker's `gen-keypair`, there is no
 * separate public key to embed anywhere: this Worker derives the public
 * verification key from the private key at call time (see `src/token.ts`),
 * because the same process both signs and verifies hosted session tokens.
 * The private key is printed once and never stored here — capture it now.
 * Runs on Node 20+ (WebCrypto Ed25519), the same algorithm the Worker uses.
 */

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

async function main(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

  console.log(
    [
      '# Ed25519 private key for affiliate-mcp hosted session tokens',
      '',
      '## Worker secret SESSION_SIGNING_KEY (keep secret; set with):',
      '##   npx wrangler secret put SESSION_SIGNING_KEY',
      toB64(pkcs8),
      '',
    ].join('\n'),
  );
}

void main();
