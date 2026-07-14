/**
 * Route-level tests for the H6 billing, admin, and digest routes, exercised
 * through the same `worker.fetch` entry point as `test/worker.test.ts` and
 * `test/vault-routes.test.ts`. Stripe and Resend are mocked via a spy on
 * `fetch`; KV is an in-memory fake. No live network calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, signSession } from '../src/token.js';
import { putSubscriptionRecord } from '../src/billing.js';
import { signStripePayloadForTest } from '../src/stripe.js';

function fakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      void opts;
      store.set(k, v);
    },
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

const TEST_VAULT_MASTER_KEY_B64 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const SERVICE_SECRET = 'test-service-secret';
const STRIPE_WEBHOOK_SECRET = 'whsec_test';

async function makeEnv(signingKey: string, overrides: Partial<Env> = {}): Promise<{ env: Env; billingKv: ReturnType<typeof fakeKV> }> {
  const billingKv = fakeKV();
  const env: Env = {
    HOSTED_USERS: fakeKV(),
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: billingKv,
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: TEST_VAULT_MASTER_KEY_B64,
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET,
    HOSTED_SERVICE_SECRET: SERVICE_SECRET,
    STRIPE_PRICE_ID_SOLO: 'price_solo',
    STRIPE_PRICE_ID_PRO: 'price_pro',
    BILLING_SUCCESS_URL: 'https://hosted.test/success',
    BILLING_CANCEL_URL: 'https://hosted.test/cancel',
    ...overrides,
  };
  return { env, billingKv };
}

async function issueSessionToken(signingKey: string, userId: string): Promise<string> {
  const iss = Math.floor(Date.now() / 1000);
  const exp = iss + 60 * 60 * 24 * 30;
  return signSession(buildSessionPayload({ sub: userId, iss, exp }), signingKey);
}

function req(path: string, method: string, opts: { token?: string; serviceSecret?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.serviceSecret) headers['authorization'] = `Bearer ${opts.serviceSecret}`;
  return new Request(`https://hosted.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /billing/checkout', () => {
  it('requires a session', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(req('/billing/checkout', 'POST', { body: { tier: 'solo' } }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid tier', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey);
    const token = await issueSessionToken(signingKey, 'hosted_usr_1');
    const res = await worker.fetch(req('/billing/checkout', 'POST', { token, body: { tier: 'ultra' } }), env);
    expect(res.status).toBe(400);
  });

  it('returns billing_not_configured when Stripe price ids are unset', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey, { STRIPE_PRICE_ID_SOLO: undefined });
    const token = await issueSessionToken(signingKey, 'hosted_usr_1');
    const res = await worker.fetch(req('/billing/checkout', 'POST', { token, body: { tier: 'solo' } }), env);
    expect(res.status).toBe(503);
  });

  it('creates a Stripe Checkout Session tying the userId and tier into its metadata', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey);
    const token = await issueSessionToken(signingKey, 'hosted_usr_1');
    const stripeSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }), { status: 200 }));

    const res = await worker.fetch(req('/billing/checkout', 'POST', { token, body: { tier: 'pro' } }), env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe('https://checkout.stripe.com/pay/cs_1');
    const [, init] = stripeSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('client_reference_id')).toBe('hosted_usr_1');
    expect(sentBody.get('line_items[0][price]')).toBe('price_pro');
    expect(sentBody.get('metadata[tier]')).toBe('pro');
  });
});

describe('POST /billing/webhook', () => {
  function checkoutCompletedEvent(userId: string, tier: string, subId: string, email: string) {
    return {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: userId,
          subscription: subId,
          customer: 'cus_1',
          customer_details: { email },
          payment_status: 'paid',
          metadata: { userId, tier },
        },
      },
    };
  }

  it('rejects a request with no Stripe-Signature header', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(
      new Request('https://hosted.test/billing/webhook', { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an invalid signature', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(
      new Request('https://hosted.test/billing/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('grants the entitlement on a valid checkout.session.completed event', async () => {
    const { env, billingKv } = await makeEnv('x');
    const payload = JSON.stringify(checkoutCompletedEvent('hosted_usr_2', 'solo', 'sub_1', 'user@example.com'));
    const sig = await signStripePayloadForTest(payload, STRIPE_WEBHOOK_SECRET);

    const res = await worker.fetch(
      new Request('https://hosted.test/billing/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const stored = JSON.parse(billingKv.store.get('sub:hosted_usr_2') as string);
    expect(stored.tier).toBe('solo');
    expect(stored.status).toBe('active');
    expect(stored.email).toBe('user@example.com');
    expect(billingKv.store.get('stripe-sub:sub_1')).toBe('hosted_usr_2');
  });

  it('is idempotent: replaying the same event id does not re-derive state twice', async () => {
    const { env, billingKv } = await makeEnv('x');
    const payload = JSON.stringify(checkoutCompletedEvent('hosted_usr_3', 'pro', 'sub_2', 'dup@example.com'));
    const sig = await signStripePayloadForTest(payload, STRIPE_WEBHOOK_SECRET);
    const send = () =>
      worker.fetch(
        new Request('https://hosted.test/billing/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': sig },
          body: payload,
        }),
        env,
      );

    await send();
    const second = await send();
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    expect(billingKv.store.get('sub:hosted_usr_3')).toBeDefined();
  });

  it('cancels the tier on customer.subscription.deleted', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_4', {
      tier: 'pro',
      status: 'active',
      subscriptionId: 'sub_3',
      updatedAt: 0,
    });
    const payload = JSON.stringify({
      id: 'evt_cancel',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_3', status: 'canceled', metadata: { userId: 'hosted_usr_4', tier: 'pro' } } },
    });
    const sig = await signStripePayloadForTest(payload, STRIPE_WEBHOOK_SECRET);

    const res = await worker.fetch(
      new Request('https://hosted.test/billing/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const stored = JSON.parse(billingKv.store.get('sub:hosted_usr_4') as string);
    expect(stored.status).toBe('canceled');
  });
});

describe('GET /billing/entitlement', () => {
  it('requires a session', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(new Request('https://hosted.test/billing/entitlement'), env);
    expect(res.status).toBe(401);
  });

  it('returns tier "none" for a user with no subscription', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey);
    const token = await issueSessionToken(signingKey, 'hosted_usr_5');
    const res = await worker.fetch(req('/billing/entitlement', 'GET', { token }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: 'none', status: 'none' });
  });

  it('returns the stored tier for an active subscriber', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env, billingKv } = await makeEnv(signingKey);
    await putSubscriptionRecord(billingKv, 'hosted_usr_6', { tier: 'pro', status: 'active', updatedAt: 0 });
    const token = await issueSessionToken(signingKey, 'hosted_usr_6');
    const res = await worker.fetch(req('/billing/entitlement', 'GET', { token }), env);
    expect(await res.json()).toEqual({ tier: 'pro', status: 'active' });
  });
});

describe('service-authenticated admin routes', () => {
  it('GET /admin/subscribers requires the service secret, not a session token', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey);
    const token = await issueSessionToken(signingKey, 'hosted_usr_7');
    const res = await worker.fetch(req('/admin/subscribers', 'GET', { token }), env);
    expect(res.status).toBe(401);
  });

  it('GET /admin/subscribers returns ids and tiers only, never emails', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_8', {
      tier: 'solo',
      status: 'active',
      email: 'should-not-appear@example.com',
      updatedAt: 0,
    });
    const res = await worker.fetch(req('/admin/subscribers', 'GET', { serviceSecret: SERVICE_SECRET }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscribers: Array<{ userId: string; tier: string }> };
    expect(body.subscribers).toEqual([{ userId: 'hosted_usr_8', tier: 'solo' }]);
    expect(JSON.stringify(body)).not.toContain('should-not-appear@example.com');
  });

  it('rejects an invalid service secret', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(req('/admin/subscribers', 'GET', { serviceSecret: 'wrong' }), env);
    expect(res.status).toBe(401);
  });

  it('POST /admin/session mints a token valid for the named userId only', async () => {
    const signingKey = await generatePrivateKeyB64();
    const { env } = await makeEnv(signingKey);
    const res = await worker.fetch(
      req('/admin/session', 'POST', { serviceSecret: SERVICE_SECRET, body: { userId: 'hosted_usr_9' } }),
      env,
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string; exp: number };

    const verifyRes = await worker.fetch(
      new Request('https://hosted.test/auth/session/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toMatchObject({ userId: 'hosted_usr_9' });
  });

  it('POST /admin/entitlement grants a tier with no Stripe subscription behind it', async () => {
    const { env, billingKv } = await makeEnv('x');
    const res = await worker.fetch(
      req('/admin/entitlement', 'POST', { serviceSecret: SERVICE_SECRET, body: { userId: 'hosted_usr_10', tier: 'pro' } }),
      env,
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse(billingKv.store.get('sub:hosted_usr_10') as string);
    expect(stored.tier).toBe('pro');
    expect(stored.status).toBe('active');
  });
});

describe('POST /digest/send', () => {
  it('requires the service secret', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(
      req('/digest/send', 'POST', { body: { userId: 'hosted_usr_11', digestType: 'earnings', subject: 's', body: 'b' } }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('denies an unpaid-commissions digest for a solo subscriber', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_12', {
      tier: 'solo',
      status: 'active',
      email: 'solo@example.com',
      updatedAt: 0,
    });
    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_12', digestType: 'unpaid-commissions', subject: 's', body: 'b' },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('denies any digest for a user with no active subscription', async () => {
    const { env } = await makeEnv('x');
    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_never', digestType: 'earnings', subject: 's', body: 'b' },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('sends an earnings digest for a solo subscriber and never exposes the email in the response', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_13', {
      tier: 'solo',
      status: 'active',
      email: 'solo13@example.com',
      updatedAt: 0,
    });
    const resendSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));

    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_13', digestType: 'earnings', subject: 'Your weekly earnings', body: 'plain text digest content' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const responseText = JSON.stringify(await res.clone().json());
    expect(responseText).not.toContain('solo13@example.com');
    expect(responseText).not.toContain('plain text digest content');

    const [, init] = resendSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { to: string; text: string };
    expect(sentBody.to).toBe('solo13@example.com');
    expect(sentBody.text).toBe('plain text digest content');
  });

  it('sends an unpaid-commissions digest for a pro subscriber', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_14', { tier: 'pro', status: 'active', email: 'pro14@example.com', updatedAt: 0 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'em_2' }), { status: 200 }));

    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_14', digestType: 'unpaid-commissions', subject: 'subj', body: 'body' },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('returns 422 when the subscriber has no billing email on file (e.g. manually granted)', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_15', { tier: 'solo', status: 'active', updatedAt: 0 });
    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_15', digestType: 'earnings', subject: 's', body: 'b' },
      }),
      env,
    );
    expect(res.status).toBe(422);
  });

  it('surfaces a Resend failure as a 502 without ever logging the address (checked structurally: response omits it)', async () => {
    const { env, billingKv } = await makeEnv('x');
    await putSubscriptionRecord(billingKv, 'hosted_usr_16', { tier: 'solo', status: 'active', email: 'fail16@example.com', updatedAt: 0 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }));

    const res = await worker.fetch(
      req('/digest/send', 'POST', {
        serviceSecret: SERVICE_SECRET,
        body: { userId: 'hosted_usr_16', digestType: 'earnings', subject: 's', body: 'b' },
      }),
      env,
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.clone().json())).not.toContain('fail16@example.com');
  });
});
