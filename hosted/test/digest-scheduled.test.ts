/**
 * Tests for the Worker-side scheduled digest orchestration (H6, redesigned
 * per Rob's 2026-07-14 decision: `src/digest.ts`). The compose service and
 * Resend are mocked via a spy on `fetch`; KV is an in-memory fake. What
 * these tests pin:
 *
 *   - the roster is enumerated in-process from HOSTED_BILLING (no HTTP);
 *   - the token sent to the compose service is DIGEST-scoped, names the
 *     right userId, and lives at most 15 minutes — verified by verifying
 *     the actual token with the actual signing key;
 *   - the compose request body carries userId and digestType ONLY, never an
 *     email;
 *   - the email is resolved Worker-side and sent via Resend with the
 *     composed subject/body;
 *   - Solo gets earnings only, Pro gets both digest types;
 *   - a lapsed subscriber and an email-less record are skipped with honest
 *     outcomes; a compose failure never sends;
 *   - an unset DIGEST_SERVICE_URL no-ops the whole run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env.js';
import { DIGEST_TOKEN_TTL_SECONDS, runScheduledDigest } from '../src/digest.js';
import { putSubscriptionRecord } from '../src/billing.js';
import { verifySession } from '../src/token.js';

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

const DIGEST_SERVICE_URL = 'https://compose.internal.test';
const COMPOSE_SECRET = 'doorbell-secret';

interface ComposeCall {
  url: string;
  bearer: string | undefined;
  doorbell: string | undefined;
  body: { userId?: string; digestType?: string };
}

interface ResendCall {
  to: string;
  subject: string;
  text: string;
}

/** Mocks the two outbound calls the scheduled handler makes: the compose service and Resend.
 * Everything else (KV, token minting) is real code. */
function mockOutbound(options: { composeStatus?: number } = {}): { composeCalls: ComposeCall[]; resendCalls: ResendCall[] } {
  const composeCalls: ComposeCall[] = [];
  const resendCalls: ResendCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith(DIGEST_SERVICE_URL)) {
      const body = JSON.parse((init?.body as string) ?? '{}') as ComposeCall['body'];
      composeCalls.push({
        url,
        bearer: headers['authorization']?.replace('Bearer ', ''),
        doorbell: headers['x-compose-auth'],
        body,
      });
      if (options.composeStatus && options.composeStatus !== 200) {
        return new Response('boom', { status: options.composeStatus });
      }
      return new Response(
        JSON.stringify({
          subject: `subject for ${body.digestType}`,
          body: `rendered ${body.digestType} digest for ${body.userId}`,
        }),
        { status: 200 },
      );
    }
    if (url.includes('api.resend.com')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as ResendCall;
      resendCalls.push(body);
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }
    throw new Error(`unexpected outbound call in test: ${url}`);
  });
  return { composeCalls, resendCalls };
}

async function makeEnv(): Promise<{ env: Env; billingKv: ReturnType<typeof fakeKV>; signingKey: string }> {
  const billingKv = fakeKV();
  const signingKey = await generatePrivateKeyB64();
  const env: Env = {
    HOSTED_USERS: fakeKV(),
    HOSTED_VAULT: fakeKV(),
    HOSTED_BILLING: billingKv,
    RESEND_API_KEY: 're_test_x',
    SESSION_SIGNING_KEY: signingKey,
    VAULT_MASTER_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PUBLIC_BASE_URL: 'https://hosted.test',
    DIGEST_SERVICE_URL,
    DIGEST_COMPOSE_SECRET: COMPOSE_SECRET,
  };
  return { env, billingKv, signingKey };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runScheduledDigest', () => {
  it('no-ops with a skip reason while DIGEST_SERVICE_URL is unset', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_1', { tier: 'solo', status: 'active', email: 'a@example.com', updatedAt: 0 });
    const { composeCalls, resendCalls } = mockOutbound();

    const summary = await runScheduledDigest({ ...env, DIGEST_SERVICE_URL: undefined });

    expect(summary.skippedReason).toBe('digest_service_not_configured');
    expect(composeCalls).toHaveLength(0);
    expect(resendCalls).toHaveLength(0);
  });

  it('runs a Pro subscriber end to end: digest-scoped short-lived token, userId-only compose body, Worker-side email resolution', async () => {
    const { env, billingKv, signingKey } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_pro', {
      tier: 'pro',
      status: 'active',
      email: 'pro@example.com',
      updatedAt: 0,
    });
    const { composeCalls, resendCalls } = mockOutbound();

    const summary = await runScheduledDigest(env);

    expect(summary.subscriberCount).toBe(1);
    expect(summary.records).toEqual([
      { userId: 'hosted_usr_pro', digestType: 'earnings', outcome: 'sent' },
      { userId: 'hosted_usr_pro', digestType: 'unpaid-commissions', outcome: 'sent' },
    ]);

    // Both digest types were composed; the request body never carries an email.
    expect(composeCalls).toHaveLength(2);
    for (const call of composeCalls) {
      expect(call.url).toBe(`${DIGEST_SERVICE_URL}/compose`);
      expect(call.doorbell).toBe(COMPOSE_SECRET);
      expect(Object.keys(call.body).sort()).toEqual(['digestType', 'userId']);
      expect(call.body.userId).toBe('hosted_usr_pro');
      expect(JSON.stringify(call.body)).not.toContain('pro@example.com');

      // The bearer is a REAL token: verify it with the actual signing key and
      // pin the scope, subject, and TTL ceiling.
      const payload = await verifySession(call.bearer as string, signingKey);
      expect(payload).not.toBeNull();
      expect(payload?.scope).toBe('digest');
      expect(payload?.sub).toBe('hosted_usr_pro');
      expect((payload?.exp as number) - (payload?.iss as number)).toBeLessThanOrEqual(DIGEST_TOKEN_TTL_SECONDS);
      expect(DIGEST_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    }

    // The email was resolved Worker-side and each send carries the composed text.
    expect(resendCalls).toHaveLength(2);
    expect(resendCalls[0]?.to).toBe('pro@example.com');
    expect(resendCalls[0]?.subject).toBe('subject for earnings');
    expect(resendCalls[0]?.text).toContain('rendered earnings digest');
    expect(resendCalls[1]?.subject).toBe('subject for unpaid-commissions');
  });

  it('a Solo subscriber gets the earnings digest only', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_solo', {
      tier: 'solo',
      status: 'active',
      email: 'solo@example.com',
      updatedAt: 0,
    });
    const { composeCalls, resendCalls } = mockOutbound();

    const summary = await runScheduledDigest(env);

    expect(summary.records).toEqual([{ userId: 'hosted_usr_solo', digestType: 'earnings', outcome: 'sent' }]);
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.body.digestType).toBe('earnings');
    expect(resendCalls).toHaveLength(1);
  });

  it('re-checks the record at send time: a subscription that lapses after the roster snapshot is denied, not emailed', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_lapsed', {
      tier: 'solo',
      status: 'active',
      email: 'lapsed@example.com',
      updatedAt: 0,
    });
    const { composeCalls, resendCalls } = mockOutbound();

    // The roster read is `kv.list` + `kv.get`; the send-time re-check is a
    // second `kv.get` for the same key. Serve "active" on the first get (the
    // roster) and "canceled" from then on (the re-check) — exactly the
    // mid-run lapse the re-read exists to catch.
    const activeRaw = billingKv.store.get('sub:hosted_usr_lapsed') as string;
    const canceledRaw = activeRaw.replace('"active"', '"canceled"');
    let gets = 0;
    const realGet = billingKv.get.bind(billingKv);
    billingKv.get = (async (key: string) => {
      if (key === 'sub:hosted_usr_lapsed') {
        gets += 1;
        return gets === 1 ? activeRaw : canceledRaw;
      }
      return realGet(key);
    }) as typeof billingKv.get;

    const summary = await runScheduledDigest(env);

    expect(summary.subscriberCount).toBe(1); // made the roster while active
    expect(summary.records).toEqual([{ userId: 'hosted_usr_lapsed', digestType: 'earnings', outcome: 'denied' }]);
    expect(composeCalls).toHaveLength(0);
    expect(resendCalls).toHaveLength(0);
  });

  it('records no_email for a manually-granted tier with no billing email, and never calls compose for it', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_noemail', { tier: 'solo', status: 'active', updatedAt: 0 });
    const { composeCalls, resendCalls } = mockOutbound();

    const summary = await runScheduledDigest(env);

    expect(summary.records).toEqual([{ userId: 'hosted_usr_noemail', digestType: 'earnings', outcome: 'no_email' }]);
    expect(composeCalls).toHaveLength(0);
    expect(resendCalls).toHaveLength(0);
  });

  it('records compose_failed and sends nothing when the compose service errors', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_composefail', {
      tier: 'solo',
      status: 'active',
      email: 'cf@example.com',
      updatedAt: 0,
    });
    const { resendCalls } = mockOutbound({ composeStatus: 500 });

    const summary = await runScheduledDigest(env);

    expect(summary.records).toEqual([
      { userId: 'hosted_usr_composefail', digestType: 'earnings', outcome: 'compose_failed' },
    ]);
    expect(resendCalls).toHaveLength(0);
  });

  it('one subscriber\'s failure never blocks the next subscriber', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_a_noemail', { tier: 'solo', status: 'active', updatedAt: 0 });
    await putSubscriptionRecord(billingKv, 'hosted_usr_b_ok', {
      tier: 'solo',
      status: 'active',
      email: 'b@example.com',
      updatedAt: 0,
    });
    const { resendCalls } = mockOutbound();

    const summary = await runScheduledDigest(env);

    expect(summary.subscriberCount).toBe(2);
    expect(summary.records).toEqual([
      { userId: 'hosted_usr_a_noemail', digestType: 'earnings', outcome: 'no_email' },
      { userId: 'hosted_usr_b_ok', digestType: 'earnings', outcome: 'sent' },
    ]);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]?.to).toBe('b@example.com');
  });

  it('the run summary itself never contains an email address or digest text', async () => {
    const { env, billingKv } = await makeEnv();
    await putSubscriptionRecord(billingKv, 'hosted_usr_priv', {
      tier: 'pro',
      status: 'active',
      email: 'private@example.com',
      updatedAt: 0,
    });
    mockOutbound();

    const summary = await runScheduledDigest(env);

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('private@example.com');
    expect(serialised).not.toContain('rendered');
    expect(serialised).not.toContain('subject for');
  });
});
