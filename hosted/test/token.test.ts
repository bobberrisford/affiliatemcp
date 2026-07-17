/**
 * Hosted session token sign/verify roundtrip. Generates a real Ed25519
 * private key via WebCrypto (same as the Worker) and confirms `verifySession`
 * derives a matching public key from it, so this proves the wire format and
 * the "derive, don't distribute" public-key choice documented in
 * `src/token.ts`. No KV, no fetch.
 */

import { describe, expect, it } from 'vitest';

import {
  base64urlEncode,
  buildSessionPayload,
  generateUserId,
  SESSION_TOKEN_PREFIX,
  signSession,
  verifySession,
} from '../src/token.js';

async function generatePrivateKeyB64(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return btoa(String.fromCharCode(...pkcs8));
}

describe('hosted session token', () => {
  it('signs and verifies a roundtrip, preserving the payload', async () => {
    const signingKey = await generatePrivateKeyB64();
    const sub = generateUserId();
    const iss = 1_800_000_000;
    const exp = iss + 60 * 60 * 24 * 30;
    const token = await signSession(buildSessionPayload({ sub, iss, exp }), signingKey);

    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    const payload = await verifySession(token, signingKey);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(sub);
    expect(payload!.product).toBe('hosted-session');
    expect(payload!.exp).toBe(exp);
    expect(payload!.v).toBe(1);
  });

  it('rejects a token verified against a different signing key', async () => {
    const keyA = await generatePrivateKeyB64();
    const keyB = await generatePrivateKeyB64();
    const token = await signSession(
      buildSessionPayload({ sub: generateUserId(), iss: 1, exp: 2 }),
      keyA,
    );
    expect(await verifySession(token, keyB)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const signingKey = await generatePrivateKeyB64();
    const token = await signSession(
      buildSessionPayload({ sub: 'hosted_usr_real', iss: 1, exp: 9_999_999_999 }),
      signingKey,
    );
    // Swap the payload half for a forged one; the signature no longer matches.
    const forged =
      SESSION_TOKEN_PREFIX +
      base64urlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            sub: 'hosted_usr_forged',
            product: 'hosted-session',
            iss: 1,
            exp: 9_999_999_999,
            v: 1,
          }),
        ),
      ) +
      '.' +
      token.split('.')[1];
    expect(await verifySession(forged, signingKey)).toBeNull();
  });

  it('rejects a token without the session prefix', async () => {
    const signingKey = await generatePrivateKeyB64();
    expect(await verifySession('amcpe_not_a_session.token', signingKey)).toBeNull();
  });

  it('rejects a token with a mismatched product tag', async () => {
    const signingKey = await generatePrivateKeyB64();
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({ sub: 'hosted_usr_x', product: 'desktop-premium', iss: 1, exp: 9_999_999_999, v: 1 }),
    );
    // Sign the mismatched payload directly so the signature is valid but the
    // product tag is wrong — verifySession must still reject it.
    const der = Uint8Array.from(atob(signingKey), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'Ed25519' }, false, [
      'sign',
    ]);
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payloadBytes);
    const token = `${SESSION_TOKEN_PREFIX}${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
    expect(await verifySession(token, signingKey)).toBeNull();
  });
});
