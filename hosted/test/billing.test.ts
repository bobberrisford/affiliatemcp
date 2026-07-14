/**
 * Unit tests for the H6 subscription-state store (`src/billing.ts`). KV is an
 * in-memory fake, matching the existing `hosted/test/*.test.ts` style.
 */

import { describe, expect, it } from 'vitest';

import {
  getSubscriptionRecord,
  getUserIdForSubscription,
  listActiveSubscribers,
  putSubscriptionRecord,
  putSubscriptionReverseIndex,
  resolveEntitlement,
  setEntitlementManual,
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
  it('returns tier "none" for a user who has never subscribed', async () => {
    const kv = fakeKV();
    const entitlement = await resolveEntitlement(kv, 'hosted_usr_never');
    expect(entitlement).toEqual({ tier: 'none', status: 'none' });
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

  it('collapses a lapsed (canceled) subscription to tier "none"', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_b', {
      tier: 'solo',
      status: 'canceled',
      updatedAt: 0,
    });
    expect(await resolveEntitlement(kv, 'hosted_usr_b')).toEqual({ tier: 'none', status: 'canceled' });
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

describe('setEntitlementManual', () => {
  it('grants a tier with no prior record', async () => {
    const kv = fakeKV();
    const record = await setEntitlementManual(kv, 'hosted_usr_new', 'pro');
    expect(record.tier).toBe('pro');
    expect(record.status).toBe('active');
    expect(await resolveEntitlement(kv, 'hosted_usr_new')).toEqual({ tier: 'pro', status: 'active' });
  });

  it('changes an existing tier without disturbing other fields', async () => {
    const kv = fakeKV();
    await putSubscriptionRecord(kv, 'hosted_usr_existing', {
      tier: 'solo',
      status: 'active',
      customerId: 'cus_1',
      email: 'existing@example.com',
      updatedAt: 0,
    });
    const record = await setEntitlementManual(kv, 'hosted_usr_existing', 'pro');
    expect(record.tier).toBe('pro');
    expect(record.customerId).toBe('cus_1');
    expect(record.email).toBe('existing@example.com');
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
