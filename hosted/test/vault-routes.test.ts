/**
 * Route-level tests for the H3 vault and account endpoints, exercised
 * through the same `worker.fetch` entry point as `test/worker.test.ts`.
 * Covers session auth (401 without a valid token), list-never-returns-values,
 * store/list/delete-one-network, and complete account deletion including the
 * H2 identity-KV entries it must also remove.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, generateUserId, signSession } from '../src/token.js';

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

interface TestEnv {
  env: Env;
  usersKv: KVNamespace & { store: Map<string, string> };
  vaultKv: KVNamespace & { store: Map<string, string> };
  signingKey: string;
}

async function makeTestEnv(): Promise<TestEnv> {
  const usersKv = fakeKV();
  const vaultKv = fakeKV();
  const signingKey = await generatePrivateKeyB64();
  const env: Env = {
    HOSTED_USERS: usersKv,
    HOSTED_VAULT: vaultKv,
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: await randomMasterKeyB64(),
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
  };
  return { env, usersKv, vaultKv, signingKey };
}

async function issueSessionToken(signingKey: string, userId: string): Promise<string> {
  const iss = Math.floor(Date.now() / 1000);
  const exp = iss + 60 * 60 * 24 * 30;
  return signSession(buildSessionPayload({ sub: userId, iss, exp }), signingKey);
}

function authed(path: string, method: string, token: string, body?: unknown): Request {
  return new Request(`https://hosted.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vault route auth', () => {
  it('POST /vault/credentials without a session token is a 401', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(
      new Request('https://hosted.test/vault/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: 'awin', credentials: { apiKey: 'x' } }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('GET /vault/credentials with a malformed bearer token is a 401', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(
      new Request('https://hosted.test/vault/credentials', {
        headers: { authorization: 'Bearer not-a-real-token' },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('DELETE /vault/credentials/:network with an expired token is a 401', async () => {
    const { env, signingKey } = await makeTestEnv();
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = await signSession(
      buildSessionPayload({ sub: generateUserId(), iss: past - 100, exp: past }),
      signingKey,
    );
    const res = await worker.fetch(authed('/vault/credentials/awin', 'DELETE', expired), env);
    expect(res.status).toBe(401);
  });

  it('DELETE /account without a session token is a 401', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(new Request('https://hosted.test/account', { method: 'DELETE' }), env);
    expect(res.status).toBe(401);
  });
});

describe('POST /vault/credentials', () => {
  it('stores a credential for the authenticated user and returns no credential values', async () => {
    const { env, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    const token = await issueSessionToken(signingKey, userId);

    const res = await worker.fetch(
      authed('/vault/credentials', 'POST', token, {
        network: 'awin',
        credentials: { apiKey: 'super-secret-marker' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('super-secret-marker');
    expect(JSON.parse(body)).toEqual({ ok: true, network: 'awin' });
  });

  it('rejects an invalid network slug with a 400', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      authed('/vault/credentials', 'POST', token, { network: 'Not Valid', credentials: { apiKey: 'x' } }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-flat credentials shape with a 400', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      authed('/vault/credentials', 'POST', token, { network: 'awin', credentials: { nested: { a: 1 } } }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with a 400', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      new Request('https://hosted.test/vault/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{not json',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /vault/credentials — list-never-returns-values', () => {
  it('returns only network slugs, never credential values, even under other response fields', async () => {
    const { env, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    const token = await issueSessionToken(signingKey, userId);

    await worker.fetch(
      authed('/vault/credentials', 'POST', token, { network: 'awin', credentials: { apiKey: 'never-leak-me' } }),
      env,
    );
    await worker.fetch(
      authed('/vault/credentials', 'POST', token, { network: 'cj', credentials: { apiKey: 'also-never-leak' } }),
      env,
    );

    const res = await worker.fetch(authed('/vault/credentials', 'GET', token), env);
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { networks: string[] };
    expect(body.networks.sort()).toEqual(['awin', 'cj']);
    expect(Object.keys(body)).toEqual(['networks']);
    expect(bodyText).not.toContain('never-leak-me');
    expect(bodyText).not.toContain('also-never-leak');
    expect(bodyText).not.toContain('apiKey');
  });

  it("never lists another user's networks", async () => {
    const { env, signingKey } = await makeTestEnv();
    const tokenA = await issueSessionToken(signingKey, generateUserId());
    const tokenB = await issueSessionToken(signingKey, generateUserId());

    await worker.fetch(authed('/vault/credentials', 'POST', tokenA, { network: 'awin', credentials: { apiKey: 'a' } }), env);
    await worker.fetch(authed('/vault/credentials', 'POST', tokenB, { network: 'impact', credentials: { apiKey: 'b' } }), env);

    const resA = await worker.fetch(authed('/vault/credentials', 'GET', tokenA), env);
    expect((await resA.json()) as { networks: string[] }).toEqual({ networks: ['awin'] });
  });
});

describe('DELETE /vault/credentials/:network', () => {
  it('removes one network and leaves the others', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());

    await worker.fetch(authed('/vault/credentials', 'POST', token, { network: 'awin', credentials: { apiKey: 'a' } }), env);
    await worker.fetch(authed('/vault/credentials', 'POST', token, { network: 'cj', credentials: { apiKey: 'b' } }), env);

    const del = await worker.fetch(authed('/vault/credentials/awin', 'DELETE', token), env);
    expect(del.status).toBe(200);

    const list = await worker.fetch(authed('/vault/credentials', 'GET', token), env);
    expect((await list.json()) as { networks: string[] }).toEqual({ networks: ['cj'] });
  });

  it('is idempotent: deleting a network never connected still returns 200', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authed('/vault/credentials/never-connected', 'DELETE', token), env);
    expect(res.status).toBe(200);
  });
});

describe('GET /vault/credentials/:network/reveal — H4 decrypt-and-serve', () => {
  it('returns the decrypted credential for the authenticated owner', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());

    await worker.fetch(
      authed('/vault/credentials', 'POST', token, {
        network: 'cj',
        credentials: { CJ_API_TOKEN: 'reveal-me-token', CJ_COMPANY_ID: '1234567' },
      }),
      env,
    );

    const res = await worker.fetch(authed('/vault/credentials/cj/reveal', 'GET', token), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      network: 'cj',
      credentials: { CJ_API_TOKEN: 'reveal-me-token', CJ_COMPANY_ID: '1234567' },
    });
  });

  it('returns 404, never a fabricated value, when the network was never connected', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authed('/vault/credentials/never-connected/reveal', 'GET', token), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('is a 401 without a valid session', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(
      new Request('https://hosted.test/vault/credentials/cj/reveal', {
        headers: { authorization: 'Bearer amcps_forged.forged' },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("never reveals another user's credential, even for the same network slug", async () => {
    const { env, signingKey } = await makeTestEnv();
    const tokenA = await issueSessionToken(signingKey, generateUserId());
    const tokenB = await issueSessionToken(signingKey, generateUserId());

    await worker.fetch(
      authed('/vault/credentials', 'POST', tokenA, { network: 'cj', credentials: { CJ_API_TOKEN: 'user-a-token' } }),
      env,
    );

    const res = await worker.fetch(authed('/vault/credentials/cj/reveal', 'GET', tokenB), env);
    expect(res.status).toBe(404);
  });

  it('rejects an invalid network slug with a 400', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authed('/vault/credentials/UPPER_CASE/reveal', 'GET', token), env);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /account — complete deletion', () => {
  it('removes the vault, the user record, and the email-hash lookup, covering both KV namespaces', async () => {
    const { env, usersKv, vaultKv } = await makeTestEnv();

    // Sign in for real via the H2 auth flow so a user record + email-hash
    // entry exist in HOSTED_USERS, matching what a real account looks like.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await worker.fetch(
      new Request('https://hosted.test/auth/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'delete-me@example.com' }),
      }),
      env,
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const emailBody = JSON.parse(init.body as string) as { text: string };
    const rawToken = (emailBody.text.match(/token=([^\s]+)/) as RegExpMatchArray)[1] as string;
    const callbackRes = await worker.fetch(new Request(`https://hosted.test/auth/callback?token=${rawToken}`), env);
    const sessionToken = ((await callbackRes.text()).match(/>(amcps_[^<]+)</) as RegExpMatchArray)[1] as string;
    const verifyRes = await worker.fetch(
      new Request('https://hosted.test/auth/session/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: sessionToken }),
      }),
      env,
    );
    const { userId } = (await verifyRes.json()) as { userId: string };

    // Connect a network, then delete the account.
    await worker.fetch(
      authed('/vault/credentials', 'POST', sessionToken, { network: 'awin', credentials: { apiKey: 'x' } }),
      env,
    );
    expect(Array.from(usersKv.store.keys()).some((k) => k.startsWith('user:'))).toBe(true);
    expect(Array.from(usersKv.store.keys()).some((k) => k.startsWith('email-hash:'))).toBe(true);
    expect(vaultKv.store.size).toBeGreaterThan(0);

    const deleteRes = await worker.fetch(authed('/account', 'DELETE', sessionToken), env);
    expect(deleteRes.status).toBe(200);

    expect(Array.from(usersKv.store.keys()).some((k) => k === `user:${userId}`)).toBe(false);
    expect(Array.from(usersKv.store.keys()).some((k) => k.startsWith('email-hash:'))).toBe(false);
    expect(vaultKv.store.size).toBe(0);

    const listAfter = await worker.fetch(authed('/vault/credentials', 'GET', sessionToken), env);
    expect((await listAfter.json()) as { networks: string[] }).toEqual({ networks: [] });
  });

  it('is a 401 without a valid session, so an attacker cannot delete an arbitrary account', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(
      new Request('https://hosted.test/account', {
        method: 'DELETE',
        headers: { authorization: 'Bearer amcps_forged.forged' },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
