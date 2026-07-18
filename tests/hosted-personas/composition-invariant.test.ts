/**
 * Tier 2 (composition seam) — the direct-vs-hosted byte-identical invariant.
 *
 * The plan's load-bearing claim: the hosted path is the local path plus an
 * auth/entitlement/vault wrapper, never a divergent code path. Both ends at the
 * same `tool.handle`. So for an entitled, connected, under-cap persona, the SAME
 * tool call must produce byte-identical adapter output whether driven directly
 * (Component A's local path, credentials from env) or through the real hosted
 * transport (credentials revealed from the vault). Hosted mode only ADDS
 * refusals — proven by the unentitled-persona boundary case.
 *
 * This is the one Tier 2 assertion not already covered by the hosted Worker and
 * transport suites (see ./README.md for the coverage map); it does not re-test
 * OAuth, the vault, the tier gate, or Stripe transitions, which are proven in
 * their owning suites.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import '../../src/networks/index.js';
import { generateAllTools } from '../../src/tools/generate.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { clearCache } from '../../src/shared/cache.js';
import { startHostedHttpServer, type HostedHttpServerHandle } from '../../src/hosted-transport/index.js';

const COMMISSIONS = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'cj', 'commissions.json'), 'utf8'),
);
const WINDOW = { from: '2024-08-01', to: '2024-10-01' };
const CJ_CREDS = { CJ_API_TOKEN: 'vault-supplied-cj-token', CJ_COMPANY_ID: '1234567' };

interface Session {
  userId: string;
  exp: number;
}
interface Entitlement {
  tier: 'none' | 'solo' | 'pro';
  status: string;
}
interface FakeWorker {
  url: string;
  sessions: Map<string, Session>;
  vault: Map<string, Record<string, string>>;
  entitlements: Map<string, Entitlement>;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<{ token?: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : {};
}

/** Slim double of the Worker's verify/entitlement/vault surface — the four
 * routes the transport calls. The Worker's own logic is proven in hosted/test. */
function startFakeWorker(): Promise<FakeWorker> {
  const sessions = new Map<string, Session>();
  const vault = new Map<string, Record<string, string>>();
  const entitlements = new Map<string, Entitlement>();

  const sessionFor = (req: IncomingMessage): Session | undefined => {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    return token ? sessions.get(token) : undefined;
  };

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/auth/session/verify' && req.method === 'POST') {
        const body = await readJson(req);
        const session = typeof body.token === 'string' ? sessions.get(body.token) : undefined;
        if (!session || session.exp <= Math.floor(Date.now() / 1000)) {
          sendJson(res, 401, { error: 'invalid_token' });
          return;
        }
        sendJson(res, 200, { userId: session.userId, exp: session.exp, scope: 'full' });
        return;
      }
      if (url.pathname === '/billing/entitlement' && req.method === 'GET') {
        const session = sessionFor(req);
        if (!session) return sendJson(res, 401, { error: 'missing_session' });
        return sendJson(res, 200, entitlements.get(session.userId) ?? { tier: 'pro', status: 'active' });
      }
      if (url.pathname === '/vault/credentials' && req.method === 'GET') {
        const session = sessionFor(req);
        if (!session) return sendJson(res, 401, { error: 'missing_session' });
        const prefix = `${session.userId}:`;
        const networks = [...vault.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
        return sendJson(res, 200, { networks });
      }
      const reveal = url.pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
      if (reveal && req.method === 'GET') {
        const session = sessionFor(req);
        if (!session) return sendJson(res, 401, { error: 'missing_session' });
        const record = vault.get(`${session.userId}:${decodeURIComponent(reveal[1] as string)}`);
        if (!record) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { network: decodeURIComponent(reveal[1] as string), credentials: record });
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
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

let worker: FakeWorker;
let transport: HostedHttpServerHandle;
let realFetch: typeof fetch;

beforeEach(async () => {
  _resetBreakers();
  clearCache();
  realFetch = globalThis.fetch;
  worker = await startFakeWorker();
  transport = await startHostedHttpServer({
    authUrl: worker.url,
    vaultUrl: worker.url,
    port: 0,
    rateLimitCapacity: 100,
    rateLimitRefillPerSecond: 100,
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await transport.close();
  await worker.close();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

/** Serve the CJ commissions fixture; pass every other leg through to real fetch
 * (client↔transport, transport↔worker are real loopback round trips). */
function mockCj(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('commissions.api.cj.com')) {
      return new Response(JSON.stringify(COMMISSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function calledCj(spy: ReturnType<typeof vi.fn>): boolean {
  return spy.mock.calls.some(([input]) => String(input).includes('commissions.api.cj.com'));
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'composition-invariant-client', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${transport.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function directEarnings(): Promise<unknown> {
  process.env['CJ_API_TOKEN'] = CJ_CREDS.CJ_API_TOKEN;
  process.env['CJ_COMPANY_ID'] = CJ_CREDS.CJ_COMPANY_ID;
  _resetBreakers();
  clearCache();
  mockCj(); // local path fetches the same CJ fixture bytes as the hosted path
  const tools = new Map(generateAllTools().map((t) => [t.name, t]));
  const tool = tools.get('affiliate_cj_get_earnings_summary');
  if (!tool) throw new Error('cj earnings tool missing');
  const result = await tool.handle(WINDOW);
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
  return result;
}

function parseToolResult(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content[0]?.text ?? '';
  return JSON.parse(text);
}

describe('hosted composition seam — direct vs hosted', () => {
  it('an entitled, connected persona gets byte-identical adapter output direct vs through the transport', async () => {
    // Direct path (Component A style): credentials from env.
    const direct = await directEarnings();

    // Hosted path: same tool, credentials revealed from the vault, driven
    // through the real transport. Env is clear, so the creds can only come from
    // the vault. A fresh cache means the hosted leg genuinely fetches.
    _resetBreakers();
    clearCache();
    const userId = 'hosted_usr_composition';
    const token = 'amcps_test.composition';
    worker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    worker.entitlements.set(userId, { tier: 'solo', status: 'active' });
    worker.vault.set(`${userId}:cj`, { ...CJ_CREDS });
    const spy = mockCj();

    const client = await connect(token);
    const raw = await client.callTool({ name: 'affiliate_cj_get_earnings_summary', arguments: WINDOW });
    await client.close();

    expect(raw.isError, 'hosted call should succeed for an entitled, connected persona').toBeFalsy();
    expect(calledCj(spy), 'the hosted leg must actually fetch CJ (not echo a cache)').toBe(true);
    expect(parseToolResult(raw)).toEqual(direct);
  });

  it('hosted mode only ADDS refusals: an unentitled persona is refused while the identical direct call still returns data', async () => {
    const direct = await directEarnings();
    expect((direct as { network?: string }).network).toBe('cj');

    _resetBreakers();
    clearCache();
    const userId = 'hosted_usr_none_boundary';
    const token = 'amcps_test.none_boundary';
    worker.sessions.set(token, { userId, exp: Math.floor(Date.now() / 1000) + 3600 });
    worker.entitlements.set(userId, { tier: 'none', status: 'none' });
    worker.vault.set(`${userId}:cj`, { ...CJ_CREDS });
    const spy = mockCj();

    const client = await connect(token);
    const raw = await client.callTool({ name: 'affiliate_cj_get_earnings_summary', arguments: WINDOW });
    await client.close();

    expect(raw.isError).toBe(true);
    const refusal = parseToolResult(raw) as { error: string };
    expect(refusal.error).toBe('entitlement_required');
    // Refused before the adapter ran: no CJ fetch happened.
    expect(calledCj(spy)).toBe(false);
  });
});
