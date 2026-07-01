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

// base64 over raw bytes using btoa — a runtime global in both Node 20+ (where
// this script runs via tsx) and the Workers runtime, so no Node type deps are
// needed (the Worker's tsconfig types are @cloudflare/workers-types only).
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
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);

  console.log(
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
