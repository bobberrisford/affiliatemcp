/**
 * Token-scope enforcement tests (H6, redesigned per Rob's 2026-07-14
 * decision). A digest-scoped token must be accepted by EXACTLY the two
 * vault read routes the scheduled digest's compose service needs — list and
 * reveal, both still serving only the token's own userId — and rejected by
 * every other session-gated surface: vault store, vault delete, account
 * deletion, billing checkout, billing entitlement, and every connect page.
 * `POST /auth/session/verify` reports the scope so the hosted MCP transport
 * (root workspace) can refuse digest tokens too; that refusal is tested in
 * `tests/hosted-transport/http-server.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, sessionScope, signSession, verifySession } from '../src/token.js';
import { putCredentials } from '../src/vault.js';
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
  signingKey: string;
  userId: string;
  iss: number;
  digestToken: string;
  fullToken: string;
}

async function makeContext(): Promise<TestContext> {
  const signingKey = await generatePrivateKeyB64();
  const env: Env = {
    HOSTED_USERS: fakeKV(),
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: fakeKV(),
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: await randomMasterKeyB64(),
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_ID_SOLO: 'price_solo',
    STRIPE_PRICE_ID_PRO: 'price_pro',
    BILLING_SUCCESS_URL: 'https://hosted.test/success',
    BILLING_CANCEL_URL: 'https://hosted.test/cancel',
    BILLING_PORTAL_RETURN_URL: 'https://hosted.test/connect/billing',
  };
  const userId = 'hosted_usr_scope_test';
  const iss = Math.floor(Date.now() / 1000);
  const digestToken = await signSession(
    buildSessionPayload({ sub: userId, iss, exp: iss + 900, scope: 'digest' }),
    signingKey,
  );
  const fullToken = await signSession(buildSessionPayload({ sub: userId, iss, exp: iss + 3600 }), signingKey);
  return { env, signingKey, userId, iss, digestToken, fullToken };
}

function authed(path: string, method: string, token: string, body?: unknown): Request {
  return new Request(`https://hosted.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('token scope claim', () => {
  it('roundtrips a digest-scoped token and reports its scope', async () => {
    const { digestToken, signingKey } = await makeContext();
    const payload = await verifySession(digestToken, signingKey);
    expect(payload).not.toBeNull();
    expect(payload?.scope).toBe('digest');
    expect(sessionScope(payload as NonNullable<typeof payload>)).toBe('digest');
  });

  it('treats an absent scope claim as a full session (pre-H6 tokens stay valid unchanged)', async () => {
    const { fullToken, signingKey } = await makeContext();
    const payload = await verifySession(fullToken, signingKey);
    expect(payload).not.toBeNull();
    expect(payload?.scope).toBeUndefined();
    expect(sessionScope(payload as NonNullable<typeof payload>)).toBe('full');
  });

  it('rejects a token carrying an unrecognised scope value', async () => {
    const { signingKey, userId } = await makeContext();
    const iss = Math.floor(Date.now() / 1000);
    // Hand-build a payload with a scope outside the closed vocabulary.
    const rogue = {
      sub: userId,
      product: 'hosted-session',
      iss,
      exp: iss + 900,
      v: 1,
      scope: 'admin',
    };
    const token = await signSession(rogue as unknown as Parameters<typeof signSession>[0], signingKey);
    expect(await verifySession(token, signingKey)).toBeNull();
  });
});

describe('POST /auth/session/verify reports scope', () => {
  it('returns scope "digest" for a digest token and "full" for a sign-in session', async () => {
    const { env, iss, digestToken, fullToken } = await makeContext();
    const verify = (token: string) =>
      worker.fetch(
        new Request('https://hosted.test/auth/session/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
        env,
      );

    // The body also carries `iss` (and `exp`) so the transport can compute
    // token lifetime during the staged bearer migration.
    const digestRes = await verify(digestToken);
    expect(digestRes.status).toBe(200);
    expect(await digestRes.json()).toMatchObject({ scope: 'digest', iss, exp: iss + 900 });

    const fullRes = await verify(fullToken);
    expect(fullRes.status).toBe(200);
    expect(await fullRes.json()).toMatchObject({ scope: 'full', iss, exp: iss + 3600 });
  });
});

describe('digest-scoped token: the two permitted vault read routes', () => {
  it('GET /vault/credentials (list) accepts a digest token and serves only its own userId', async () => {
    const ctx = await makeContext();
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'cj', {
      CJ_API_TOKEN: 't',
    });
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), 'hosted_usr_other', 'awin', {
      AWIN_API_TOKEN: 't',
    });

    const res = await worker.fetch(authed('/vault/credentials', 'GET', ctx.digestToken), ctx.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ networks: ['cj'] });
  });

  it('GET /vault/credentials/:network/reveal accepts a digest token for its own userId', async () => {
    const ctx = await makeContext();
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'cj', {
      CJ_API_TOKEN: 'secret-value',
    });

    const res = await worker.fetch(authed('/vault/credentials/cj/reveal', 'GET', ctx.digestToken), ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, string> };
    expect(body.credentials['CJ_API_TOKEN']).toBe('secret-value');
  });
});

describe('digest-scoped token: every other session-gated surface refuses it', () => {
  it('POST /vault/credentials (store) returns 403 insufficient_scope', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(
      authed('/vault/credentials', 'POST', ctx.digestToken, { network: 'cj', credentials: { CJ_API_TOKEN: 'x' } }),
      ctx.env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('DELETE /vault/credentials/:network returns 403 insufficient_scope', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/vault/credentials/cj', 'DELETE', ctx.digestToken), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('DELETE /account returns 403 insufficient_scope and deletes nothing', async () => {
    const ctx = await makeContext();
    await putCredentials(ctx.env.HOSTED_VAULT, vaultMasterKeyProvider(ctx.env), ctx.userId, 'cj', {
      CJ_API_TOKEN: 't',
    });
    const before = (ctx.env.HOSTED_VAULT as unknown as { store: Map<string, string> }).store.size;

    const res = await worker.fetch(authed('/account', 'DELETE', ctx.digestToken), ctx.env);

    expect(res.status).toBe(403);
    expect((ctx.env.HOSTED_VAULT as unknown as { store: Map<string, string> }).store.size).toBe(before);
  });

  it('POST /billing/checkout returns 403 insufficient_scope', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/billing/checkout', 'POST', ctx.digestToken, { tier: 'solo' }), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('GET /billing/entitlement returns 403 insufficient_scope', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/billing/entitlement', 'GET', ctx.digestToken), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('POST /billing/portal returns 403 insufficient_scope', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/billing/portal', 'POST', ctx.digestToken, {}), ctx.env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('the connect list page treats a digest token as not signed in (header variant)', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/connect', 'GET', ctx.digestToken), ctx.env);
    const text = await res.text();
    expect(text).toContain('sign in required');
    expect(text).not.toContain('cj');
  });

  it('the connect form and submit routes treat a digest token as not signed in (POST body variant)', async () => {
    const ctx = await makeContext();
    const asForm = (path: string, extra: Record<string, string> = {}) => {
      const form = new URLSearchParams({ token: ctx.digestToken, ...extra });
      return new Request(`https://hosted.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    };

    const formRes = await worker.fetch(asForm('/connect/cj/form'), ctx.env);
    expect(await formRes.text()).toContain('sign in required');

    const submitRes = await worker.fetch(asForm('/connect/cj', { CJ_API_TOKEN: 'x' }), ctx.env);
    expect(await submitRes.text()).toContain('sign in required');
    // Nothing was stored by the refused submit.
    expect((ctx.env.HOSTED_VAULT as unknown as { store: Map<string, string> }).store.size).toBe(0);
  });

  it('the billing page treats a digest token as not signed in (POST body variant)', async () => {
    const ctx = await makeContext();
    const form = new URLSearchParams({ token: ctx.digestToken });
    const res = await worker.fetch(
      new Request('https://hosted.test/connect/billing', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
      ctx.env,
    );
    expect(await res.text()).toContain('sign in required');
  });

  it('a FULL session still passes the same full-scope routes (guard change is not over-broad)', async () => {
    const ctx = await makeContext();
    const res = await worker.fetch(authed('/billing/entitlement', 'GET', ctx.fullToken), ctx.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: 'free', status: 'none' });

    const put = await worker.fetch(
      authed('/vault/credentials', 'POST', ctx.fullToken, { network: 'cj', credentials: { CJ_API_TOKEN: 'x' } }),
      ctx.env,
    );
    expect(put.status).toBe(200);
  });
});
