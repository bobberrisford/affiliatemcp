/**
 * Mint a licence with the local signing key and print the token.
 *
 * Issues a real, offline-verifiable licence bound to an email — use it to mint
 * comp / test / share keys without going through Stripe. Licences cannot be
 * revoked (no phone-home by design), so only hand these to people you mean to.
 *
 * Run from the REPO ROOT (so the relative path to licence-keys/ resolves):
 *   npx tsx issuer/scripts/sign-licence.ts --email someone@example.com
 * Email defaults to dev@example.com when omitted. Each run gets a unique lid.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPayload, signLicence, generateLid, todayIssued } from '../src/licence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// issuer/scripts → repo root is two levels up.
const repoRoot = path.resolve(here, '..', '..');
const keyPath = path.join(repoRoot, 'licence-keys', 'dev-signing-key.pkcs8.b64');

/** Parse `--email <addr>` (or `--email=addr`); fall back to dev@example.com. */
function parseEmail(argv: string[]): string {
  const eq = argv.find((a) => a.startsWith('--email='));
  if (eq) return eq.slice('--email='.length);
  const i = argv.indexOf('--email');
  if (i >= 0 && argv[i + 1]) return argv[i + 1] as string;
  return 'dev@example.com';
}

async function main(): Promise<void> {
  const privateKeyPkcs8DerB64 = readFileSync(keyPath, 'utf8').trim();

  const payload = buildPayload({
    lid: generateLid(),
    email: parseEmail(process.argv.slice(2)),
    issued: todayIssued(),
  });

  const token = await signLicence(payload, privateKeyPkcs8DerB64);

  console.log('payload :', JSON.stringify(payload));
  console.log('token   :', token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
