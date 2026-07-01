/**
 * Entitlement token sign/verify roundtrip. Generates a real Ed25519 keypair via
 * WebCrypto (same as the Worker + app), so this proves the wire format the app
 * verifier must match. No Stripe, no KV.
 */

import { describe, expect, it } from 'vitest';

import {
  base64urlEncode,
  buildEntitlement,
  ENTITLEMENT_TOKEN_PREFIX,
  generateAccountKey,
  signEntitlement,
  verifyEntitlement,
} from '../src/token.js';

async function keypair(): Promise<{ priv: string; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  // Base64 (not url) — matches how the keys are stored/embedded.
  return { priv: btoa(String.fromCharCode(...pkcs8)), pub: btoa(String.fromCharCode(...spki)) };
}

describe('entitlement token', () => {
  it('signs and verifies a roundtrip, preserving the payload', async () => {
    const { priv, pub } = await keypair();
    const akey = generateAccountKey();
    const iss = 1_800_000_000;
    const exp = iss + 60 * 60 * 24 * 8;
    const token = await signEntitlement(buildEntitlement({ akey, iss, exp }), priv);

    expect(token.startsWith(ENTITLEMENT_TOKEN_PREFIX)).toBe(true);
    const payload = await verifyEntitlement(token, pub);
    expect(payload).not.toBeNull();
    expect(payload!.akey).toBe(akey);
    expect(payload!.product).toBe('desktop-premium');
    expect(payload!.exp).toBe(exp);
    expect(payload!.v).toBe(1);
  });

  it('rejects a token signed by a different key', async () => {
    const a = await keypair();
    const b = await keypair();
    const token = await signEntitlement(
      buildEntitlement({ akey: generateAccountKey(), iss: 1, exp: 2 }),
      a.priv,
    );
    expect(await verifyEntitlement(token, b.pub)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { priv, pub } = await keypair();
    const token = await signEntitlement(
      buildEntitlement({ akey: 'amcp_acc_real', iss: 1, exp: 9_999_999_999 }),
      priv,
    );
    // Swap the payload half for a forged one; the signature no longer matches.
    const forged =
      ENTITLEMENT_TOKEN_PREFIX +
      base64urlEncode(
        new TextEncoder().encode(
          JSON.stringify({ akey: 'amcp_acc_forged', product: 'desktop-premium', iss: 1, exp: 9_999_999_999, v: 1 }),
        ),
      ) +
      '.' +
      token.split('.')[1];
    expect(await verifyEntitlement(forged, pub)).toBeNull();
  });

  it('rejects a token without the entitlement prefix', async () => {
    const { pub } = await keypair();
    expect(await verifyEntitlement('amcp_not_an_entitlement.token', pub)).toBeNull();
  });
});
