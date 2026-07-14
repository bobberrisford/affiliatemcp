/**
 * Hosted subscription-state store (workstream slice H6:
 * `docs/product/hosted-mvp-workstream.md`). Reuses the entitlement-issuer
 * Worker's proven shape (`issuer/src/index.ts`: KV subscription record +
 * Stripe checkout/webhook lifecycle) rather than inventing a new one, per
 * the pricing decision `docs/decisions/2026-07-12-pricing-billing-and-licence.md`
 * ("hosted entitlement reuses the same subscription state at the transport
 * boundary later").
 *
 * Distinct from issuer's model in one deliberate way: issuer's subscriber is
 * an anonymous `accountKey` (the desktop app has no user auth of its own), so
 * issuer resolves akey -> subscription via `client_reference_id`. The hosted
 * Worker already has a real authenticated userId (H2's session token), so
 * this store keys directly on that userId and carries `tier` as first-class
 * state — not just active/inactive, but WHICH tier — because H6's transport
 * gate and digest job both need to know solo vs pro, not just "paid".
 *
 * KV shape, in a THIRD namespace (`HOSTED_BILLING`), separate from
 * `HOSTED_USERS` (H2, no affiliate data) and `HOSTED_VAULT` (H3, encrypted
 * credentials only):
 *   sub:<userId>              -> JSON SubscriptionRecord
 *   stripe-sub:<subId>        -> <userId>   (reverse index for webhook events)
 *   evt:<eventId>             -> "1"        (idempotency marker, TTL'd)
 *
 * `SubscriptionRecord.email` is the ONE deliberate exception to this
 * project's "no raw email address in this Worker" posture (see
 * `hosted/README.md`, H2's "Email-key hashing trade-off"): a paid
 * subscription needs a billing email for Stripe receipts and (per the
 * pricing decision) VAT invoices at the Team tier, and Stripe Checkout
 * already collects one. Storing it here, in the billing-only KV namespace,
 * does not touch `HOSTED_USERS`'s existing no-PII invariant — it is a new,
 * narrower exception scoped to exactly the purpose email already serves in
 * this design (billing, and now digest delivery), never analytics. See
 * `hosted/README.md` "H6: digest and billing" for the full write-up.
 */

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

export type HostedTier = 'none' | 'solo' | 'pro';
export type PaidHostedTier = 'solo' | 'pro';

/** Stored subscription record, keyed by hosted userId. */
export interface SubscriptionRecord {
  tier: PaidHostedTier;
  status: string; // Stripe subscription status, or 'pending' before first webhook event
  customerId?: string;
  subscriptionId?: string;
  /** Billing email captured at Stripe Checkout. See the file header for why this is the one
   * place in the hosted service that holds a plaintext address. Never logged. */
  email?: string;
  updatedAt: number; // unix seconds
}

export interface Entitlement {
  tier: HostedTier;
  status: string;
}

const subKey = (userId: string): string => `sub:${userId}`;
const stripeSubKey = (subscriptionId: string): string => `stripe-sub:${subscriptionId}`;

export function isActiveStatus(status: string | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

/** Read one user's raw subscription record, or `null` if they have never subscribed. */
export async function getSubscriptionRecord(kv: KVNamespace, userId: string): Promise<SubscriptionRecord | null> {
  const raw = await kv.get(subKey(userId));
  return raw ? (JSON.parse(raw) as SubscriptionRecord) : null;
}

export async function putSubscriptionRecord(
  kv: KVNamespace,
  userId: string,
  record: SubscriptionRecord,
): Promise<void> {
  await kv.put(subKey(userId), JSON.stringify(record));
}

/** The entitlement the transport boundary and the digest job both consult: a closed `none | solo
 * | pro` tier plus the raw Stripe status for display/debugging. `none` covers "never
 * subscribed" and "subscription lapsed" identically — the transport gate does not need to
 * distinguish them, matching the issuer Worker's `active` boolean collapsing the same cases. */
export async function resolveEntitlement(kv: KVNamespace, userId: string): Promise<Entitlement> {
  const record = await getSubscriptionRecord(kv, userId);
  if (!record || !isActiveStatus(record.status)) {
    return { tier: 'none', status: record?.status ?? 'none' };
  }
  return { tier: record.tier, status: record.status };
}

/** Reverse index: map a Stripe subscription id back to the hosted userId that owns it, for
 * `customer.subscription.updated`/`.deleted` events that do not carry `client_reference_id`. */
export async function getUserIdForSubscription(kv: KVNamespace, subscriptionId: string): Promise<string | null> {
  return kv.get(stripeSubKey(subscriptionId));
}

export async function putSubscriptionReverseIndex(
  kv: KVNamespace,
  subscriptionId: string,
  userId: string,
): Promise<void> {
  await kv.put(stripeSubKey(subscriptionId), userId);
}

/**
 * Complete billing-state deletion for one user: the `sub:<userId>` record
 * (which carries the plaintext billing email — the one piece of PII this
 * Worker holds) and, when the record names a Stripe subscription, its
 * `stripe-sub:<subId>` reverse-index entry. Called by `DELETE /account`
 * (`routes/account.ts`) so account deletion is complete across all three KV
 * namespaces, per the custody record's clause 5 — without this, a deleted
 * user's billing email would survive deletion and `listActiveSubscribers`
 * would keep them on the digest roster. Idempotent: deleting a user who
 * never subscribed is a no-op. Cancelling the live Stripe subscription
 * itself is a separate, Rob-side operational step (see `hosted/README.md`);
 * this removes every piece of stored state.
 */
export async function deleteSubscription(kv: KVNamespace, userId: string): Promise<void> {
  const record = await getSubscriptionRecord(kv, userId);
  if (record?.subscriptionId) {
    await kv.delete(stripeSubKey(record.subscriptionId));
  }
  await kv.delete(subKey(userId));
}

/** One row of the scheduled digest's subscriber roster: an id and a tier — WHO to run for and
 * WHICH digest(s) they are entitled to, nothing more. The full record (email included) is only
 * loaded later, at send time, inside the Worker (`src/digest.ts`). */
export interface SubscriberSummary {
  userId: string;
  tier: PaidHostedTier;
}

/**
 * List every user with an active paid subscription, for the Worker's own
 * scheduled digest handler (`src/digest.ts`) — enumerated in-process from
 * this KV, never exposed over HTTP (Rob's 2026-07-14 decision: no credential
 * may enumerate tenants from outside the Worker). KV `list` does not support
 * "value contains X" queries, so this walks every `sub:` key; that is the
 * right and only shape here — the digest runs at most a few times a week
 * over a subscriber base this KV is sized for, not a hot path.
 */
export async function listActiveSubscribers(kv: KVNamespace): Promise<SubscriberSummary[]> {
  const prefix = 'sub:';
  const out: SubscriberSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) {
      const raw = await kv.get(entry.name);
      if (!raw) continue;
      const record = JSON.parse(raw) as SubscriptionRecord;
      if (isActiveStatus(record.status)) {
        out.push({ userId: entry.name.slice(prefix.length), tier: record.tier });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Which digest types a tier is entitled to receive. Solo: weekly earnings only, per the pricing
 * decision. Pro: earnings plus the unpaid-commissions digest. `none` (lapsed or never
 * subscribed) is entitled to nothing — `src/digest.ts` re-checks this against the freshly-read
 * record at send time, so a roster entry that lapsed mid-run can never over-send. */
export type DigestType = 'earnings' | 'unpaid-commissions';

export function tierEntitledToDigest(tier: HostedTier, digestType: DigestType): boolean {
  if (tier === 'pro') return true;
  if (tier === 'solo') return digestType === 'earnings';
  return false;
}

export { ACTIVE_STATUSES };
