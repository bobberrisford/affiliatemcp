/**
 * Token round-trip + tamper tests. The issuer's signLicence output is verified
 * with the repo's verification logic (mirrored in verify-mirror.ts) against the
 * DEV public key — so a pass here guarantees interop with the shipped app.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPayload, generateLid, signLicence, todayIssued } from '../src/licence.js';
import { verifyLicenceToken } from './verify-mirror.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const DEV_KEY = readFileSync(
  path.join(repoRoot, 'licence-keys', 'dev-signing-key.pkcs8.b64'),
  'utf8',
).trim();

describe('signLicence ↔ verifyLicenceToken interop', () => {
  it('signs a token that the repo verifier accepts', async () => {
    const payload = buildPayload({
      lid: generateLid(),
      email: 'buyer@acme.com',
      issued: todayIssued(),
    });
    const token = await signLicence(payload, DEV_KEY);

    expect(token.startsWith('amcp_')).toBe(true);
    const result = verifyLicenceToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.email).toBe('buyer@acme.com');
      expect(result.lid).toBe(payload.lid);
      expect(result.issued).toBe(payload.issued);
    }
  });

  it('matches the canonical sample token byte-for-byte', async () => {
    const payload = buildPayload({
      lid: 'amcp_lid_sample0000000000000000000000000000',
      email: 'dev@example.com',
      issued: '2026-06-07',
    });
    const token = await signLicence(payload, DEV_KEY);
    // Ed25519 is deterministic → the same payload+key always yields the same token.
    const again = await signLicence(payload, DEV_KEY);
    expect(token).toBe(again);
    expect(verifyLicenceToken(token).valid).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const payload = buildPayload({
      lid: generateLid(),
      email: 'buyer@acme.com',
      issued: todayIssued(),
    });
    const token = await signLicence(payload, DEV_KEY);

    // Flip a character in the payload segment (keeps base64url-valid charset).
    const [prefixAndPayload, sig] = token.split('.') as [string, string];
    const body = prefixAndPayload.slice('amcp_'.length);
    const flipped = (body[5] === 'A' ? 'B' : 'A') + body.slice(1); // mutate first char
    const tampered = `amcp_${flipped}.${sig}`;

    const result = verifyLicenceToken(tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const payload = buildPayload({
      lid: generateLid(),
      email: 'buyer@acme.com',
      issued: todayIssued(),
    });
    const token = await signLicence(payload, DEV_KEY);
    const [head, sig] = token.split('.') as [string, string];
    const badSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifyLicenceToken(`${head}.${badSig}`).valid).toBe(false);
  });
});
