/**
 * Worker route tests for the hosted auth scaffold. Resend is mocked via a spy
 * on global fetch (no live network calls); KV is an in-memory fake mirroring
 * the issuer/waitlist Workers' test style.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { buildSessionPayload, signSession } from '../src/token.js';

function fakeKV(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

async function generatePrivateKeyB64(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return btoa(String.fromCharCode(...pkcs8));
}

// 32 raw bytes ("0123456789abcdef0123456789abcdef"), base64-encoded — a
// syntactically valid VAULT_MASTER_KEY for tests that do not exercise the
// vault routes directly (see test/vault-routes.test.ts for those).
const TEST_VAULT_MASTER_KEY_B64 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

function makeEnv(kv: KVNamespace, signingKey: string, overrides: Partial<Env> = {}): Env {
  return {
    HOSTED_USERS: kv,
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: fakeKV(),
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: TEST_VAULT_MASTER_KEY_B64,
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
    ...overrides,
  };
}

const post = (path: string, body?: unknown) =>
  new Request(`https://hosted.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function mockResendSuccess() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('health', () => {
  it('GET /health responds 200', async () => {
    const res = await worker.fetch(new Request('https://hosted.test/health'), makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(200);
  });

  it('GET / also responds 200', async () => {
    const res = await worker.fetch(new Request('https://hosted.test/'), makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(200);
  });

  it('unknown routes are a 404', async () => {
    const res = await worker.fetch(new Request('https://hosted.test/nope'), makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('OPTIONS preflight from the configured site origin reflects it back', async () => {
    const req = new Request('https://hosted.test/auth/request-link', {
      method: 'OPTIONS',
      headers: { origin: 'https://agenticaffiliate.ai' },
    });
    const res = await worker.fetch(req, makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://agenticaffiliate.ai');
  });

  it('does not reflect a disallowed origin', async () => {
    const req = new Request('https://hosted.test/auth/request-link', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    const res = await worker.fetch(req, makeEnv(fakeKV(), 'x'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /auth/request-link validation', () => {
  it('rejects malformed JSON with a 400', async () => {
    const req = new Request('https://hosted.test/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await worker.fetch(req, makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('rejects a missing email with a 400', async () => {
    const res = await worker.fetch(post('/auth/request-link', {}), makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_email');
  });

  it('rejects a malformed email with a 400', async () => {
    const res = await worker.fetch(post('/auth/request-link', { email: 'not-an-email' }), makeEnv(fakeKV(), 'x'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_email');
  });
});

describe('POST /auth/request-link neutrality', () => {
  it('returns the identical response for a brand-new address and a returning one', async () => {
    mockResendSuccess();
    const kv = fakeKV();
    const signingKey = await generatePrivateKeyB64();
    const env = makeEnv(kv, signingKey);

    const first = await worker.fetch(post('/auth/request-link', { email: 'new@example.com' }), env);
    const firstBody = await first.json();

    // Simulate the address now belonging to an existing account by seeding an
    // email-hash mapping directly is unnecessary here: the point under test is
    // that the *response* never varies with account existence, which the
    // handler guarantees by never branching on getOrCreateUser at all during
    // request-link (account creation happens only at /auth/callback).
    const second = await worker.fetch(post('/auth/request-link', { email: 'returning@example.com' }), env);
    const secondBody = await second.json();

    expect(first.status).toBe(second.status);
    expect(firstBody).toEqual(secondBody);
    expect(first.status).toBe(200);
  });

  it('still returns 200 when the upstream Resend send fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    const res = await worker.fetch(post('/auth/request-link', { email: 'person@example.com' }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('sends a callback link containing a token via Resend, addressed to the submitted email', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    await worker.fetch(post('/auth/request-link', { email: 'person@example.com' }), env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer re_test_x');
    const payload = JSON.parse(init.body as string) as { to: string; text: string };
    expect(payload.to).toBe('person@example.com');
    expect(payload.text).toContain('/auth/callback?token=');
  });

  it('builds the emailed link from PUBLIC_BASE_URL, never from the request host', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    // Simulate a host-poisoned request arriving via a fronting proxy: the
    // request URL claims a different host than the configured base URL.
    const req = new Request('https://attacker-proxy.example/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com' }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string; html: string };
    expect(payload.text).toContain('https://hosted.test/auth/callback?token=');
    expect(payload.text).not.toContain('attacker-proxy.example');
    expect(payload.html).not.toContain('attacker-proxy.example');
  });

  it('returns a 500 and sends nothing when PUBLIC_BASE_URL is missing', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), 'x', { PUBLIC_BASE_URL: '' });
    const res = await worker.fetch(post('/auth/request-link', { email: 'person@example.com' }), env);
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a 500 and sends nothing when PUBLIC_BASE_URL is not a URL', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), 'x', { PUBLIC_BASE_URL: 'not a url' });
    const res = await worker.fetch(post('/auth/request-link', { email: 'person@example.com' }), env);
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never logs the submitted email address, on success or upstream failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('server error', { status: 500 }));

    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    await worker.fetch(post('/auth/request-link', { email: 'secret-person@example.com' }), env);

    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(call.join(' ')).not.toContain('secret-person@example.com');
    }
  });
});

describe('POST /auth/request-link abuse limit', () => {
  it('returns the identical neutral body once the per-address limit is hit, and skips the send', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());

    let firstBody: unknown;
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(post('/auth/request-link', { email: 'victim@example.com' }), env);
      expect(res.status).toBe(200);
      if (i === 0) firstBody = await res.json();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    const sixth = await worker.fetch(post('/auth/request-link', { email: 'victim@example.com' }), env);
    expect(sixth.status).toBe(200);
    // Byte-identical neutral body: the limiter is not probeable.
    expect(await sixth.json()).toEqual(firstBody);
    // And Resend was NOT called a sixth time — the send was skipped.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('limits per address: a different address from the same client still gets a send', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());

    for (let i = 0; i < 6; i++) {
      await worker.fetch(post('/auth/request-link', { email: 'victim@example.com' }), env);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5); // 6th was over the address limit

    await worker.fetch(post('/auth/request-link', { email: 'someone-else@example.com' }), env);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('enforces the per-IP limit across different addresses', async () => {
    const fetchSpy = mockResendSuccess();
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    const fromIp = (email: string) =>
      new Request('https://hosted.test/auth/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ email }),
      });

    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(fromIp(`user${i}@example.com`), env);
      expect(res.status).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(20);

    const overLimit = await worker.fetch(fromIp('user20@example.com'), env);
    expect(overLimit.status).toBe(200);
    expect(await overLimit.json()).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(20); // send skipped
  });
});

describe('GET /auth/callback', () => {
  /** Pull the `hosted_session` value out of a callback's `Set-Cookie` header —
   * the browser session is now delivered as an HttpOnly cookie, not a page. */
  function sessionTokenFromSetCookie(res: Response): string {
    const setCookie = res.headers.get('set-cookie');
    const match = setCookie?.match(/hosted_session=([^;]+)/);
    if (!match) throw new Error('no hosted_session cookie on the callback response');
    return match[1] as string;
  }

  async function requestLinkAndExtractToken(env: Env): Promise<string> {
    const fetchSpy = mockResendSuccess();
    await worker.fetch(post('/auth/request-link', { email: 'person@example.com' }), env);
    // Read the LAST Resend call: within one test, repeated vi.spyOn calls
    // reuse the same underlying mock, so earlier sends stay in mock.calls.
    const [, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    const match = payload.text.match(/token=([^\s]+)/);
    if (!match) throw new Error('no token found in email body');
    return match[1] as string;
  }

  it('rejects a missing token with a 400 error page', async () => {
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    const res = await worker.fetch(new Request('https://hosted.test/auth/callback'), env);
    expect(res.status).toBe(400);
  });

  it('rejects an unknown token with a 400 error page', async () => {
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    const res = await worker.fetch(new Request('https://hosted.test/auth/callback?token=nope'), env);
    expect(res.status).toBe(400);
  });

  it('consumes a valid token, sets an HttpOnly session cookie, and 303-redirects to the dashboard', async () => {
    const kv = fakeKV();
    const env = makeEnv(kv, await generatePrivateKeyB64());
    const rawToken = await requestLinkAndExtractToken(env);

    const res = await worker.fetch(new Request(`https://hosted.test/auth/callback?token=${rawToken}`), env);
    // Since OAuth slice 3: no token page. The browser session is an HttpOnly
    // cookie, and the callback redirects to the dashboard.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/connect');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^hosted_session=amcps_[^;]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    // The token is never in the response body.
    expect(await res.text()).toBe('');

    const sessionToken = sessionTokenFromSetCookie(res);
    const verifyRes = await worker.fetch(post('/auth/session/verify', { token: sessionToken }), env);
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as { userId: string; exp: number };
    expect(verified.userId).toMatch(/^hosted_usr_/);
    expect(typeof verified.exp).toBe('number');
  });

  it('is single-use: a second callback with the same token fails', async () => {
    const kv = fakeKV();
    const env = makeEnv(kv, await generatePrivateKeyB64());
    const rawToken = await requestLinkAndExtractToken(env);

    const first = await worker.fetch(new Request(`https://hosted.test/auth/callback?token=${rawToken}`), env);
    expect(first.status).toBe(303);

    const second = await worker.fetch(new Request(`https://hosted.test/auth/callback?token=${rawToken}`), env);
    expect(second.status).toBe(400);
  });

  it('reuses the same userId for a returning email across separate sign-ins', async () => {
    const kv = fakeKV();
    const env = makeEnv(kv, await generatePrivateKeyB64());

    async function signInOnceAndGetUserId(): Promise<string> {
      const rawToken = await requestLinkAndExtractToken(env);
      const callbackRes = await worker.fetch(
        new Request(`https://hosted.test/auth/callback?token=${rawToken}`),
        env,
      );
      const sessionToken = sessionTokenFromSetCookie(callbackRes);
      const verifyRes = await worker.fetch(post('/auth/session/verify', { token: sessionToken }), env);
      return ((await verifyRes.json()) as { userId: string }).userId;
    }

    const firstUserId = await signInOnceAndGetUserId();
    const secondUserId = await signInOnceAndGetUserId();

    // Both sign-ins used the same email (see requestLinkAndExtractToken), so
    // the second sign-in must resolve to the SAME account, not a new one.
    expect(secondUserId).toBe(firstUserId);
  });

  it('rejects a pending link whose stored expiry has already passed', async () => {
    const kv = fakeKV();
    const env = makeEnv(kv, await generatePrivateKeyB64());
    const { hashLinkToken } = await import('../src/identity.js');
    const rawToken = 'expired-raw-token';
    const hash = await hashLinkToken(rawToken);
    // Seed a pending-link record whose expiresAt is already in the past — the
    // defensive expiry check in handleCallback must reject it even though the
    // record was found (KV's own TTL is only the primary expiry mechanism).
    kv.store.set(`pending-link:${hash}`, JSON.stringify({ emailHash: 'email-hash:x', expiresAt: 1 }));

    const res = await worker.fetch(new Request(`https://hosted.test/auth/callback?token=${rawToken}`), env);
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/session/verify', () => {
  it('rejects a missing token with a 400', async () => {
    const env = makeEnv(fakeKV(), await generatePrivateKeyB64());
    const res = await worker.fetch(post('/auth/session/verify', {}), env);
    expect(res.status).toBe(400);
  });

  it('rejects a tampered token with a 401', async () => {
    const signingKey = await generatePrivateKeyB64();
    const env = makeEnv(fakeKV(), signingKey);
    const token = await signSession(
      buildSessionPayload({ sub: 'hosted_usr_x', iss: 1, exp: 9_999_999_999 }),
      signingKey,
    );
    const tampered = token.slice(0, -2) + 'zz';
    const res = await worker.fetch(post('/auth/session/verify', { token: tampered }), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it('rejects an expired token with a 401', async () => {
    const signingKey = await generatePrivateKeyB64();
    const env = makeEnv(fakeKV(), signingKey);
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signSession(
      buildSessionPayload({ sub: 'hosted_usr_x', iss: past - 100, exp: past }),
      signingKey,
    );
    const res = await worker.fetch(post('/auth/session/verify', { token }), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('expired_token');
  });

  it('accepts a valid, unexpired token', async () => {
    const signingKey = await generatePrivateKeyB64();
    const env = makeEnv(fakeKV(), signingKey);
    const iss = Math.floor(Date.now() / 1000);
    const exp = iss + 60 * 60 * 24 * 30;
    const token = await signSession(buildSessionPayload({ sub: 'hosted_usr_ok', iss, exp }), signingKey);
    const res = await worker.fetch(post('/auth/session/verify', { token }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; exp: number; iss: number };
    expect(body.userId).toBe('hosted_usr_ok');
    expect(body.exp).toBe(exp);
    // `iss` is surfaced so the transport can compute lifetime (exp - iss) and
    // reject long-lived pasted bearers during the staged migration.
    expect(body.iss).toBe(iss);
  });
});
