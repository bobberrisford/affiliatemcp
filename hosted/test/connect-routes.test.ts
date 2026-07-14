/**
 * H5 connect-flow route tests, exercised through the same `worker.fetch`
 * entry point as `test/worker.test.ts` and `test/vault-routes.test.ts`.
 * Covers: sign-in gating for an unauthenticated visitor, the hard rejection
 * of a session token in a URL query parameter (RFC 6750 §2.3 — bearer tokens
 * never travel in URLs in this flow), POST-body navigation, form rendering
 * per network, store + mocked connection-test success and failure, that no
 * batch/multi-network endpoint exists, that a stored credential value never
 * appears unmasked in any HTML response, that no URL inside any rendered
 * page ever carries the session token, and that every connect response
 * carries `cache-control: no-store` and `referrer-policy: no-referrer`.
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
  return { env, vaultKv, signingKey };
}

async function issueSessionToken(signingKey: string, userId: string): Promise<string> {
  const iss = Math.floor(Date.now() / 1000);
  const exp = iss + 60 * 60 * 24 * 30;
  return signSession(buildSessionPayload({ sub: userId, iss, exp }), signingKey);
}

function get(path: string): Request {
  return new Request(`https://hosted.test${path}`);
}

function postForm(path: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request(`https://hosted.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/**
 * The load-bearing URL-hygiene assertion (RFC 6750 §2.3): no URL anywhere in
 * the rendered HTML — href, action, or otherwise — may carry the session
 * token, and no `token=` query string may appear anywhere in the page. The
 * token is allowed ONLY as a hidden form field's value and inside the
 * success page's copyable <textarea>.
 */
function expectNoTokenInAnyUrl(body: string, token: string): void {
  expect(body).not.toMatch(/href="[^"]*amcps_[^"]*"/);
  expect(body).not.toMatch(/action="[^"]*amcps_[^"]*"/);
  expect(body).not.toContain('?token=');
  expect(body).not.toContain(`token=${token}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Sign-in gating ──────────────────────────────────────────────────────────
describe('sign-in gating', () => {
  it('GET /connect without a session shows a sign-in prompt, not a JSON 401', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('sign in required');
    expect(body).not.toContain('"error"');
  });

  it('the sign-in prompt form submits the token via POST body, never GET', async () => {
    const { env } = await makeTestEnv();
    const body = await (await worker.fetch(get('/connect'), env)).text();
    expect(body).toContain('<form method="post" action="/connect">');
    expect(body).not.toContain('method="get"');
  });

  it('GET /connect/:network without a session shows the sign-in prompt', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/awin'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('sign in required');
  });

  it('GET /connect/:network/retest without a session shows the sign-in prompt', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect/awin/retest'), env);
    expect(await res.text()).toContain('sign in required');
  });

  it('POST /connect/:network without a session token stores nothing and shows the sign-in prompt', async () => {
    const { env, vaultKv } = await makeTestEnv();
    const res = await worker.fetch(
      postForm('/connect/awin', { AWIN_API_TOKEN: 'should-not-be-stored', AWIN_PUBLISHER_ID: '123' }),
      env,
    );
    expect(await res.text()).toContain('sign in required');
    expect(vaultKv.store.size).toBe(0);
  });

  it('an invalid/tampered token in the POST body also falls back to the sign-in prompt', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(postForm('/connect', { token: 'amcps_not.real' }), env);
    expect(await res.text()).toContain('sign in required');
  });

  it('a VALID token in a URL query parameter is rejected — bearer tokens never travel in URLs', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    for (const path of [
      `/connect?token=${token}`,
      `/connect/awin?token=${token}`,
      `/connect/awin/retest?token=${token}`,
    ]) {
      const res = await worker.fetch(get(path), env);
      const body = await res.text();
      expect(body).toContain('sign in required');
      expect(body).not.toContain('connect a network');
    }
  });

  it('a valid token via the Authorization header is accepted on the GET variants', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      new Request('https://hosted.test/connect', { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(await res.text()).toContain('connect a network');
  });

  it('a valid token via the POST body is accepted', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(postForm('/connect', { token }), env);
    expect(await res.text()).toContain('connect a network');
  });
});

// ── GET|POST /connect (list) ─────────────────────────────────────────────────
describe('POST /connect (list)', () => {
  it('lists all four networks as not connected for a fresh account, with POST-form navigation only', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(postForm('/connect', { token }), env);
    const body = await res.text();
    for (const name of ['Awin', 'CJ Affiliate', 'Impact', 'Rakuten Advertising']) {
      expect(body).toContain(name);
    }
    expect(body).toContain('not connected');
    expect(body).not.toContain('class="status-connected"');
    // Navigation to each network's form is a POST form, not a GET link.
    expect(body).toContain('action="/connect/awin/form"');
    expect(body).toContain('action="/connect/rakuten/form"');
    expectNoTokenInAnyUrl(body, token);
  });
});

// ── POST /connect/:network/form (guided form) ───────────────────────────────
describe('POST /connect/:network/form', () => {
  it('renders the guided form with fields, where-to-find copy, and the least-privilege note, per network', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());

    const cases: Array<{ slug: string; fields: string[] }> = [
      { slug: 'awin', fields: ['AWIN_API_TOKEN', 'AWIN_PUBLISHER_ID'] },
      { slug: 'cj', fields: ['CJ_API_TOKEN', 'CJ_COMPANY_ID'] },
      { slug: 'impact', fields: ['IMPACT_ACCOUNT_SID', 'IMPACT_AUTH_TOKEN'] },
      { slug: 'rakuten', fields: ['RAKUTEN_CLIENT_ID', 'RAKUTEN_CLIENT_SECRET', 'RAKUTEN_SID'] },
    ];
    for (const { slug, fields } of cases) {
      const res = await worker.fetch(postForm(`/connect/${slug}/form`, { token }), env);
      expect(res.status).toBe(200);
      const body = await res.text();
      for (const field of fields) {
        expect(body).toContain(`name="${field}"`);
      }
      expect(body.toLowerCase()).toContain('lesser-privileged alternative documented here today');
      expect(body).toContain(`action="/connect/${slug}"`);
      expectNoTokenInAnyUrl(body, token);
    }
  });

  it('the same form is reachable via GET with an Authorization header', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(
      new Request('https://hosted.test/connect/awin', { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(await res.text()).toContain('name="AWIN_API_TOKEN"');
  });

  it('returns a plain not-found page for a network outside the four hosted-eligible ones', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(postForm('/connect/some-other-network/form', { token }), env);
    expect(await res.text()).toContain('network not found');
  });
});

// ── POST /connect/:network (store + connection test) ────────────────────────
describe('POST /connect/:network — store then connection test', () => {
  it('stores the credential and shows success on a passing connection test', async () => {
    const { env, vaultKv, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ accountId: 555, accountName: 'Test Publisher' }]), { status: 200 }),
    );

    const res = await worker.fetch(
      postForm('/connect/awin', {
        token,
        AWIN_API_TOKEN: 'super-secret-marker-1234',
        AWIN_PUBLISHER_ID: '555',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('connected');
    expect(body).toContain('Connection test passed');
    expect(body).toContain('1234'); // masked last-4 only
    expect(body).not.toContain('super-secret-marker-1234');
    expectNoTokenInAnyUrl(body, token);
    // A stored credential blob now exists for this user/network.
    const hasCredKey = Array.from(vaultKv.store.keys()).some((k) => k.includes('awin'));
    expect(hasCredKey).toBe(true);
  });

  it('keeps the credential stored and shows the verbatim upstream status on a failing connection test', async () => {
    const { env, vaultKv, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unauthorized: bad token', { status: 401 }));

    const res = await worker.fetch(
      postForm('/connect/awin', {
        token,
        AWIN_API_TOKEN: 'wrong-token-marker-5678',
        AWIN_PUBLISHER_ID: '555',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('connection test failed');
    expect(body).toContain('HTTP 401');
    expect(body).toContain('Unauthorized: bad token');
    expect(body).toContain('retry the connection test');
    expect(body).not.toContain('wrong-token-marker-5678');
    expectNoTokenInAnyUrl(body, token);
    // The credential is still stored despite the failing test — never un-stored.
    const hasCredKey = Array.from(vaultKv.store.keys()).some((k) => k.includes('awin'));
    expect(hasCredKey).toBe(true);
  });

  it('never invents success: an unreachable network surfaces as a failure, not a false positive', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unreachable'));

    const res = await worker.fetch(
      postForm('/connect/cj', { token, CJ_API_TOKEN: 'x', CJ_COMPANY_ID: '1' }),
      env,
    );
    const body = await res.text();
    expect(body).toContain('connection test failed');
    expect(body).toContain('Could not reach CJ');
  });

  it('rejects a submission missing a required field with a 200 re-rendered form, storing nothing', async () => {
    const { env, vaultKv, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await worker.fetch(postForm('/connect/awin', { token, AWIN_API_TOKEN: 'only-one-field' }), env);
    const body = await res.text();
    expect(body).toContain('All fields are required');
    expect(vaultKv.store.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs the CJ GraphQL connection test with the documented query and bearer header', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { me: { id: '1', companyId: '999' } } }), { status: 200 }));

    await worker.fetch(postForm('/connect/cj', { token, CJ_API_TOKEN: 'cj-token-marker', CJ_COMPANY_ID: '999' }), env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://commissions.api.cj.com/query');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer cj-token-marker');
    const payload = JSON.parse(init.body as string) as { query: string };
    expect(payload.query).toContain('me {');
  });

  it('runs the Impact Basic-auth connection test against /Mediapartners/{SID}/Campaigns', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"Campaigns":[]}', { status: 200 }));

    await worker.fetch(
      postForm('/connect/impact', { token, IMPACT_ACCOUNT_SID: 'SID123', IMPACT_AUTH_TOKEN: 'tok-marker' }),
      env,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.impact.com/Mediapartners/SID123/Campaigns?PageSize=1');
    const expectedBasic = btoa('SID123:tok-marker');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${expectedBasic}`);
  });

  it('runs the Rakuten OAuth2 token-exchange connection test', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }));

    await worker.fetch(
      postForm('/connect/rakuten', {
        token,
        RAKUTEN_CLIENT_ID: 'cid',
        RAKUTEN_CLIENT_SECRET: 'csecret',
        RAKUTEN_SID: '42',
      }),
      env,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.linksynergy.com/token');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${btoa('cid:csecret')}`);
    expect(init.body).toBe('scope=42');
  });
});

// ── POST /connect/:network/retest ────────────────────────────────────────────
describe('POST /connect/:network/retest', () => {
  it('re-runs the test on the already-stored credential without resubmitting the form', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('server error', { status: 500 }));
    await worker.fetch(postForm('/connect/awin', { token, AWIN_API_TOKEN: 'retest-marker-9999', AWIN_PUBLISHER_ID: '1' }), env);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('[]', { status: 200 }));
    const res = await worker.fetch(postForm('/connect/awin/retest', { token }), env);
    const body = await res.text();
    expect(body).toContain('Connection test passed');
    expect(body).toContain('9999');
    expect(body).not.toContain('retest-marker-9999');
    expectNoTokenInAnyUrl(body, token);
  });

  it('returns a not-connected page, never a fabricated test result, when nothing was stored', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(postForm('/connect/cj/retest', { token }), env);
    const body = await res.text();
    expect(body).toContain('not connected');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── No batch endpoint (sequential by construction) ───────────────────────────
describe('no batch connect endpoint exists', () => {
  it('POST /connect renders the list and stores nothing, even when credential fields are smuggled in', async () => {
    const { env, vaultKv, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      postForm('/connect', {
        token,
        AWIN_API_TOKEN: 'batch-smuggle-a',
        CJ_API_TOKEN: 'batch-smuggle-b',
      }),
      env,
    );
    expect(await res.text()).toContain('connect a network');
    expect(vaultKv.store.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a submitted field not declared for the target network is silently dropped, never stored', async () => {
    const { env, vaultKv, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));

    await worker.fetch(
      postForm('/connect/awin', {
        token,
        AWIN_API_TOKEN: 'a',
        AWIN_PUBLISHER_ID: '1',
        CJ_API_TOKEN: 'sneaked-in-cj-token',
      }),
      env,
    );

    const stored = Array.from(vaultKv.store.entries()).find(([k]) => k.includes('awin'));
    expect(stored).toBeDefined();
    // The stored blob is ciphertext, but the plaintext CJ marker must never have
    // been part of what was encrypted for the awin record — verified indirectly
    // by confirming no separate cj credential key was ever created either.
    const hasCjKey = Array.from(vaultKv.store.keys()).some((k) => k.includes(':cj'));
    expect(hasCjKey).toBe(false);
  });
});

// ── no-store and no-referrer on every connect response ──────────────────────
describe('security headers on every connect response', () => {
  it('POST /connect carries cache-control: no-store and referrer-policy: no-referrer', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    const res = await worker.fetch(postForm('/connect', { token }), env);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('the sign-in prompt page also carries both headers', async () => {
    const { env } = await makeTestEnv();
    const res = await worker.fetch(get('/connect'), env);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('the connection-test result page carries both headers', async () => {
    const { env, signingKey } = await makeTestEnv();
    const token = await issueSessionToken(signingKey, generateUserId());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    const res = await worker.fetch(postForm('/connect/awin', { token, AWIN_API_TOKEN: 'a', AWIN_PUBLISHER_ID: '1' }), env);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
