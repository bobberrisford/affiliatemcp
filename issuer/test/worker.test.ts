/**
 * Worker route tests for the entitlement path — the security-critical bit —
 * with an in-memory KV and a real signing key. Stripe-backed routes (checkout,
 * webhook, portal) are thin API wrappers verified live, not mocked here.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { verifyEntitlement } from '../src/token.js';

function fakeKV(seed: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

async function keypair(): Promise<{ priv: string; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { priv: btoa(String.fromCharCode(...pkcs8)), pub: btoa(String.fromCharCode(...spki)) };
}

function makeEnv(kv: KVNamespace, signingKey: string): Env {
  return {
    ENTITLEMENTS: kv,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    LICENCE_SIGNING_KEY: signingKey,
    STRIPE_PRICE_ID: 'price_x',
    SUCCESS_URL: 'https://example.test/success',
    CANCEL_URL: 'https://example.test/cancel',
  };
}

const post = (path: string, body?: unknown) =>
  new Request(`https://issuer.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('entitlement route', () => {
  it('health check responds', async () => {
    const env = makeEnv(fakeKV(), 'x');
    const res = await worker.fetch(new Request('https://issuer.test/health'), env);
    expect(res.status).toBe(200);
  });

  it('missing account key is a 400', async () => {
    const env = makeEnv(fakeKV(), 'x');
    const res = await worker.fetch(post('/entitlement', {}), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { active: boolean }).active).toBe(false);
  });

  it('unknown account key is inactive, not an error', async () => {
    const env = makeEnv(fakeKV(), 'x');
    const res = await worker.fetch(post('/entitlement', { accountKey: 'amcp_acc_nope' }), env);
    const body = (await res.json()) as { active: boolean; status: string };
    expect(res.status).toBe(200);
    expect(body.active).toBe(false);
    expect(body.status).toBe('unknown');
  });

  it('a cancelled subscription does not get a token', async () => {
    const { priv } = await keypair();
    const kv = fakeKV({ 'acc:amcp_acc_x': JSON.stringify({ status: 'canceled' }) });
    const res = await worker.fetch(post('/entitlement', { accountKey: 'amcp_acc_x' }), makeEnv(kv, priv));
    expect(((await res.json()) as { active: boolean }).active).toBe(false);
  });

  it('an active subscription gets a token that verifies', async () => {
    const { priv, pub } = await keypair();
    const kv = fakeKV({
      'acc:amcp_acc_live': JSON.stringify({ status: 'active', customerId: 'cus_1', subscriptionId: 'sub_1' }),
    });
    const res = await worker.fetch(post('/entitlement', { accountKey: 'amcp_acc_live' }), makeEnv(kv, priv));
    const body = (await res.json()) as { active: boolean; token: string; exp: number };
    expect(body.active).toBe(true);
    expect(typeof body.token).toBe('string');

    const payload = await verifyEntitlement(body.token, pub);
    expect(payload).not.toBeNull();
    expect(payload!.akey).toBe('amcp_acc_live');
    expect(payload!.exp).toBe(body.exp);
  });
});
