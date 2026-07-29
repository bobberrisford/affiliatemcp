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
import { deleteUser, listCredentialMetadata } from '../vault.js';
import { deleteSubscription, getSubscriptionRecord } from '../billing.js';
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

/**
 * `GET /account/export` — self-serve full account export, the read half of the
 * custody record's "user control" clause
 * (`docs/decisions/2026-07-12-hosted-credential-custody.md` §5) that sits
 * beside `DELETE /account` above. Returns everything this Worker holds ABOUT
 * the caller, across all three KV namespaces, as one JSON document the user
 * can download and keep.
 *
 * Owner-only and full-scope by two mechanisms working together:
 *   - `requireFullSession` verifies the caller's own session token and rejects
 *     digest-scoped tokens with 403 (a digest token can read the two vault
 *     routes it needs and nothing else — it must never export an account).
 *   - Every read below is keyed by `auth.userId`, the subject of that verified
 *     token. There is no request parameter naming a user, so one account can
 *     never export another's data.
 *
 * What it deliberately does NOT include — the same invariant the whole vault
 * upholds (`hosted/README.md` "No credential value ever rendered";
 * `src/vault.ts` "decrypt only at call time"): no credential VALUE, not even
 * masked. The export lists which networks are connected and when
 * (`listCredentialMetadata`, which reads blob metadata but never decrypts),
 * never the stored secrets themselves. A user who wants a live credential back
 * uses the per-network reveal route; the export is a record of what is held,
 * not a secret-exfiltration path, so a leaked export file cannot connect a
 * network on the user's behalf.
 *
 * It DOES include the caller's own billing email (the one plaintext PII this
 * Worker stores, in `HOSTED_BILLING`): an honest "everything we hold about
 * you" export would be misleading if it omitted the contact detail the service
 * keeps. It is the caller's own address, returned only to the caller's own
 * verified session.
 */
export async function handleExportAccount(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  const rawUser = await env.HOSTED_USERS.get(userKey(auth.userId));
  const userRecord = rawUser ? (JSON.parse(rawUser) as StoredUserRecord) : null;

  const networks = await listCredentialMetadata(env.HOSTED_VAULT, auth.userId);
  const subscription = await getSubscriptionRecord(env.HOSTED_BILLING, auth.userId);

  return json(
    {
      exportedAt: Math.floor(Date.now() / 1000),
      account: {
        userId: auth.userId,
        createdAt: userRecord?.createdAt ?? null,
      },
      // Metadata only — which networks, connected/updated when. Never a
      // credential value; see the handler comment above.
      networks,
      subscription: subscription
        ? {
            tier: subscription.tier,
            status: subscription.status,
            billingEmail: subscription.email ?? null,
            stripeCustomerId: subscription.customerId ?? null,
            stripeSubscriptionId: subscription.subscriptionId ?? null,
            updatedAt: subscription.updatedAt,
          }
        : null,
      notes:
        'Credential values are never exported. This lists the networks you have connected and ' +
        'the account and billing data held about you. Use the per-network reveal in your dashboard ' +
        'to see a stored credential, or DELETE /account to erase everything.',
    },
    { status: 200 },
    cors,
  );
}
