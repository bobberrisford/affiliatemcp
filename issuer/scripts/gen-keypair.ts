/**
 * Generate an Ed25519 keypair for entitlement-token signing.
 *
 *   npm run gen-keypair
 *
 * Prints:
 *   - PRIVATE key (PKCS8 DER, base64) → the Worker secret LICENCE_SIGNING_KEY.
 *     Set it with:  npx wrangler secret put LICENCE_SIGNING_KEY
 *   - PUBLIC key (SPKI DER, base64)   → embed in the desktop app's verifier.
 *
 * The private key is printed once and never stored here — capture it now. Runs
 * on Node 20+ (WebCrypto Ed25519), the same algorithm the Worker and app use.
 */

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

async function main(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);

  process.stdout.write(
    [
      '# Ed25519 keypair for affiliate-mcp entitlement tokens',
      '',
      '## PRIVATE key — Worker secret LICENCE_SIGNING_KEY (keep secret):',
      toB64(pkcs8),
      '',
      '## PUBLIC key — embed in the desktop app verifier (ENTITLEMENT_PUBLIC_KEY_SPKI_B64):',
      toB64(spki),
      '',
    ].join('\n'),
  );
}

void main();
