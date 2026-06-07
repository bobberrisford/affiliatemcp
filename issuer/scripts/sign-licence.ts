/**
 * Sign a sample licence with the DEV signing key and print the token.
 *
 * Run from the REPO ROOT (so the relative path to licence-keys/ resolves):
 *   npx tsx issuer/scripts/sign-licence.ts
 * or from issuer/:
 *   npm run sign-sample
 *
 * The orchestrator can paste the printed token into the repo's
 * `verifyLicenceToken` to confirm byte-for-byte interop.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPayload, signLicence } from '../src/licence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// issuer/scripts → repo root is two levels up.
const repoRoot = path.resolve(here, '..', '..');
const keyPath = path.join(repoRoot, 'licence-keys', 'dev-signing-key.pkcs8.b64');

async function main(): Promise<void> {
  const privateKeyPkcs8DerB64 = readFileSync(keyPath, 'utf8').trim();

  const payload = buildPayload({
    lid: 'amcp_lid_sample0000000000000000000000000000',
    email: 'dev@example.com',
    issued: '2026-06-07',
  });

  const token = await signLicence(payload, privateKeyPkcs8DerB64);

  console.log('payload :', JSON.stringify(payload));
  console.log('token   :', token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
