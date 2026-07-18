/**
 * Route-level tests for `GET /account/export`, the self-serve account export
 * that sits beside `DELETE /account` (custody record §5). Exercised through
 * the same `worker.fetch` entry point as the other route tests. Covers:
 * session auth (401 without a valid token), scope enforcement (403 for a
 * digest-scoped token — an export is not one of the two routes a digest token
 * may reach), owner-only isolation (one account never exports another's data),
 * the never-export-a-credential-value invariant, and the account/network/
 * subscription shape of the body.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, signSession } from '../src/token.js';
import { putCredentials } from '../src/vault.js';
import { putSubscriptionRecord } from '../src/billing.js';
import { vaultMasterKeyProvider } from '../src/env.js';

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

async function generatePrivateKeyB64(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return btoa(String.fromCharCode(...pkcs8));
}

async function randomMasterKeyB64(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

interface TestContext {
  env: Env;
  usersKv: KVNamespace & { store: Map<string, string> };
  vaultKv: KVNamespace & { store: Map<string, string> };
  billingKv: KVNamespace & { store: Map<string, string> };
  signingKey: string;
  userId: string;
  iss: number;
  fullToken: string;
  digestToken: string;
}

async function makeContext(): Promise<TestContext> {
  const usersKv = fakeKV();
  const vaultKv = fakeKV();
  const billingKv = fakeKV();
  const signingKey = await generatePrivateKeyB64();
  const env: Env = {
    HOSTED_USERS: usersKv,
    HOSTED_VAULT: vaultKv,
    HOSTED_BILLING: billingKv,
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: await randomMasterKeyB64(),
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
  };
  const userId = 'hosted_usr_export_test';
  const iss = Math.floor(Date.now() / 1000);
  const fullToken = await signSession(buildSessionPayload({ sub: userId, iss, exp: iss + 3600 }), signingKey);
  const digestToken = await signSession(
    buildSessionPayload({ sub: userId, iss, exp: iss + 900, scope: 'digest' }),
    signingKey,
  );
  return { env, usersKv, vaultKv, billingKv, signingKey, userId, iss, fullToken, digestToken };
}

/** Seed the H2 identity record so the export can surface `account.createdAt`. */
function seedUserRecord(
  usersKv: KVNamespace & { store: Map<string, string> },
  userId: string,
  createdAt: number,
): void {
  usersKv.store.set(`user:${userId}`, JSON.stringify({ id: userId, createdAt, emailHash: 'email-hash:deadbeef' }));
}

function authed(path: string, method: string, token: string): Request {
  return new Request(`https://hosted.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /account/export — auth and scope', () => {
  it('401 missing_session without a token', async () => {
    const { env } = await makeContext();
    const res = await worker.fetch(new Request('https://hosted.test/account/export'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_session' });
  });

  it('401 invalid_session for a token signed by a different key', async () => {
    const { env } = await makeContext();
    const otherKey = await generatePrivateKeyB64();
    const iss = Math.floor(Date.now() / 1000);
    const foreign = await signSession(buildSessionPayload({ sub: 'x', iss, exp: iss + 3600 }), otherKey);
    const res = await worker.fetch(authed('/account/export', 'GET', foreign), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_session' });
  });

  it('403 insufficient_scope for a digest-scoped token (an export is not a digest route)', async () => {
    const ctx = await makeContext();
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'cj', {
      CJ_API_TOKEN: 'super-secret-value',
    });
    const res = await worker.fetch(authed('/account/export', 'GET', ctx.digestToken), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });
});

describe('GET /account/export — body shape', () => {
  it('empty account: 200 with own userId, createdAt from the record, no networks, no subscription', async () => {
    const ctx = await makeContext();
    seedUserRecord(ctx.usersKv, ctx.userId, 1_700_000_000);

    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { userId: string; createdAt: number | null };
      networks: unknown[];
      subscription: unknown;
    };
    expect(body.account.userId).toBe(ctx.userId);
    expect(body.account.createdAt).toBe(1_700_000_000);
    expect(body.networks).toEqual([]);
    expect(body.subscription).toBeNull();
  });

  it('createdAt is null when no identity record exists (token valid, record already gone)', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { createdAt: number | null } };
    expect(body.account.createdAt).toBeNull();
  });

  it('lists connected networks as metadata (slug + timestamps), sorted, never a value', async () => {
    const ctx = await makeContext();
    seedUserRecord(ctx.usersKv, ctx.userId, 1_700_000_000);
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'impact', {
      IMPACT_AUTH_TOKEN: 'impact-secret',
    });
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'awin', {
      AWIN_API_TOKEN: 'awin-secret',
    });

    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    const body = (await res.json()) as {
      networks: Array<{ network: string; createdAt: number; updatedAt: number }>;
    };
    expect(body.networks.map((n) => n.network)).toEqual(['awin', 'impact']); // sorted
    for (const n of body.networks) {
      expect(typeof n.createdAt).toBe('number');
      expect(typeof n.updatedAt).toBe('number');
      // Metadata only: no iv/ciphertext or credential fields leak into the row.
      expect(Object.keys(n).sort()).toEqual(['createdAt', 'network', 'updatedAt']);
    }
  });

  it('never exports a stored credential value anywhere in the response body', async () => {
    const ctx = await makeContext();
    const secret = 'AWIN-TOKEN-2f9c-do-not-leak';
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'awin', {
      AWIN_API_TOKEN: secret,
      AWIN_PUBLISHER_ID: '123456',
    });

    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('123456');
    // The connected network is still surfaced by slug.
    expect(text).toContain('awin');
  });

  it('includes the caller’s own subscription state, billing email included', async () => {
    const ctx = await makeContext();
    seedUserRecord(ctx.usersKv, ctx.userId, 1_700_000_000);
    await putSubscriptionRecord(ctx.env.HOSTED_BILLING, ctx.userId, {
      tier: 'solo',
      status: 'active',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      email: 'buyer@example.com',
      updatedAt: 1_700_000_500,
    });

    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    const body = (await res.json()) as {
      subscription: {
        tier: string;
        status: string;
        billingEmail: string | null;
        stripeCustomerId: string | null;
        stripeSubscriptionId: string | null;
        updatedAt: number;
      } | null;
    };
    expect(body.subscription).toEqual({
      tier: 'solo',
      status: 'active',
      billingEmail: 'buyer@example.com',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      updatedAt: 1_700_000_500,
    });
  });
});

describe('GET /account/export — owner-only isolation', () => {
  it('exports only the caller’s own networks and subscription, never another user’s', async () => {
    const ctx = await makeContext();
    const provider = vaultMasterKeyProvider(ctx.env);

    // Caller owns one network; a different user owns another and a subscription.
    await putCredentials(ctx.env.HOSTED_VAULT, provider, ctx.userId, 'cj', { CJ_API_TOKEN: 'mine' });
    await putCredentials(ctx.env.HOSTED_VAULT, provider, 'hosted_usr_other', 'awin', {
      AWIN_API_TOKEN: 'not-mine-do-not-leak',
    });
    await putSubscriptionRecord(ctx.env.HOSTED_BILLING, 'hosted_usr_other', {
      tier: 'pro',
      status: 'active',
      email: 'other@example.com',
      updatedAt: 1_700_000_000,
    });

    const res = await worker.fetch(authed('/account/export', 'GET', ctx.fullToken), ctx.env);
    const text = await res.text();
    const body = JSON.parse(text) as {
      networks: Array<{ network: string }>;
      subscription: unknown;
    };
    expect(body.networks.map((n) => n.network)).toEqual(['cj']);
    // The other user's subscription and secret never appear.
    expect(body.subscription).toBeNull();
    expect(text).not.toContain('other@example.com');
    expect(text).not.toContain('not-mine-do-not-leak');
    expect(text).not.toContain('awin');
  });
});
