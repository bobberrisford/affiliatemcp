/**
 * End-to-end test for the hosted MCP transport (H4:
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Exercises the REAL streamable-HTTP transport (a real `node:http` server,
 * `StreamableHTTPServerTransport`, an SDK `Client` over
 * `StreamableHTTPClientTransport`) against a lightweight in-process double of
 * the hosted Worker's auth-verify and vault-reveal HTTP surface — the same
 * shapes `hosted/src/index.ts` and `hosted/src/routes/vault.ts` implement,
 * proven separately by `hosted/test/vault-routes.test.ts` and
 * `hosted/test/worker.test.ts`. Only the CJ adapter's own outbound `fetch`
 * (to `commissions.api.cj.com`) is mocked — every other leg (client → this
 * transport, this transport → the fake hosted Worker) is a real HTTP round
 * trip on loopback, mirroring `tests/integration/request-context-seam.test.ts`'s
 * "prove the seam through a real adapter" approach one layer further out.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHostedHttpServer, type HostedHttpServerHandle } from '../../src/hosted-transport/index.js';
import { _resetBreakers } from '../../src/shared/resilience.js';

interface FakeSession {
  userId: string;
  exp: number; // unix seconds
  /** H6 token scope, as the real verify route reports it ("full" when omitted). */
  scope?: 'full' | 'digest';
}

interface FakeEntitlement {
  tier: 'none' | 'solo' | 'pro';
  status: string;
}

interface FakeHostedWorker {
  url: string;
  sessions: Map<string, FakeSession>;
  vault: Map<string, Record<string, string>>;
  /** Defaults every session to `pro` (uncapped, unrestricted) when a test does not set an entry
   * explicitly — every H4-era test in this file predates the H6 billing gate and expects
   * unrestricted hosted access, so `pro` is the behaviour-preserving default. H6's own tests
   * (`tier-gate.test.ts`, and the new describe block below) set this map explicitly per case. */
  entitlements: Map<string, FakeEntitlement>;
  /** When true, `/billing/entitlement` returns a 500 regardless of session validity — simulates
   * a billing-service outage distinct from "this token is invalid" or "tier is none". */
  billingUnavailable: boolean;
  close: () => Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/** A minimal double of the hosted Worker's `/auth/session/verify` and
 * `/vault/credentials/:network/reveal` routes — the exact two endpoints the
 * hosted transport calls (`session-auth.ts`, `vault-client.ts`). Session and
 * vault logic themselves are covered by `hosted/test/*.test.ts`; this double
 * exists only to drive the Node transport's own wiring end to end. */
function startFakeHostedWorker(): Promise<FakeHostedWorker> {
  const sessions = new Map<string, FakeSession>();
  const vault = new Map<string, Record<string, string>>();
  const entitlements = new Map<string, FakeEntitlement>();
  const state = { billingUnavailable: false };

  function sessionFor(req: IncomingMessage): FakeSession | undefined {
    const authHeader = req.headers['authorization'];
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : undefined;
    return token ? sessions.get(token) : undefined;
  }

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/auth/session/verify' && req.method === 'POST') {
        const body = (await readJson(req)) as { token?: unknown };
        const token = typeof body.token === 'string' ? body.token : undefined;
        const session = token ? sessions.get(token) : undefined;
        if (!session) {
          sendJson(res, 401, { error: 'invalid_token' });
          return;
        }
        if (session.exp <= Math.floor(Date.now() / 1000)) {
          sendJson(res, 401, { error: 'expired_token' });
          return;
        }
        sendJson(res, 200, { userId: session.userId, exp: session.exp, scope: session.scope ?? 'full' });
        return;
      }

      // H6: GET /billing/entitlement — session-gated. Defaults an unregistered
      // session to `pro` (see the FakeHostedWorker.entitlements doc comment).
      if (url.pathname === '/billing/entitlement' && req.method === 'GET') {
        if (state.billingUnavailable) {
          sendJson(res, 500, { error: 'internal_error' });
          return;
        }
        const session = sessionFor(req);
        if (!session) {
          sendJson(res, 401, { error: 'missing_session' });
          return;
        }
        const entitlement = entitlements.get(session.userId) ?? { tier: 'pro', status: 'active' };
        sendJson(res, 200, entitlement);
        return;
      }

      // H6: GET /vault/credentials — session-gated list of connected networks
      // (never values), for the Solo-tier network cap.
      if (url.pathname === '/vault/credentials' && req.method === 'GET') {
        const session = sessionFor(req);
        if (!session) {
          sendJson(res, 401, { error: 'missing_session' });
          return;
        }
        const prefix = `${session.userId}:`;
        const networks = Array.from(vault.keys())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
          .sort();
        sendJson(res, 200, { networks });
        return;
      }

      const revealMatch = url.pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
      if (revealMatch && req.method === 'GET') {
        const session = sessionFor(req);
        if (!session) {
          sendJson(res, 401, { error: 'missing_session' });
          return;
        }
        const network = decodeURIComponent(revealMatch[1] as string);
        const record = vault.get(`${session.userId}:${network}`);
        if (!record) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        sendJson(res, 200, { network, credentials: record });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        sessions,
        vault,
        entitlements,
        get billingUnavailable() {
          return state.billingUnavailable;
        },
        set billingUnavailable(v: boolean) {
          state.billingUnavailable = v;
        },
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

let fakeWorker: FakeHostedWorker;
let transportHandle: HostedHttpServerHandle;
let realFetch: typeof fetch;

// The audit log's "never arguments or a result" contract is proven at the
// unit level in `tests/hosted-transport/audit.test.ts`, against a mocked
// logger: pino's default destination (`pino.destination({fd: 2, ...})`,
// `src/shared/logging.ts`) writes via a raw fd (sonic-boom), bypassing
// `process.stderr.write` entirely, so it cannot be reliably intercepted from
// here — the same limitation `tests/shared/logging.test.ts` already notes.
// This suite instead confirms that a call which reaches `recordHostedAudit`
// completes normally end to end.

beforeEach(async () => {
  _resetBreakers();
  fakeWorker = await startFakeHostedWorker();
  realFetch = globalThis.fetch;
  transportHandle = await startHostedHttpServer({
    authUrl: fakeWorker.url,
    vaultUrl: fakeWorker.url,
    port: 0,
    rateLimitCapacity: 1,
    rateLimitRefillPerSecond: 0.0001, // effectively no mid-test refill
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await transportHandle.close();
  await fakeWorker.close();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

/** Mocks only the CJ adapter's own outbound call; everything else (client →
 * this transport, this transport → the fake hosted Worker) passes through to
 * the real `fetch`. Mirrors `tests/integration/request-context-seam.test.ts`'s
 * `mockFetch`. */
function mockCjNetworkCall(companyId: string): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request).url ?? String(input));
    if (url.includes('commissions.api.cj.com')) {
      return new Response(
        JSON.stringify({ data: { me: { id: 'u1', companyId, name: 'Test Co' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

async function connectClient(token: string): Promise<Client> {
  const client = new Client({ name: 'hosted-transport-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${transportHandle.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

describe('hosted MCP transport (H4) end to end', () => {
  it('an authenticated call reaches the adapter with vault-supplied credentials in the Authorization header', async () => {
    const userId = 'hosted_usr_test_alice';
    const token = 'amcps_test.session.alice';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.vault.set(`${userId}:cj`, {
      CJ_API_TOKEN: 'vault-supplied-cj-token',
      CJ_COMPANY_ID: '7654321',
    });
    const spy = mockCjNetworkCall('7654321');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });

    const cjCall = spy.mock.calls.find(([input]) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      return url.includes('commissions.api.cj.com');
    });
    expect(cjCall).toBeDefined();
    const init = cjCall?.[1] as RequestInit;
    const auth = (init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe('Bearer vault-supplied-cj-token');
    expect(result.isError).toBeFalsy();

    await client.close();
  });

  it('rejects a call with no bearer token as a transport-level 401', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${transportHandle.port}/mcp`),
    );
    const client = new Client({ name: 'hosted-transport-test-client', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('rejects an expired session token as a 401', async () => {
    const userId = 'hosted_usr_test_expired';
    const token = 'amcps_test.session.expired';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) - 10 });

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${transportHandle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: 'hosted-transport-test-client', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('rejects a digest-scoped token as a 401 — the digest token authorises two vault reads, never MCP tool calls (H6)', async () => {
    const userId = 'hosted_usr_test_digest_scope';
    const token = 'amcps_test.session.digest_scope';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 900, scope: 'digest' });

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${transportHandle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: 'hosted-transport-test-client', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('returns the existing unconfigured-credential guidance envelope when the vault has no credential for the network — never invents success', async () => {
    const userId = 'hosted_usr_test_no_vault';
    const token = 'amcps_test.session.no_vault';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    // Deliberately no fakeWorker.vault entry for "cj" — not connected.
    delete process.env['CJ_API_TOKEN'];
    delete process.env['CJ_COMPANY_ID'];

    const client = await connectClient(token);
    // list_programmes throws through `requireCredential` when uncredentialed
    // (`src/networks/cj/adapter.ts`'s `requireCompanyId`/`requireToken`),
    // unlike `verify_auth`, which deliberately catches that failure and
    // reports `{ok: false, envelope}` as a normal (non-error) result — both
    // paths reuse the exact same `config_error` envelope construction.
    const result = await client.callTool({ name: 'affiliate_cj_list_programmes', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const envelope = JSON.parse(text) as { type: string; network: string; message: string };
    expect(envelope.type).toBe('config_error');
    expect(envelope.network).toBe('cj');

    await client.close();
  });

  it('returns a structured rate_limit envelope (not a transport error) once the per-user bucket is exhausted', async () => {
    const userId = 'hosted_usr_test_rate_limited';
    const token = 'amcps_test.session.rate_limited';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '1' });
    mockCjNetworkCall('1');

    const client = await connectClient(token);
    // Capacity is 1 with a negligible refill rate (see beforeEach): the first
    // call consumes the bucket, the second must be refused.
    const first = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(second.isError).toBe(true);
    const text = (second.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const envelope = JSON.parse(text) as { type: string };
    expect(envelope.type).toBe('rate_limit');

    await client.close();
  });

  it('completes a call that reaches the audit log without surfacing anything unexpected (payload-free contract proven in audit.test.ts)', async () => {
    const userId = 'hosted_usr_test_audit';
    const token = 'amcps_test.session.audit';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.vault.set(`${userId}:cj`, {
      CJ_API_TOKEN: 'super-secret-should-never-be-logged',
      CJ_COMPANY_ID: '7654321',
    });
    mockCjNetworkCall('7654321');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

describe('hosted MCP transport (H6) billing-tier gate', () => {
  function connectedNetworkFields(userId: string, networks: string[]): void {
    for (const network of networks) {
      fakeWorker.vault.set(`${userId}:${network}`, { PLACEHOLDER: 'x' });
    }
  }

  it('refuses every tool call for tier "none", before any vault or adapter call', async () => {
    const userId = 'hosted_usr_test_none_tier';
    const token = 'amcps_test.session.none_tier';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.entitlements.set(userId, { tier: 'none', status: 'none' });
    const cjSpy = mockCjNetworkCall('1');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const refusal = JSON.parse(text) as { error: string; entitled: boolean; tier: string };
    expect(refusal.error).toBe('entitlement_required');
    expect(refusal.entitled).toBe(false);
    expect(refusal.tier).toBe('none');
    expect(cjSpy.mock.calls.some(([input]) => String(input).includes('commissions.api.cj.com'))).toBe(false);

    await client.close();
  });

  it('solo tier: allows a new network while under the 5-network cap', async () => {
    const userId = 'hosted_usr_test_solo_under_cap';
    const token = 'amcps_test.session.solo_under_cap';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.entitlements.set(userId, { tier: 'solo', status: 'active' });
    connectedNetworkFields(userId, ['awin', 'impact']);
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '55' });
    mockCjNetworkCall('55');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('solo tier: denies a NEW 6th network once already at the cap, without ever calling it', async () => {
    const userId = 'hosted_usr_test_solo_at_cap';
    const token = 'amcps_test.session.solo_at_cap';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.entitlements.set(userId, { tier: 'solo', status: 'active' });
    connectedNetworkFields(userId, ['awin', 'impact', 'rakuten', 'shareasale', 'admitad']);
    // Deliberately NOT connecting cj — this is the 6th, new network.
    const cjSpy = mockCjNetworkCall('1');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const refusal = JSON.parse(text) as { error: string; tier: string };
    expect(refusal.error).toBe('network_cap_exceeded');
    expect(refusal.tier).toBe('solo');
    expect(cjSpy.mock.calls.some(([input]) => String(input).includes('commissions.api.cj.com'))).toBe(false);

    await client.close();
  });

  it('solo tier: still allows continued use of an already-connected network even at the cap', async () => {
    const userId = 'hosted_usr_test_solo_reuse_at_cap';
    const token = 'amcps_test.session.solo_reuse_at_cap';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.entitlements.set(userId, { tier: 'solo', status: 'active' });
    connectedNetworkFields(userId, ['awin', 'impact', 'rakuten', 'shareasale']);
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '99' });
    mockCjNetworkCall('99');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('pro tier: uncapped even with more than 5 networks already connected', async () => {
    const userId = 'hosted_usr_test_pro_uncapped';
    const token = 'amcps_test.session.pro_uncapped';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    fakeWorker.entitlements.set(userId, { tier: 'pro', status: 'active' });
    connectedNetworkFields(userId, ['awin', 'impact', 'rakuten', 'shareasale', 'admitad', 'ebay']);
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '7' });
    mockCjNetworkCall('7');

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('surfaces a billing-service outage as its own distinct envelope, never as tier "none"', async () => {
    const userId = 'hosted_usr_test_billing_outage';
    const token = 'amcps_test.session.billing_outage';
    fakeWorker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    // /auth/session/verify still works; only /billing/entitlement fails —
    // proves the transport tells this apart from "this token is invalid" and
    // from "tier is none".
    fakeWorker.billingUnavailable = true;

    const client = await connectClient(token);
    const result = await client.callTool({ name: 'affiliate_cj_verify_auth', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toBe('billing_unavailable');

    await client.close();
  });
});
