# Hosted secrets: key-rotation runbook

The credential-custody decision requires a documented key-rotation procedure to
exist before launch (`docs/decisions/2026-07-12-hosted-credential-custody.md`,
item 2). This is that procedure. It covers every secret the hosted Worker holds,
in priority order, and the two that need more than a plain `wrangler secret put`.

No secret rotates automatically. Rotation is a deliberate maintainer action.
Rotate on any suspicion of exposure, on staff or tooling changes that had
access, and otherwise on a periodic cadence the maintainer sets.

Secrets are set on the Worker with `npx wrangler secret put <NAME>` and never
held in CI. Wrangler secrets are single-slot and write-only: you cannot read the
current value back, so if a rotation script needs the old value, capture it
before you overwrite the secret.

## The secrets, and what each one protects

| Secret | Blast radius if leaked | Rotation |
| --- | --- | --- |
| `VAULT_MASTER_KEY` | Wraps every user's data key. With the `HOSTED_VAULT` KV contents as well, it decrypts every stored credential. | Special: re-wrap procedure below. |
| `SESSION_SIGNING_KEY` | The crown jewel: the Ed25519 private key that mints session tokens for any user. | Special: re-hash procedure below. |
| `STRIPE_SECRET_KEY` | Full Stripe API access — billing compromise. Reaches no affiliate data. | Plain `wrangler secret put`; rotate the key in the Stripe dashboard first. |
| `STRIPE_WEBHOOK_SECRET` | Lets an attacker forge subscription-lifecycle events (entitlement state). Cannot read credentials, data, or email. | Plain `wrangler secret put`; roll the signing secret in the Stripe webhook settings. |
| `RESEND_API_KEY` | Send email as the verified domain. Reaches no affiliate data. | Plain `wrangler secret put`; rotate in Resend. Note: the maintainer has elected not to rotate this on a schedule; rotate on suspicion. |
| `DIGEST_COMPOSE_SECRET` (optional) | A shared doorbell between the Worker and the compose service, not a key over any data. | Plain `wrangler secret put`; set the same value on both sides. |

For the plain-rotation secrets, the procedure is: rotate the value at the
provider (Stripe / Resend), `npx wrangler secret put <NAME>` with the new value,
and — for `DIGEST_COMPOSE_SECRET` — update the compose service's environment to
match. No data migration is involved.

## Rotating `VAULT_MASTER_KEY` (re-wrap, no re-encryption)

The master key only *wraps* each user's data key; it never encrypts credential
blobs directly. Rotation therefore re-wraps one small key per user and never
touches the credential ciphertext. The `keyVersion` tag on each wrapped key is
what lets rotation tell "already migrated" from "still on the old key", so the
version bump below is load-bearing — reusing a version for a different secret
makes the migration undetectable.

1. Generate a fresh 32-byte key: `npm run gen-vault-key`.
2. **Capture the current `VAULT_MASTER_KEY` value first** (you cannot read it
   back after the next step, and the re-wrap needs both old and new).
3. Set the new value: `npx wrangler secret put VAULT_MASTER_KEY`.
4. **Bump `VAULT_MASTER_KEY_VERSION` in `hosted/wrangler.toml`** to a new
   integer. This is what makes the rotation detectable and resumable.
5. Run the re-wrap once, from an operational script or a one-off Worker route
   restricted to the maintainer, calling
   `rotateMasterKey(kv, oldProvider, newProvider)` (`hosted/src/vault.ts`) with:
   - `oldProvider = workerSecretMasterKey(oldSecret, oldVersion)`
   - `newProvider = workerSecretMasterKey(newSecret, newVersion)`

   It re-wraps every user's data key and returns `{ rotated, skipped }`. It is
   safe to re-run: already-rotated keys are skipped, not re-rotated.
6. Re-run and confirm `{ skipped: 0 }` for the old provider before discarding
   the old secret value. Credential blobs are never read or rewritten by this
   procedure — only the wrapped data keys.

## Rotating `SESSION_SIGNING_KEY` (re-hash the email lookups)

`SESSION_SIGNING_KEY` does two jobs: it signs session tokens, and it is the HMAC
key behind the `email-hash:<hmac>` lookup entries in the identity store. Rotating
it therefore has two consequences beyond invalidating outstanding sessions:

- **Every issued session token stops verifying** the moment the new key is live.
  Users signed in with a pre-rotation token must sign in again. Sessions are
  stateless (verified by recomputing the signature), so there is nothing to
  revoke server-side; the rotation itself is the revocation.
- **Every `email-hash:` lookup key silently changes**, because the hash is keyed
  by this secret. Left unaddressed, existing users could no longer be found by
  email at sign-in. A rotation therefore must **re-derive and rewrite every
  `email-hash:` entry** in the identity KV from the stored user records, under
  the new key, as part of the same operation.

Procedure:

1. Generate a fresh keypair: `npm run gen-keypair` (Ed25519, PKCS8 DER base64).
2. Before overwriting, run (or stage) a migration that, under the **new** key,
   recomputes each user's `email-hash:` entry and rewrites the identity KV so
   the lookup still resolves. Because the plaintext address is not stored, this
   migration needs the source of email addresses it was originally derived from;
   plan it before rotating, not after.
3. `npx wrangler secret put SESSION_SIGNING_KEY` with the new value.
4. Communicate that a re-sign-in is expected (all outstanding sessions drop).

Because of the email-hash coupling, treat a `SESSION_SIGNING_KEY` rotation as a
planned maintenance operation, not a routine secret swap.

## After any rotation

- Confirm the hosted Worker still serves: `GET /health` returns 200, and
  `GET /.well-known/oauth-authorization-server` returns the expected `issuer`.
- For a vault rotation, confirm `{ skipped: 0 }` on a re-run before removing the
  old key material.
- Record the rotation (which secret, when, why) wherever the maintainer keeps
  the operational log, so the disclosure runbook can reference it if needed.

## Related

- `hosted/README.md` — "Vault (H3)" and the deploy checklist, the source these
  steps are drawn from.
- `docs/security/hosted-incident-response.md` — when a rotation is part of
  incident containment.
- `docs/decisions/2026-07-12-hosted-credential-custody.md` — the requirement.
