#!/usr/bin/env tsx
/**
 * Ed25519 licence keypair generator (desktop-app-plan.md §2A).
 *
 * Generates ONE Ed25519 keypair for signing/verifying licence tokens and
 * prints the key material in the encodings each side needs:
 *
 *   - PUBLIC key as SPKI DER, base64  → embedded verbatim in the binary as
 *     `LICENCE_PUBLIC_KEY_SPKI_B64` in `src/shared/config.ts`.
 *   - PRIVATE key as PKCS8 PEM and PKCS8 DER base64 → held only by the Worker
 *     (the licence issuer), stored as its `LICENCE_SIGNING_KEY` secret.
 *
 * When run with `--write`, the private key is also written to:
 *   - `licence-keys/dev-signing-key.pem`        (PKCS8 PEM)
 *   - `licence-keys/dev-signing-key.pkcs8.b64`  (PKCS8 DER, base64)
 * and the public SPKI base64 to `licence-keys/dev-public-key.spki.b64`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DEV KEY ONLY. The committed `LICENCE_PUBLIC_KEY_SPKI_B64` and the key in  │
 * │ `licence-keys/` are a DEVELOPMENT pair. The `licence-keys/` dir is        │
 * │ gitignored so the private key is NEVER committed.                         │
 * │                                                                            │
 * │ FOR PRODUCTION: a human regenerates the pair (`tsx                        │
 * │ scripts/generate-licence-keypair.ts --write`), replaces the embedded      │
 * │ public key in `src/shared/config.ts`, and stores the private key as the   │
 * │ Worker's `LICENCE_SIGNING_KEY` secret. The dev private key must never     │
 * │ leave a developer machine.                                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   tsx scripts/generate-licence-keypair.ts            # print only
 *   tsx scripts/generate-licence-keypair.ts --write    # also write licence-keys/
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function main(): void {
  const write = process.argv.includes('--write');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const publicSpkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privatePkcs8Pem = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const privatePkcs8B64 = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');

  process.stdout.write('\n=== Ed25519 licence keypair (DEV) ===\n\n');
  process.stdout.write('PUBLIC KEY (SPKI DER, base64) — embed as LICENCE_PUBLIC_KEY_SPKI_B64:\n');
  process.stdout.write(`${publicSpkiB64}\n\n`);
  process.stdout.write('PRIVATE KEY (PKCS8 PEM) — Worker LICENCE_SIGNING_KEY:\n');
  process.stdout.write(`${privatePkcs8Pem}\n`);
  process.stdout.write('PRIVATE KEY (PKCS8 DER, base64):\n');
  process.stdout.write(`${privatePkcs8B64}\n\n`);

  if (write) {
    const dir = path.join(repoRoot, 'licence-keys');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'dev-signing-key.pem'), privatePkcs8Pem, { mode: 0o600 });
    writeFileSync(path.join(dir, 'dev-signing-key.pkcs8.b64'), `${privatePkcs8B64}\n`, {
      mode: 0o600,
    });
    writeFileSync(path.join(dir, 'dev-public-key.spki.b64'), `${publicSpkiB64}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`Wrote dev keys to ${dir}/ (gitignored).\n`);
    process.stdout.write(
      'Remember: this is a DEV key. For production, regenerate and store the ' +
        'private key as the Worker LICENCE_SIGNING_KEY secret.\n',
    );
  }
}

main();
