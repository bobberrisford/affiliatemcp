/**
 * Unit tests for the H6 subscription-state store (`src/billing.ts`). KV is an
 * in-memory fake, matching the existing `hosted/test/*.test.ts` style.
 */

import { describe, expect, it } from 'vitest';

import {
  deleteSubscription,
  getSubscriptionRecord,
  getUserIdForSubscription,
  listActiveSubscribers,
  putSubscriptionRecord,
  putSubscriptionReverseIndex,
  resolveEntitlement,
  tierEntitledToDigest,
  type SubscriptionRecord,
} from '../src/billing.js';

function fakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => {
      void cursor;
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('resolveEntitlement', () => {
  it('returns tier "free" for a user who has never subscribed', async () => {
    const kv = fakeKV();
    const entitlement = await resolveEntitlement(kv, 'hosted_usr_never');
    expect(entitlement).toEqual({ tier: 'free', status: 'none' });
  });

  it('returns the stored tier for an active subscription', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_a', {
      tier: 'pro',
      status: 'active',
      updatedAt: 0,
    });
    expect(await resolveEntitlement(kv, 'hosted_usr_a')).toEqual({ tier: 'pro', status: 'active' });
  });

  it('collapses a lapsed (canceled) subscription to tier "free"', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_b', {
      tier: 'solo',
      status: 'canceled',
      updatedAt: 0,
    });
    expect(await resolveEntitlement(kv, 'hosted_usr_b')).toEqual({ tier: 'free', status: 'canceled' });
  });

  it('treats "trialing" as an active tier', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_c', {
      tier: 'solo',
      status: 'trialing',
      updatedAt: 0,
    });
    expect(await resolveEntitlement(kv, 'hosted_usr_c')).toEqual({ tier: 'solo', status: 'trialing' });
  });
});

describe('subscription reverse index', () => {
  it('resolves a Stripe subscription id back to its owning userId', async () => {
    const kv = fakeKV();
    await putSubscriptionReverseIndex(kv, 'sub_123', 'hosted_usr_x');
    expect(await getUserIdForSubscription(kv, 'sub_123')).toBe('hosted_usr_x');
    expect(await getUserIdForSubscription(kv, 'sub_unknown')).toBeNull();
  });
});

describe('deleteSubscription', () => {
  it('deletes the subscription record and its Stripe reverse-index entry', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_del', {
      tier: 'pro',
      status: 'active',
      subscriptionId: 'sub_del_1',
      email: 'delete-me@example.com',
      updatedAt: 0,
    });
    await putSubscriptionReverseIndex(kv, 'sub_del_1', 'hosted_usr_del');

    await deleteSubscription(kv, 'hosted_usr_del');

    expect(await getSubscriptionRecord(kv, 'hosted_usr_del')).toBeNull();
    expect(await getUserIdForSubscription(kv, 'sub_del_1')).toBeNull();
    // Nothing PII-bearing survives anywhere in the namespace.
    expect(JSON.stringify([...kv.store.entries()])).not.toContain('delete-me@example.com');
  });

  it('removes the user from the digest roster', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_roster', { tier: 'solo', status: 'active', updatedAt: 0 });
    expect(await listActiveSubscribers(kv)).toHaveLength(1);

    await deleteSubscription(kv, 'hosted_usr_roster');

    expect(await listActiveSubscribers(kv)).toEqual([]);
  });

  it('is idempotent for a user who never subscribed', async () => {
    const kv = fakeKV();
    await expect(deleteSubscription(kv, 'hosted_usr_never')).resolves.toBeUndefined();
  });
});

describe('listActiveSubscribers', () => {
  it('returns only active/trialing subscribers, ids and tiers only, sorted', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_b', { tier: 'pro', status: 'active', updatedAt: 0 });
    await putSubscriptionRecord(kv, 'hosted_usr_a', { tier: 'solo', status: 'trialing', updatedAt: 0 });
    await putSubscriptionRecord(kv, 'hosted_usr_c', { tier: 'solo', status: 'canceled', updatedAt: 0 });
    await putSubscriptionRecord(kv, 'hosted_usr_d', { tier: 'pro', status: 'past_due', updatedAt: 0 });

    const subscribers = await listActiveSubscribers(kv);

    expect(subscribers).toEqual([
      { userId: 'hosted_usr_a', tier: 'solo' },
      { userId: 'hosted_usr_b', tier: 'pro' },
    ]);
    // Never carries an email field even though the underlying record type allows one.
    for (const s of subscribers) {
      expect(Object.keys(s).sort()).toEqual(['tier', 'userId']);
    }
  });

  it('returns an empty roster when nobody has ever subscribed', async () => {
    expect(await listActiveSubscribers(fakeKV())).toEqual([]);
  });
});

describe('tierEntitledToDigest', () => {
  it('denies every digest type for tier "none"', () => {
    expect(tierEntitledToDigest('none', 'earnings')).toBe(false);
    expect(tierEntitledToDigest('none', 'unpaid-commissions')).toBe(false);
  });

  it('denies every digest type for the metered free tier', () => {
    expect(tierEntitledToDigest('free', 'earnings')).toBe(false);
    expect(tierEntitledToDigest('free', 'unpaid-commissions')).toBe(false);
  });

  it('allows only the earnings digest for solo', () => {
    expect(tierEntitledToDigest('solo', 'earnings')).toBe(true);
    expect(tierEntitledToDigest('solo', 'unpaid-commissions')).toBe(false);
  });

  it('allows every digest type for pro', () => {
    expect(tierEntitledToDigest('pro', 'earnings')).toBe(true);
    expect(tierEntitledToDigest('pro', 'unpaid-commissions')).toBe(true);
  });
});

describe('getSubscriptionRecord', () => {
  it('returns null for a userId with no record', async () => {
    expect(await getSubscriptionRecord(fakeKV(), 'hosted_usr_none')).toBeNull();
  });

  it('round-trips a full record', async () => {
    const kv = fakeKV();
    const record: SubscriptionRecord = {
      tier: 'pro',
      status: 'active',
      customerId: 'cus_x',
      subscriptionId: 'sub_x',
      email: 'user@example.com',
      updatedAt: 1700000000,
    };
    await putSubscriptionRecord(kv, 'hosted_usr_full', record);
    expect(await getSubscriptionRecord(kv, 'hosted_usr_full')).toEqual(record);
  });
});
