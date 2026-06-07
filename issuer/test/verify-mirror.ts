/**
 * A faithful mirror of the repo's `verifyLicenceToken` (src/shared/config.ts),
 * using Node crypto.verify against the DEV public key. The token round-trip
 * test runs the issuer's signer through THIS verifier — if it passes here, it
 * passes in the shipped app, because the logic is identical.
 *
 * Keep this in sync with src/shared/config.ts. (Tests would catch drift.)
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// DEV public key (SPKI DER base64) — matches LICENCE_PUBLIC_KEY_SPKI_B64 in the repo.
export const LICENCE_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEAJGmqSI8zTKHXsqIBH0jpUfL9+FP+/WJxZpODnviRWAI=';

const LICENCE_TOKEN_PREFIX = 'amcp_';

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('invalid base64url');
  const buf = Buffer.from(input, 'base64url');
  if (base64urlEncode(buf) !== input) throw new Error('invalid base64url');
  return buf;
}

export interface LicenceValid {
  valid: true;
  email: string;
  issued: string;
  lid: string;
}
export interface LicenceInvalid {
  valid: false;
  reason: string;
}
export type LicenceResult = LicenceValid | LicenceInvalid;

export function verifyLicenceToken(token: string): LicenceResult {
  if (typeof token !== 'string' || !token.startsWith(LICENCE_TOKEN_PREFIX)) {
    return { valid: false, reason: 'Not a valid licence key.' };
  }
  const body = token.slice(LICENCE_TOKEN_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { valid: false, reason: 'Licence key is malformed.' };
  }
  const [p, s] = parts as [string, string];

  let payloadBytes: Buffer;
  let sigBytes: Buffer;
  try {
    payloadBytes = base64urlDecode(p);
    sigBytes = base64urlDecode(s);
  } catch {
    return { valid: false, reason: 'Licence key is malformed.' };
  }

  let signatureOk: boolean;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(LICENCE_PUBLIC_KEY_SPKI_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    signatureOk = cryptoVerify(null, payloadBytes, publicKey, sigBytes);
  } catch {
    return { valid: false, reason: 'Licence signature could not be verified.' };
  }
  if (!signatureOk) return { valid: false, reason: 'Licence signature is invalid.' };

  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { valid: false, reason: 'Licence payload is not readable.' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, reason: 'Licence payload is not readable.' };
  }
  const { lid, email, product, issued, v } = payload as Record<string, unknown>;
  if (v !== 1) return { valid: false, reason: 'Licence version is not supported.' };
  if (product !== 'desktop') return { valid: false, reason: 'Licence is not for this product.' };
  if (typeof lid !== 'string' || typeof email !== 'string' || typeof issued !== 'string') {
    return { valid: false, reason: 'Licence payload is incomplete.' };
  }
  return { valid: true, email, issued, lid };
}
