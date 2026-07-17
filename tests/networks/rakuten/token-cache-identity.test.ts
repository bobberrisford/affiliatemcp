/**
 * Rakuten OAuth token cache — identity keying (hosted workstream H1).
 *
 * `src/networks/rakuten/auth.ts` is the only production-network auth module
 * (among awin/cj/impact/rakuten) that caches a token in module state. This
 * suite covers the identity-keying introduced for the hosted seam:
 *   - the local path (no request context) behaves exactly as the old
 *     single-entry cache did — one identity, one token exchange, reused;
 *   - two distinct identities never share a cached token, and each triggers
 *     its own exchange;
 *   - concurrent refreshes for two different identities do not deduplicate
 *     against each other (only same-identity concurrency dedupes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { _resetTokenCache, getAccessToken } from '../../../src/networks/rakuten/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { runInRequestContext } from '../../../src/shared/request-context.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'rakuten');

function tokenResponse(): Response {
  const body = readFileSync(path.join(FIXTURES, 'token-response.json'), 'utf8');
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockFetchQueue(): { spy: ReturnType<typeof vi.fn>; queue: Response[] } {
  const queue: Response[] = [];
  const spy = vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, queue };
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['RAKUTEN_CLIENT_ID'] = 'test-client-id';
  process.env['RAKUTEN_CLIENT_SECRET'] = 'test-client-secret';
  process.env['RAKUTEN_SID'] = '4567890';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['RAKUTEN_CLIENT_ID'];
  delete process.env['RAKUTEN_CLIENT_SECRET'];
  delete process.env['RAKUTEN_SID'];
});

describe('Rakuten token cache — identity keying', () => {
  it('outside any request context, repeated calls reuse a single cached token (local-path parity)', async () => {
    const { spy, queue } = mockFetchQueue();
    queue.push(tokenResponse());

    const first = await getAccessToken();
    const second = await getAccessToken();

    expect(first).toBe('fake-rakuten-access-token-AAA111');
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1); // one token exchange, second call hit the cache
  });

  it('two distinct request identities each get their own cached token', async () => {
    const { spy, queue } = mockFetchQueue();
    queue.push(tokenResponse(), tokenResponse());

    const tokenA = await runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken());
    const tokenB = await runInRequestContext({ identity: 'tenant-b' }, () => getAccessToken());

    expect(tokenA).toBe('fake-rakuten-access-token-AAA111');
    expect(tokenB).toBe('fake-rakuten-access-token-AAA111');
    // Two identities → two exchanges, even though the fixture token is identical.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-entering the same identity reuses that identity\'s cached token without a new exchange', async () => {
    const { spy, queue } = mockFetchQueue();
    queue.push(tokenResponse());

    await runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken());
    await runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken());

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a cache reset clears every identity, not just the active one', async () => {
    const { spy, queue } = mockFetchQueue();
    queue.push(tokenResponse(), tokenResponse());

    await runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken());
    _resetTokenCache();
    await runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken());

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('concurrent refreshes for different identities do not dedupe against each other', async () => {
    const { spy, queue } = mockFetchQueue();
    queue.push(tokenResponse(), tokenResponse());

    const [tokenA, tokenB] = await Promise.all([
      runInRequestContext({ identity: 'tenant-a' }, () => getAccessToken()),
      runInRequestContext({ identity: 'tenant-b' }, () => getAccessToken()),
    ]);

    expect(tokenA).toBe('fake-rakuten-access-token-AAA111');
    expect(tokenB).toBe('fake-rakuten-access-token-AAA111');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
