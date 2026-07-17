/**
 * In-process end-to-end proof for the digest-compose service (H6,
 * redesigned per Rob's 2026-07-14 decision): a real `node:http` compose
 * service (`src/hosted-digest/server.ts`), driven the way the hosted
 * Worker's scheduled handler drives it — `POST /compose` with a per-user
 * bearer token and the doorbell header — against a lightweight double of
 * the hosted Worker's vault list/reveal routes on loopback. Only the CJ
 * adapter's own outbound `fetch` is mocked; every other leg (Worker-shaped
 * caller → compose service → fake vault) is a real HTTP round trip,
 * mirroring `tests/hosted-transport/http-server.test.ts`'s approach.
 *
 * The double, not the real `hosted/` Worker code, is used for the vault
 * side because `hosted/` is a separate npm workspace with
 * Cloudflare-Workers-only ambient types the root tsconfig does not carry.
 * The real Worker's own scope enforcement, token minting, and scheduled
 * orchestration are proven directly against the real code in
 * `hosted/test/scope.test.ts` and `hosted/test/digest-scheduled.test.ts`.
 * This suite proves the COMPOSE SERVICE's own wiring: token-bounded vault
 * reads, a real adapter call through the H1 seam, honest failure mapping,
 * and the doorbell.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetBreakers } from '../../src/shared/resilience.js';
import { startHostedDigestServer, type HostedDigestServerHandle } from '../../src/hosted-digest/server.js';

const COMPOSE_SECRET = 'test-doorbell';

interface FakeVaultWorker {
  url: string;
  /** `<token>` -> userId: which per-user token the fake vault accepts. */
  tokens: Map<string, string>;
  /** `<userId>:<network>` -> credential record. */
  vault: Map<string, Record<string, string>>;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/** A minimal double of the hosted Worker's vault list + reveal routes — the exact two routes a
 * digest-scoped token may reach (`hosted/src/routes/guard.ts`). Token semantics (scope, expiry)
 * are the real Worker's job, proven in `hosted/test/scope.test.ts`; this double only reproduces
 * "a known token reads its own user's entries, anything else is a 401". */
function startFakeVaultWorker(): Promise<FakeVaultWorker> {
  const tokens = new Map<string, string>();
  const vault = new Map<string, Record<string, string>>();

  const server: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authHeader = req.headers['authorization'];
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const userId = token ? tokens.get(token) : undefined;

    if (url.pathname === '/vault/credentials' && req.method === 'GET') {
      if (!userId) return sendJson(res, 401, { error: 'missing_session' });
      const prefix = `${userId}:`;
      const networks = Array.from(vault.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
      sendJson(res, 200, { networks });
      return;
    }

    const revealMatch = url.pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
    if (revealMatch && req.method === 'GET') {
      if (!userId) return sendJson(res, 401, { error: 'missing_session' });
      const network = decodeURIComponent(revealMatch[1] as string);
      const record = vault.get(`${userId}:${network}`);
      if (!record) return sendJson(res, 404, { error: 'not_found' });
      sendJson(res, 200, { network, credentials: record });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        tokens,
        vault,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

let fakeVault: FakeVaultWorker;
let composeService: HostedDigestServerHandle;
let realFetch: typeof fetch;

beforeEach(async () => {
  _resetBreakers();
  fakeVault = await startFakeVaultWorker();
  realFetch = globalThis.fetch;
  composeService = await startHostedDigestServer({
    vaultUrl: fakeVault.url,
    port: 0,
    composeSecret: COMPOSE_SECRET,
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await composeService.close();
  await fakeVault.close();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

/** Mocks only the CJ adapter's own outbound GraphQL call; every other leg (this test → compose
 * service → fake vault) passes through to the real `fetch`. */
function mockCjEarnings(): void {
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as Request).url ?? String(input));
    if (url.includes('commissions.api.cj.com')) {
      return new Response(
        JSON.stringify({
          data: {
            publisherCommissions: {
              count: 1,
              payloadComplete: true,
              records: [
                {
                  commissionId: 'c1',
                  actionId: 'a1',
                  advertiserId: '42',
                  advertiserName: 'Test Advertiser',
                  pubCommissionAmountUsd: '42.50',
                  pubCommissionAmountPubCurrency: '42.50',
                  currency: 'USD',
                  pubCurrency: 'USD',
                  actionStatus: 'NEW',
                  eventDate: '2026-07-10T00:00:00Z',
                  postingDate: '2026-07-10T00:00:00Z',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
}

function composeRequest(opts: {
  token?: string;
  doorbell?: string;
  body?: unknown;
}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.doorbell) headers['x-compose-auth'] = opts.doorbell;
  return realFetch(`http://127.0.0.1:${composeService.port}/compose`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe('digest-compose service (H6) end to end', () => {
  it('composes an earnings digest from a real adapter read, bounded by the caller\'s per-user token', async () => {
    const userId = 'hosted_usr_compose_e2e';
    const token = 'amcps_digest.token.e2e';
    fakeVault.tokens.set(token, userId);
    fakeVault.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 'vault-token', CJ_COMPANY_ID: '42' });
    mockCjEarnings();

    const res = await composeRequest({
      token,
      doorbell: COMPOSE_SECRET,
      body: { userId, digestType: 'earnings' },
    });

    expect(res.status).toBe(200);
    const digest = (await res.json()) as { subject: string; body: string };
    expect(digest.subject).toContain('earnings digest');
    expect(digest.body).toContain('42.50');
    expect(digest.body).toContain('cj');
    // Nothing email-shaped in either direction.
    expect(JSON.stringify(digest)).not.toMatch(/[\w.]+@[\w.]+\.[a-z]+/);
  });

  it('composes the unpaid-commissions digest from the same reads', async () => {
    const userId = 'hosted_usr_compose_unpaid';
    const token = 'amcps_digest.token.unpaid';
    fakeVault.tokens.set(token, userId);
    fakeVault.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 'vault-token', CJ_COMPANY_ID: '42' });
    mockCjEarnings();

    const res = await composeRequest({
      token,
      doorbell: COMPOSE_SECRET,
      body: { userId, digestType: 'unpaid-commissions' },
    });

    expect(res.status).toBe(200);
    const digest = (await res.json()) as { subject: string; body: string };
    expect(digest.subject).toContain('unpaid-commissions');
    expect(digest.body).toContain('unpaid');
  });

  it('rejects a request without the doorbell secret, before any vault call', async () => {
    const res = await composeRequest({ token: 'amcps_whatever', body: { userId: 'u', digestType: 'earnings' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'compose_auth_required' });
  });

  it('rejects a request with no bearer token', async () => {
    const res = await composeRequest({ doorbell: COMPOSE_SECRET, body: { userId: 'u', digestType: 'earnings' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_token' });
  });

  it('a token the vault does not accept yields an honest vault_unavailable, never an empty digest', async () => {
    // The doorbell alone (leaked, say) gets a caller NOTHING: the vault
    // rejects the unknown token and the compose service refuses to pretend.
    const res = await composeRequest({
      token: 'amcps_forged.or.expired',
      doorbell: COMPOSE_SECRET,
      body: { userId: 'hosted_usr_any', digestType: 'earnings' },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('vault_unavailable');
  });

  it('rejects a malformed digestType', async () => {
    const res = await composeRequest({
      token: 'amcps_t',
      doorbell: COMPOSE_SECRET,
      body: { userId: 'u', digestType: 'everything' },
    });
    expect(res.status).toBe(400);
  });

  it('GET /health answers without any auth', async () => {
    const res = await realFetch(`http://127.0.0.1:${composeService.port}/health`);
    expect(res.status).toBe(200);
  });
});
