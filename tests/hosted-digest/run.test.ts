/**
 * In-process end-to-end proof for the hosted-digest job (H6): a subscribed
 * test user runs through the full cycle — admin roster, minted service
 * session, vault network list, a real adapter call through the H1 seam, and
 * the composed digest reaching the Worker's `POST /digest/send` — against a
 * lightweight, behaviourally-faithful double of the hosted Worker's
 * service-authenticated surface, real loopback HTTP throughout (mirroring
 * `tests/hosted-transport/http-server.test.ts`'s "prove the wiring through a
 * real adapter" approach). Only the CJ adapter's own outbound `fetch` and the
 * double's own Resend send are mocked.
 *
 * The double, not the real `hosted/` Worker code, is used here deliberately:
 * this is a ROOT-workspace test and `hosted/` is a separate npm workspace
 * with Cloudflare-Workers-only ambient types (`KVNamespace`, …) that the root
 * `tsconfig` does not carry — importing it directly would leak Workers-only
 * types into the root type-check. The real Worker routes' own correctness
 * (tier gating, service-secret enforcement, "never expose the email")
 * is proven directly against the real `hosted/src/index.ts` code in
 * `hosted/test/billing-routes.test.ts`. This suite proves the DIGEST JOB's
 * own wiring end to end; the double reproduces only the request/response
 * shapes the job depends on.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetBreakers } from '../../src/shared/resilience.js';
import { loadHostedDigestConfig } from '../../src/hosted-digest/env.js';
import { runHostedDigest } from '../../src/hosted-digest/run.js';

interface RecordedSend {
  userId: string;
  digestType: string;
  subject: string;
  body: string;
  resolvedEmail: string;
}

interface FakeHostedWorker {
  url: string;
  billing: Map<string, { tier: 'solo' | 'pro'; email: string }>;
  vault: Map<string, Record<string, string>>;
  sentDigests: RecordedSend[];
  /** userIds that should get a 500 from `/admin/session` (test-only failure injection). */
  failingUserIds: Set<string>;
  close: () => Promise<void>;
}

const SERVICE_SECRET = 'e2e-service-secret';

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

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function requireServiceSecret(req: IncomingMessage, res: ServerResponse): boolean {
  if (bearerToken(req) !== SERVICE_SECRET) {
    sendJson(res, 401, { error: 'invalid_service_secret' });
    return false;
  }
  return true;
}

/** Behaviourally-faithful double of the hosted Worker's H6 service-authenticated surface (see
 * the file-header comment for why a double, not the real `hosted/` code, is used here). Session
 * tokens are simple `svc-session:<userId>` strings — this double's own concern is request/response
 * shape fidelity, not session cryptography (covered by `hosted/test/token.test.ts`). */
function startFakeHostedWorker(): Promise<FakeHostedWorker> {
  const billing = new Map<string, { tier: 'solo' | 'pro'; email: string }>();
  const vault = new Map<string, Record<string, string>>();
  const sentDigests: RecordedSend[] = [];
  const failingUserIds = new Set<string>();

  function sessionUserId(req: IncomingMessage): string | undefined {
    const token = bearerToken(req);
    return token?.startsWith('svc-session:') ? token.slice('svc-session:'.length) : undefined;
  }

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/admin/session' && req.method === 'POST') {
        if (!requireServiceSecret(req, res)) return;
        const body = (await readJson(req)) as { userId?: unknown };
        if (typeof body.userId !== 'string') return sendJson(res, 400, { error: 'invalid_user_id' });
        // Test-only failure injection: lets one test engineer a genuine
        // per-user failure (e.g. a transient outage minting that one user's
        // session) without a special case anywhere in the digest job itself.
        if (failingUserIds.has(body.userId)) return sendJson(res, 500, { error: 'internal_error' });
        sendJson(res, 200, { token: `svc-session:${body.userId}`, exp: Math.floor(Date.now() / 1000) + 600 });
        return;
      }

      if (url.pathname === '/admin/subscribers' && req.method === 'GET') {
        if (!requireServiceSecret(req, res)) return;
        const subscribers = Array.from(billing.entries()).map(([userId, { tier }]) => ({ userId, tier }));
        sendJson(res, 200, { subscribers });
        return;
      }

      if (url.pathname === '/vault/credentials' && req.method === 'GET') {
        const userId = sessionUserId(req);
        if (!userId) return sendJson(res, 401, { error: 'missing_session' });
        const prefix = `${userId}:`;
        const networks = Array.from(vault.keys())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
        sendJson(res, 200, { networks });
        return;
      }

      const revealMatch = url.pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
      if (revealMatch && req.method === 'GET') {
        const userId = sessionUserId(req);
        if (!userId) return sendJson(res, 401, { error: 'missing_session' });
        const network = decodeURIComponent(revealMatch[1] as string);
        const record = vault.get(`${userId}:${network}`);
        if (!record) return sendJson(res, 404, { error: 'not_found' });
        sendJson(res, 200, { network, credentials: record });
        return;
      }

      if (url.pathname === '/digest/send' && req.method === 'POST') {
        if (!requireServiceSecret(req, res)) return;
        const body = (await readJson(req)) as { userId?: unknown; digestType?: unknown; subject?: unknown; body?: unknown };
        const { userId, digestType, subject } = body;
        const content = body.body;
        if (typeof userId !== 'string' || typeof digestType !== 'string' || typeof subject !== 'string' || typeof content !== 'string') {
          return sendJson(res, 400, { error: 'invalid_content' });
        }
        const record = billing.get(userId);
        if (!record) return sendJson(res, 403, { error: 'entitlement_denied' });
        if (record.tier === 'solo' && digestType !== 'earnings') {
          return sendJson(res, 403, { error: 'entitlement_denied' });
        }
        // Resolve the email HERE, server-side, exactly as hosted/src/routes/digest.ts does — the
        // digest job's own request body carries no email field for this route to read.
        try {
          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to: record.email, subject, text: content }),
          });
          if (!resendRes.ok) return sendJson(res, 502, { error: 'send_failed' });
        } catch {
          return sendJson(res, 502, { error: 'send_failed' });
        }
        sentDigests.push({ userId, digestType, subject, body: content, resolvedEmail: record.email });
        sendJson(res, 200, { ok: true });
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
        billing,
        vault,
        sentDigests,
        failingUserIds,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

let fakeWorker: FakeHostedWorker;
let realFetch: typeof fetch;

beforeEach(async () => {
  _resetBreakers();
  fakeWorker = await startFakeHostedWorker();
  realFetch = globalThis.fetch;
  process.env['HOSTED_AUTH_URL'] = fakeWorker.url;
  process.env['HOSTED_VAULT_URL'] = fakeWorker.url;
  process.env['HOSTED_SERVICE_SECRET'] = SERVICE_SECRET;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await fakeWorker.close();
  delete process.env['HOSTED_AUTH_URL'];
  delete process.env['HOSTED_VAULT_URL'];
  delete process.env['HOSTED_SERVICE_SECRET'];
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

/** Mocks the CJ adapter's own outbound GraphQL call (earnings read) and the fake Worker's own
 * outbound Resend call; every other leg (digest job -> fake Worker's admin/vault/digest routes)
 * is a real loopback HTTP round trip. */
function mockOutboundNetworkCalls(companyId: string): ReturnType<typeof vi.fn> {
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
                  advertiserId: companyId,
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
    if (url.includes('api.resend.com')) {
      return new Response(JSON.stringify({ id: 'em_test' }), { status: 200 });
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('hosted-digest job (H6) end to end', () => {
  it('runs a full cycle for a Pro subscriber: roster -> service session -> vault list -> real adapter read -> compose -> Worker send route hit with composed content, never the email', async () => {
    const userId = 'hosted_usr_e2e_pro';
    fakeWorker.billing.set(userId, { tier: 'pro', email: 'e2e-pro@example.com' });
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 'e2e-token', CJ_COMPANY_ID: '424242' });
    mockOutboundNetworkCalls('424242');

    const summary = await runHostedDigest(loadHostedDigestConfig());

    expect(summary.subscriberCount).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(summary.sends).toEqual([
      { userId, digestType: 'earnings', outcome: 'sent' },
      { userId, digestType: 'unpaid-commissions', outcome: 'sent' },
    ]);

    expect(fakeWorker.sentDigests).toHaveLength(2);
    const earningsSend = fakeWorker.sentDigests.find((s) => s.digestType === 'earnings');
    expect(earningsSend?.body).toContain('42.50');
    expect(earningsSend?.body).toContain('cj');
    // The Worker resolved the email server-side; the job's own response objects never carry it.
    expect(earningsSend?.resolvedEmail).toBe('e2e-pro@example.com');
    expect(JSON.stringify(summary)).not.toContain('e2e-pro@example.com');
  });

  it('a Solo subscriber only ever gets the earnings digest, never unpaid-commissions', async () => {
    const userId = 'hosted_usr_e2e_solo';
    fakeWorker.billing.set(userId, { tier: 'solo', email: 'e2e-solo@example.com' });
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 'e2e-token', CJ_COMPANY_ID: '1' });
    mockOutboundNetworkCalls('1');

    const summary = await runHostedDigest(loadHostedDigestConfig());

    expect(summary.sends).toEqual([{ userId, digestType: 'earnings', outcome: 'sent' }]);
    expect(fakeWorker.sentDigests).toHaveLength(1);
    expect(fakeWorker.sentDigests[0]?.digestType).toBe('earnings');
  });

  it('records a per-user error (a session-minting failure) without aborting the run for the rest of the roster', async () => {
    const okUser = 'hosted_usr_e2e_ok';
    const brokenUser = 'hosted_usr_e2e_broken';
    fakeWorker.billing.set(okUser, { tier: 'solo', email: 'ok@example.com' });
    fakeWorker.billing.set(brokenUser, { tier: 'solo', email: 'broken@example.com' });
    fakeWorker.vault.set(`${okUser}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '1' });
    fakeWorker.failingUserIds.add(brokenUser);
    mockOutboundNetworkCalls('1');

    const summary = await runHostedDigest(loadHostedDigestConfig());

    expect(summary.subscriberCount).toBe(2);
    const okSend = summary.sends.find((s) => s.userId === okUser);
    expect(okSend).toEqual({ userId: okUser, digestType: 'earnings', outcome: 'sent' });
    expect(summary.sends.some((s) => s.userId === brokenUser)).toBe(false);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.userId).toBe(brokenUser);
    expect(summary.errors[0]?.message).toMatch(/HTTP 500/);
  });

  it('never logs or returns the digest body/email anywhere the job\'s own summary is inspected', async () => {
    const userId = 'hosted_usr_e2e_privacy';
    fakeWorker.billing.set(userId, { tier: 'pro', email: 'private@example.com' });
    fakeWorker.vault.set(`${userId}:cj`, { CJ_API_TOKEN: 't', CJ_COMPANY_ID: '9' });
    mockOutboundNetworkCalls('9');

    const summary = await runHostedDigest(loadHostedDigestConfig());
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('private@example.com');
    expect(serialised).not.toContain('42.50'); // no digest body text either, only outcomes
  });
});
