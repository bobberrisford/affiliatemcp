/**
 * Route tests for the billing/account page (Stripe-wiring follow-up to H6:
 * `src/routes/billing-page.ts`), exercised through the same `worker.fetch`
 * entry point as `test/connect-routes.test.ts`. Since OAuth slice 3 the browser
 * authenticates via the HttpOnly `hosted_session` cookie, so these drive auth
 * via a `Cookie` header, and the two state-changing POSTs (checkout, portal)
 * carry the same-origin CSRF check. Covers: session gating (sign-in prompt when
 * signed out), the tier-none subscribe buttons, the Solo upgrade-and-manage
 * buttons, the Pro manage-only button, the checkout/portal hand-off calling the
 * existing `/billing/checkout` and `/billing/portal` routes in-process with the
 * right tier (Stripe mocked via a spy on `fetch`), the cross-site CSRF
 * rejection, that no URL or page body ever carries the session token or the
 * cookie value, and the Stripe-return landing hit (no session presented)
 * showing the sign-in prompt with an honest status line, never a fabricated
 * result. KV is an in-memory fake; no live network calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, generateUserId, signSession } from '../src/token.js';
import { putSubscriptionRecord } from '../src/billing.js';

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
  billingKv: KVNamespace & { store: Map<string, string> };
  signingKey: string;
}

async function makeTestEnv(): Promise<TestEnv> {
  const billingKv = fakeKV();
  const signingKey = await generatePrivateKeyB64();
  const env: Env = {
    HOSTED_USERS: fakeKV(),
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: billingKv,
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: await randomMasterKeyB64(),
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_ID_SOLO: 'price_solo',
    STRIPE_PRICE_ID_PRO: 'price_pro',
    BILLING_SUCCESS_URL: 'https://hosted.test/connect/billing?checkout=success',
    BILLING_CANCEL_URL: 'https://hosted.test/connect/billing?checkout=cancelled',
    BILLING_PORTAL_RETURN_URL: 'https://hosted.test/connect/billing',
  };
  return { env, billingKv, signingKey };
}

// The Worker's own origin — a same-origin POST for the CSRF check.
const SAME_ORIGIN = 'https://hosted.test';

async function issueSessionToken(signingKey: string, userId: string): Promise<string> {
  const iss = Math.floor(Date.now() / 1000);
  const exp = iss + 60 * 60 * 24 * 30;
  return signSession(buildSessionPayload({ sub: userId, iss, exp }), signingKey);
}

/** An unauthenticated GET (no cookie). */
function get(path: string): Request {
  return new Request(`https://hosted.test${path}`);
}

/** An unauthenticated POST form (no cookie). */
function postForm(path: string, fields: Record<string, string>): Request {
  return new Request(`https://hosted.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A GET carrying the browser session cookie. */
function authedGet(path: string, token: string): Request {
  return new Request(`https://hosted.test${path}`, { headers: { cookie: `hosted_session=${token}` } });
}

/** A POST form carrying the browser session cookie; `origin` drives the CSRF
 * same-origin check on the state-changing billing POSTs. */
function authedPost(path: string, fields: Record<string, string>, token: string, origin?: string): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `hosted_session=${token}`,
  };
  if (origin !== undefined) headers.origin = origin;
  return new Request(`https://hosted.test${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

/** Since slice 3 the session token lives in an HttpOnly cookie and is never
 * rendered: it must not appear in any URL, any `token=` query string, anywhere
 * in the page body, and the cookie name must not leak into the HTML. */
function expectNoTokenLeak(body: string, token: string): void {
  expect(body).not.toMatch(/href="[^"]*amcps_[^"]*"/);
  expect(body).not.toMatch(/action="[^"]*amcps_[^"]*"/);
  expect(body).not.toContain('?token=');
  expect(body).not.toContain(token);
  expect(body).not.toContain('hosted_session');
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Session gating ──────────────────────────────────────────────────────────
describe('GET|POST /connect/billing: session gating', () => {
  it('GET /connect/billing without a session shows the sign-in prompt, not a JSON 401', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/billing'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('sign in required');
  });

  it('is matched before the generic /connect/:network pattern: never "network not found"', async () => {
    const { env } = await makeTestEnv();
    const body = await (await worker.fetch(get('/connect/billing'), env)).text();
    expect(body).not.toContain('network not found');
  });

  it('a valid token via the cookie is accepted and renders the billing page', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authedGet('/connect/billing', token), env);
    const body = await res.text();
    expect(body).toContain('<h1>billing</h1>');
    expectNoTokenLeak(body, token);
  });

  it('a valid token via the Authorization header is accepted on the GET variant', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      new Request('https://hosted.test/connect/billing', { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(await res.text()).toContain('<h1>billing</h1>');
  });

  it('carries cache-control: no-store and referrer-policy: same-origin', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authedGet('/connect/billing', token), env);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // same-origin (not no-referrer): this page's own subscribe/upgrade POSTs are
    // same-origin and must keep their Origin header for the CSRF gate. The
    // Stripe checkout redirect below is the one response that stays no-referrer.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });
});

// ── Tier-dependent action buttons ───────────────────────────────────────────
describe('billing page: tier-dependent actions', () => {
  it('an unsubscribed (free-tier) user sees both Subscribe buttons, no manage button, and a Free current-plan label', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(authedGet('/connect/billing', token), env);
    const body = await res.text();
    expect(body).toContain('Subscribe Solo');
    expect(body).toContain('Subscribe Pro');
    expect(body).not.toContain('Manage subscription');
    // Unsubscribed users now resolve to the metered free tier (decision 2026-07-18),
    // so the current-plan label reads "Free", not "none".
    expect(body).toContain('Current plan: <strong>Free</strong>');
    expectNoTokenLeak(body, token);
  });

  it('tier solo renders an Upgrade to Pro button and a Manage subscription button, no Subscribe buttons', async () => {
    const { env, billingKv, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    await putSubscriptionRecord(billingKv, userId, {
      tier: 'solo',
      status: 'active',
      customerId: 'cus_1',
      updatedAt: 0,
    });
    const token = await issueSessionToken(signingKey, userId);
    const res = await worker.fetch(authedGet('/connect/billing', token), env);
    const body = await res.text();
    expect(body).toContain('Upgrade to Pro');
    expect(body).toContain('Manage subscription');
    expect(body).not.toContain('Subscribe Solo');
    expect(body).not.toContain('Subscribe Pro');
    expect(body).toContain('Current plan: <strong>Solo</strong>');
    expectNoTokenLeak(body, token);
  });

  it('tier pro renders only a Manage subscription button', async () => {
    const { env, billingKv, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    await putSubscriptionRecord(billingKv, userId, {
      tier: 'pro',
      status: 'active',
      customerId: 'cus_1',
      updatedAt: 0,
    });
    const token = await issueSessionToken(signingKey, userId);
    const res = await worker.fetch(authedGet('/connect/billing', token), env);
    const body = await res.text();
    expect(body).toContain('Manage subscription');
    expect(body).not.toContain('Subscribe Solo');
    expect(body).not.toContain('Subscribe Pro');
    expect(body).not.toContain('Upgrade to Pro');
    expect(body).toContain('Current plan: <strong>Pro</strong>');
    expectNoTokenLeak(body, token);
  });
});

// ── POST /connect/billing/checkout ──────────────────────────────────────────
describe('POST /connect/billing/checkout', () => {
  it('without a session shows the sign-in prompt and calls Stripe nothing', async () => {
    const { env } = await makeTestEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(postForm('/connect/billing/checkout', { tier: 'solo' }), env);
    expect(await res.text()).toContain('sign in required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cross-site Origin with a 403, calling Stripe nothing', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      authedPost('/connect/billing/checkout', { tier: 'pro' }, token, 'https://evil.example'),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('could not be verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the existing /billing/checkout logic with the submitted tier and redirects to the Stripe url', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const stripeSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }), { status: 200 }),
    );

    const res = await worker.fetch(
      authedPost('/connect/billing/checkout', { tier: 'pro' }, token, SAME_ORIGIN),
      env,
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://checkout.stripe.com/pay/cs_1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const [, init] = stripeSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('line_items[0][price]')).toBe('price_pro');
    expect(sentBody.get('metadata[tier]')).toBe('pro');
  });

  it('re-renders the billing page with a note instead of a 500 when Stripe is not configured', async () => {
    const { env, signingKey } = await makeTestEnv();
    const badEnv: Env = { ...env, STRIPE_SECRET_KEY: undefined };
    const token = await issueSessionToken(signingKey, generateUserId());

    const res = await worker.fetch(
      authedPost('/connect/billing/checkout', { tier: 'solo' }, token, SAME_ORIGIN),
      badEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Could not start checkout with Stripe');
    expectNoTokenLeak(body, token);
  });

  it('rejects a missing/invalid tier without contacting Stripe', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await worker.fetch(
      authedPost('/connect/billing/checkout', { tier: 'ultra' }, token, SAME_ORIGIN),
      env,
    );
    expect(await res.text()).toContain('Choose Solo or Pro');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── POST /connect/billing/portal ────────────────────────────────────────────
describe('POST /connect/billing/portal', () => {
  it('without a session shows the sign-in prompt and calls Stripe nothing', async () => {
    const { env } = await makeTestEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(postForm('/connect/billing/portal', {}), env);
    expect(await res.text()).toContain('sign in required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cross-site Origin with a 403, calling Stripe nothing', async () => {
    const { env, billingKv, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    await putSubscriptionRecord(billingKv, userId, {
      tier: 'solo',
      status: 'active',
      customerId: 'cus_mine',
      updatedAt: 0,
    });
    const token = await issueSessionToken(signingKey, userId);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      authedPost('/connect/billing/portal', {}, token, 'https://evil.example'),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('could not be verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the existing /billing/portal logic and redirects to the returned Stripe portal url', async () => {
    const { env, billingKv, signingKey } = await makeTestEnv();
    const userId = generateUserId();
    await putSubscriptionRecord(billingKv, userId, {
      tier: 'solo',
      status: 'active',
      customerId: 'cus_mine',
      updatedAt: 0,
    });
    const token = await issueSessionToken(signingKey, userId);
    const stripeSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.com/session/bps_1' }), {
          status: 200,
        }),
      );

    const res = await worker.fetch(authedPost('/connect/billing/portal', {}, token, SAME_ORIGIN), env);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://billing.stripe.com/session/bps_1');
    const [, init] = stripeSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('customer')).toBe('cus_mine');
  });

  it('re-renders the billing page with a note when there is no Stripe customer id yet (never subscribed)', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());

    const res = await worker.fetch(authedPost('/connect/billing/portal', {}, token, SAME_ORIGIN), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Could not open the Stripe billing portal');
    expectNoTokenLeak(body, token);
  });
});

// ── Stripe-return landing: honest, never fabricated ─────────────────────────
describe('Stripe-return landing on GET /connect/billing (no session presented)', () => {
  it('?checkout=success with no session shows the sign-in prompt with an honest status line, never a fabricated "subscribed" result', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/billing?checkout=success'), env);
    const body = await res.text();
    expect(body).toContain('sign in required');
    expect(body).toContain('Stripe reports checkout is complete');
    expect(body).not.toContain('<h1>billing</h1>');
  });

  it('?checkout=cancelled with no session states plainly that nothing was charged', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/billing?checkout=cancelled'), env);
    const body = await res.text();
    expect(body).toContain('sign in required');
    expect(body).toContain('Checkout was cancelled. Nothing was charged.');
  });

  it('no checkout flag and no session is the ordinary sign-in prompt with no extra note', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/billing'), env);
    const body = await res.text();
    expect(body).toContain('sign in required');
    expect(body).not.toContain('Stripe reports checkout is complete');
    expect(body).not.toContain('Checkout was cancelled');
  });
});
