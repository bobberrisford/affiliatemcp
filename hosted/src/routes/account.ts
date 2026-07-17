/**
 * `DELETE /account` — complete account deletion, per the custody record's
 * "user control" clause (`docs/decisions/2026-07-12-hosted-credential-custody.md`
 * §5): self-serve hard delete of the account, credentials included, at any
 * time, not a soft flag.
 *
 * What this deletes, across all three KV namespaces — `HOSTED_USERS` (H2's
 * identity KV), `HOSTED_VAULT` (H3's credential KV), and `HOSTED_BILLING`
 * (H6's subscription KV):
 *   - `vault:key:<userId>`            — the user's wrapped data key
 *   - `vault:cred:<userId>:<network>` — every connected network's credential
 *   - `user:<userId>`                 — the account record
 *   - `email-hash:<hmacHex>`          — the email-to-user lookup, so the
 *     address is not left pointing at a deleted account
 *   - `sub:<userId>`                  — the subscription record, including
 *     the plaintext billing email (the one piece of PII this Worker holds);
 *     removing it also takes the user off the scheduled digest's roster
 *     (`listActiveSubscribers`, `src/billing.ts`) — a deleted account must
 *     never be emailed again
 *   - `stripe-sub:<subId>`            — the Stripe reverse-index entry, when
 *     the record named one, so the subscription id does not resolve to a
 *     deleted user
 *
 * Requires a FULL session (`requireFullSession`): a digest-scoped token can
 * read the two vault routes it needs and nothing else — it must never be
 * able to destroy an account.
 *
 * What this deliberately does NOT delete or do, and why:
 *   - The user's own already-issued session token(s). Session tokens are
 *     stateless (Ed25519-signed, verified by recomputing the signature —
 *     see `src/token.ts`), so there is no server-side session record to
 *     revoke. A token issued before deletion remains cryptographically
 *     valid until its natural 30-day expiry, but every route that would use
 *     it to reach account data or vault contents now finds nothing: no user
 *     record, no vault entries, no billing record. This is a known
 *     limitation, not a silent gap — a revocation mechanism (e.g. a short
 *     denylist keyed by token, or shortening session lifetime) is future
 *     work for whoever builds out H4's transport hardening, not required
 *     for H3's deletion contract to be honest about what "deleted" means
 *     today.
 *   - Cancelling the live Stripe subscription itself. Deleting the stored
 *     billing state removes every piece of PII and stops every digest send,
 *     but Stripe keeps billing until the subscription is cancelled on
 *     Stripe's side — a Rob-side operational step until a self-serve
 *     billing-portal route exists (see `hosted/README.md`, "What this slice
 *     deliberately does not do"). The webhook cannot resurrect the deleted
 *     record into a send: a later `customer.subscription.updated` event
 *     could rewrite `sub:<userId>` from Stripe's own data, which is why
 *     cancelling in Stripe is documented as part of the deletion runbook.
 *   - `pending-link:<sha256Hex>` and `rl:*` rate-limit counters. These are
 *     TTL'd, self-expiring, and keyed by one-way hashes of an email address
 *     or IP, never a user id — there is nothing account-identifying left
 *     behind, and no user-scoped key to find them by (the request-link flow
 *     never records which user, if any, a pending link resolves to before
 *     it is redeemed).
 */

import type { Env } from '../env.js';
import { json } from '../http.js';
import { deleteUser } from '../vault.js';
import { deleteSubscription } from '../billing.js';
import { requireFullSession } from './guard.js';

interface StoredUserRecord {
  id: string;
  createdAt: number;
  emailHash?: string;
}

const userKey = (id: string) => `user:${id}`;

export async function handleDeleteAccount(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  const raw = await env.HOSTED_USERS.get(userKey(auth.userId));
  if (raw) {
    const record = JSON.parse(raw) as StoredUserRecord;
    if (record.emailHash) {
      await env.HOSTED_USERS.delete(record.emailHash);
    }
    await env.HOSTED_USERS.delete(userKey(auth.userId));
  }

  await deleteUser(env.HOSTED_VAULT, auth.userId);
  await deleteSubscription(env.HOSTED_BILLING, auth.userId);

  return json({ ok: true }, { status: 200 }, cors);
}
