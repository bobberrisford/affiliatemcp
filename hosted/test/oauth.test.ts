/**
 * OAuth 2.1 authorization-code + PKCE flow tests (slice 1,
 * `docs/decisions/2026-07-15-hosted-connector-oauth.md`).
 *
 * Covers: discovery metadata, dynamic client registration, `/authorize`
 * parameter validation and the open-redirect guard, the full
 * register → authorize → magic-link → consent → code → token happy path,
 * PKCE S256 success and failure, single-use codes, redirect_uri and client_id
 * binding at the token endpoint, refresh-token rotation, consent denial, and
 * that the issued access token is a short-lived FULL-scope session the
 * existing `/auth/session/verify` accepts (so the transport keeps working and
 * OAuth never mints a digest-scoped token).
 *
 * KV is the same in-memory fake the other hosted tests use; Resend is spied on
 * global fetch to capture the emailed magic-link token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { base64urlEncode } from '../src/token.js';

function fakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

async function generatePrivateKeyB64(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return btoa(String.fromCharCode(...pkcs8));
}

const TEST_VAULT_MASTER_KEY_B64 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

async function makeEnv(): Promise<Env> {
  return {
    HOSTED_USERS: fakeKV(),
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: fakeKV(),
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: await generatePrivateKeyB64(),
    VAULT_MASTER_KEY: TEST_VAULT_MASTER_KEY_B64,
    PUBLIC_BASE_URL: 'https://hosted.test',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
  };
}

const BASE = 'https://hosted.test';
const REDIRECT_URI = 'https://client.example/callback';

function getReq(path: string): Request {
  return new Request(`${BASE}${path}`);
}
function jsonPost(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

function mockResend() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));
}

/** A PKCE verifier (43 base64url chars from 32 random bytes) and its S256
 * challenge, computed exactly as `verifyPkceS256` expects. */
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const vbytes = new Uint8Array(32);
  crypto.getRandomValues(vbytes);
  const verifier = base64urlEncode(vbytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

async function registerClient(env: Env, redirectUris: string[] = [REDIRECT_URI]): Promise<string> {
  const res = await worker.fetch(jsonPost('/register', { redirect_uris: redirectUris, client_name: 'Test MCP Client' }), env);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function authorizeUrl(params: Record<string, string>): string {
  return `/authorize?${new URLSearchParams(params).toString()}`;
}

/** Drive register → authorize → email → callback → consent(approve) → code.
 * Returns the authorization code and the PKCE verifier for the token step. */
async function runToAuthCode(
  env: Env,
  opts: { state?: string } = {},
): Promise<{ clientId: string; code: string; verifier: string }> {
  const clientId = await registerClient(env);
  const { verifier, challenge } = await pkcePair();

  const authRes = await worker.fetch(
    getReq(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(opts.state ? { state: opts.state } : {}),
      }),
    ),
    env,
  );
  expect(authRes.status).toBe(200);
  const signInHtml = await authRes.text();
  const reqId = (signInHtml.match(/name="auth_req" value="([^"]+)"/) as RegExpMatchArray)[1] as string;

  const fetchSpy = mockResend();
  const emailRes = await worker.fetch(formPost('/authorize/email', { auth_req: reqId, email: 'user@example.com' }), env);
  expect(emailRes.status).toBe(200);
  const [, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
  const linkToken = (JSON.parse(init.body as string).text as string).match(/token=([^\s]+)/)?.[1] as string;
  fetchSpy.mockRestore();

  const cbRes = await worker.fetch(getReq(`/auth/callback?token=${linkToken}`), env);
  expect(cbRes.status).toBe(200);
  const consentHtml = await cbRes.text();
  const consentToken = (consentHtml.match(/name="token" value="([^"]+)"/) as RegExpMatchArray)[1] as string;

  const consentRes = await worker.fetch(
    formPost('/authorize/consent', { auth_req: reqId, token: consentToken, decision: 'approve' }),
    env,
  );
  expect(consentRes.status).toBe(302);
  const location = consentRes.headers.get('location') as string;
  const code = new URL(location).searchParams.get('code') as string;
  expect(code).toBeTruthy();

  return { clientId, code, verifier };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Metadata ────────────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('advertises the endpoints, S256-only PKCE, and public-client auth', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(getReq('/.well-known/oauth-authorization-server'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe('https://hosted.test');
    expect(meta.authorization_endpoint).toBe('https://hosted.test/authorize');
    expect(meta.token_endpoint).toBe('https://hosted.test/token');
    expect(meta.registration_endpoint).toBe('https://hosted.test/register');
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('OPTIONS preflight answers with a wildcard origin', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/token`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ── Dynamic client registration ───────────────────────────────────────────

describe('POST /register', () => {
  it('registers a public client and returns a client_id with no secret', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(jsonPost('/register', { redirect_uris: [REDIRECT_URI] }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe('string');
    expect(body).not.toHaveProperty('client_secret');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
  });

  it('accepts a loopback http redirect URI (native app, RFC 8252)', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(jsonPost('/register', { redirect_uris: ['http://127.0.0.1:8976/callback'] }), env);
    expect(res.status).toBe(201);
  });

  it('rejects an empty redirect_uris array', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(jsonPost('/register', { redirect_uris: [] }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('rejects a non-loopback http redirect URI', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(jsonPost('/register', { redirect_uris: ['http://evil.example/cb'] }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('rejects a confidential-client auth method (public clients only)', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      jsonPost('/register', { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'client_secret_post' }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
  });

  it('rate-limits registrations per IP (backstop against KV-inflating loops)', async () => {
    const env = await makeEnv();
    const fromIp = () =>
      new Request(`${BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
      });
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(fromIp(), env);
      expect(res.status).toBe(201);
    }
    const overLimit = await worker.fetch(fromIp(), env);
    expect(overLimit.status).toBe(429);
    expect(((await overLimit.json()) as { error: string }).error).toBe('temporarily_unavailable');
  });
});

// ── /authorize validation ─────────────────────────────────────────────────

describe('GET /authorize validation', () => {
  it('renders an error page (not a redirect) for an unknown client_id', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT_URI, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })),
      env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
  });

  it('renders an error page for an unregistered redirect_uri (no open redirect)', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: 'https://attacker.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })),
      env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects with unsupported_response_type when response_type is not code, preserving state', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'token', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc123' })),
      env,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
    expect(loc.searchParams.get('state')).toBe('abc123');
  });

  it('redirects with invalid_request when PKCE is not S256', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'plain' })),
      env,
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe('invalid_request');
  });

  it('redirects with invalid_request when code_challenge is missing', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge_method: 'S256' })),
      env,
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe('invalid_request');
  });

  it('renders the sign-in page carrying a pending request id for a valid request', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const res = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256' })),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/name="auth_req" value="[^"]+"/);
    expect(body).toContain('Test MCP Client');
    expect(body).toContain('/authorize/email');
  });
});

// ── Full happy path + token endpoint ────────────────────────────────────────

describe('authorization-code happy path', () => {
  it('mints an access token the existing /auth/session/verify accepts as a full session, plus a refresh token', async () => {
    const env = await makeEnv();
    const { clientId, code, verifier } = await runToAuthCode(env, { state: 'xyz' });

    const tokenRes = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    const tok = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
    };
    expect(tok.token_type).toBe('Bearer');
    expect(tok.expires_in).toBe(3600);
    expect(tok.access_token.startsWith('amcps_')).toBe(true);
    expect(tok.refresh_token.startsWith('amcpr_')).toBe(true);

    // The access token is a real, full-scope hosted session: the existing
    // verify endpoint (which the transport calls) accepts it.
    const verifyRes = await worker.fetch(jsonPost('/auth/session/verify', { token: tok.access_token }), env);
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as { userId: string; scope: string };
    expect(verified.userId).toMatch(/^hosted_usr_/);
    expect(verified.scope).toBe('full');
  });

  it('carries state through to the redirect', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const authRes = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-value-42' })),
      env,
    );
    const reqId = ((await authRes.text()).match(/name="auth_req" value="([^"]+)"/) as RegExpMatchArray)[1] as string;
    const spy = mockResend();
    await worker.fetch(formPost('/authorize/email', { auth_req: reqId, email: 'u@example.com' }), env);
    const [, init] = spy.mock.calls[spy.mock.calls.length - 1] as [string, RequestInit];
    const linkToken = (JSON.parse(init.body as string).text as string).match(/token=([^\s]+)/)?.[1] as string;
    const cb = await worker.fetch(getReq(`/auth/callback?token=${linkToken}`), env);
    const consentToken = ((await cb.text()).match(/name="token" value="([^"]+)"/) as RegExpMatchArray)[1] as string;
    const consentRes = await worker.fetch(
      formPost('/authorize/consent', { auth_req: reqId, token: consentToken, decision: 'approve' }),
      env,
    );
    // Unused here but keeps the flow honest.
    void verifier;
    expect(new URL(consentRes.headers.get('location') as string).searchParams.get('state')).toBe('state-value-42');
  });
});

// ── PKCE, single-use, binding ───────────────────────────────────────────────

describe('token endpoint guards', () => {
  it('rejects a wrong PKCE code_verifier with invalid_grant', async () => {
    const env = await makeEnv();
    const { clientId, code } = await runToAuthCode(env);
    const wrong = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const res = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: wrong }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a reused authorization code (single use)', async () => {
    const env = await makeEnv();
    const { clientId, code, verifier } = await runToAuthCode(env);
    const first = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
      env,
    );
    expect(first.status).toBe(200);
    const second = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
      env,
    );
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that does not match the authorization request', async () => {
    const env = await makeEnv();
    const { clientId, code, verifier } = await runToAuthCode(env);
    const res = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/other', client_id: clientId, code_verifier: verifier }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a client_id that does not match the authorization code', async () => {
    const env = await makeEnv();
    const { code, verifier } = await runToAuthCode(env);
    const otherClient = await registerClient(env, ['https://other.example/cb']);
    const res = await worker.fetch(
      formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: otherClient, code_verifier: verifier }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects an unknown grant_type', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(formPost('/token', { grant_type: 'password' }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

// ── Refresh-token rotation ──────────────────────────────────────────────────

describe('refresh_token grant', () => {
  it('issues a new access token and rotates the refresh token (old one stops working)', async () => {
    const env = await makeEnv();
    const { clientId, code, verifier } = await runToAuthCode(env);
    const first = (await (
      await worker.fetch(
        formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
        env,
      )
    ).json()) as { refresh_token: string };

    const refreshed = await worker.fetch(
      formPost('/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId }),
      env,
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token.startsWith('amcps_')).toBe(true);
    expect(next.refresh_token).not.toBe(first.refresh_token);

    // The rotated-out refresh token is dead.
    const reuse = await worker.fetch(
      formPost('/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId }),
      env,
    );
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a refresh with a mismatched client_id', async () => {
    const env = await makeEnv();
    const { clientId, code, verifier } = await runToAuthCode(env);
    const first = (await (
      await worker.fetch(
        formPost('/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
        env,
      )
    ).json()) as { refresh_token: string };
    const res = await worker.fetch(
      formPost('/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: 'someone_else' }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

// ── Consent denial ──────────────────────────────────────────────────────────

describe('consent', () => {
  it('redirects with access_denied when the user denies', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const authRes = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })),
      env,
    );
    const reqId = ((await authRes.text()).match(/name="auth_req" value="([^"]+)"/) as RegExpMatchArray)[1] as string;
    const spy = mockResend();
    await worker.fetch(formPost('/authorize/email', { auth_req: reqId, email: 'u@example.com' }), env);
    const [, init] = spy.mock.calls[spy.mock.calls.length - 1] as [string, RequestInit];
    const linkToken = (JSON.parse(init.body as string).text as string).match(/token=([^\s]+)/)?.[1] as string;
    const cb = await worker.fetch(getReq(`/auth/callback?token=${linkToken}`), env);
    const consentToken = ((await cb.text()).match(/name="token" value="([^"]+)"/) as RegExpMatchArray)[1] as string;

    const denyRes = await worker.fetch(
      formPost('/authorize/consent', { auth_req: reqId, token: consentToken, decision: 'deny' }),
      env,
    );
    expect(denyRes.status).toBe(302);
    const loc = new URL(denyRes.headers.get('location') as string);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('s');
  });

  it('rejects a consent submission whose session token is missing/invalid', async () => {
    const env = await makeEnv();
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const authRes = await worker.fetch(
      getReq(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256' })),
      env,
    );
    const reqId = ((await authRes.text()).match(/name="auth_req" value="([^"]+)"/) as RegExpMatchArray)[1] as string;
    const res = await worker.fetch(
      formPost('/authorize/consent', { auth_req: reqId, token: 'amcps_not_a_real_token', decision: 'approve' }),
      env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});
