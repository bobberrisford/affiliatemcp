/**
 * Awin advertiser HTTP client tests.
 *
 * Two safety-critical concerns are exercised:
 *   1. The read-only guard refuses any non-GET method BEFORE any wire I/O.
 *   2. The token-bucket rate limiter enforces 20 requests per 60 seconds and
 *      queues the 21st call rather than failing fast. We use fake timers to
 *      observe the queueing without burning wall-clock time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRateLimitSlot,
  awinAdvRequest,
  AWIN_RATE_LIMIT_REQUESTS,
  AWIN_RATE_LIMIT_WINDOW_MS,
  buildUrl,
  _rateLimiterBucketSize,
  _resetRateLimiter,
} from '../../../src/networks/awin-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';

beforeEach(() => {
  _resetBreakers();
  _resetRateLimiter();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetRateLimiter();
});

// ---------------------------------------------------------------------------
// buildUrl — the /advertisers/{id}/... path shape is high-risk
// ---------------------------------------------------------------------------

describe('buildUrl', () => {
  it('joins a path under https://api.awin.com', () => {
    expect(buildUrl('/accounts')).toBe('https://api.awin.com/accounts');
  });

  it('encodes query params and skips undefined', () => {
    const url = buildUrl('/advertisers/123/transactions/', {
      startDate: '2026-05-01T00:00:00Z',
      endDate: '2026-05-31T23:59:59Z',
      dateType: 'transaction',
      status: undefined,
    });
    expect(url).toContain('/advertisers/123/transactions/');
    expect(url).toContain('startDate=2026-05-01T00%3A00%3A00Z');
    expect(url).not.toContain('status=');
  });

  it('inserts a leading slash if missing', () => {
    expect(buildUrl('accounts')).toBe('https://api.awin.com/accounts');
  });
});

// ---------------------------------------------------------------------------
// Read-only guard — the single most important safety property
// ---------------------------------------------------------------------------

describe('awin-advertiser read-only guard', () => {
  it('refuses non-GET methods with a config_error envelope and NO network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      awinAdvRequest({
        operation: 'verifyAuth',
        path: '/accounts',
        token: 'tok',
        method: 'POST' as 'GET',
        resilience: DEFAULT_RESILIENCE,
      }),
    ).rejects.toBeInstanceOf(NetworkError);

    // The critical assertion: fetch must NEVER have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces the refusal envelope with type=config_error and a "read-only" message', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    try {
      await awinAdvRequest({
        operation: 'listTransactions',
        path: '/advertisers/1/transactions/',
        token: 'tok',
        method: 'PUT' as 'GET',
        resilience: DEFAULT_RESILIENCE,
      });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('config_error');
      expect(e.envelope.message.toLowerCase()).toContain('read-only');
      expect(e.envelope.message).toContain('PUT');
    }
  });

  it('allows GET (sanity check)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const r = await awinAdvRequest<unknown[]>({
      operation: 'verifyAuth',
      path: '/accounts',
      token: 'tok',
      resilience: DEFAULT_RESILIENCE,
    });
    expect(Array.isArray(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter — token bucket
// ---------------------------------------------------------------------------

describe('awin-advertiser rate limiter', () => {
  it('admits up to the budget without queueing', async () => {
    // 20 acquires at the same simulated `now()` must all succeed without
    // ever asking for a sleep — the bucket is exactly at capacity.
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const now = () => 1_000_000;

    for (let i = 0; i < AWIN_RATE_LIMIT_REQUESTS; i++) {
      await acquireRateLimitSlot('tok-A', { now, sleep });
    }
    expect(sleeps).toHaveLength(0);
    expect(_rateLimiterBucketSize('tok-A')).toBe(AWIN_RATE_LIMIT_REQUESTS);
  });

  it('queues the (N+1)th call until the oldest slot falls out of the window', async () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const sleep = vi.fn(async (ms: number) => {
      // Advance simulated time when "sleeping".
      currentTime += ms;
    });

    // Burn the budget at t=1_000_000.
    for (let i = 0; i < AWIN_RATE_LIMIT_REQUESTS; i++) {
      await acquireRateLimitSlot('tok-B', { now, sleep });
    }
    expect(sleep).not.toHaveBeenCalled();

    // The 21st call must queue. The oldest entry is at t=1_000_000, the
    // window is 60_000ms, so the wait should be exactly 60_000ms (+epsilon).
    await acquireRateLimitSlot('tok-B', { now, sleep });
    expect(sleep).toHaveBeenCalled();
    const waited = (sleep.mock.calls[0]?.[0] ?? 0) as number;
    // Allow a small fudge for the +1ms minimum inside acquireRateLimitSlot.
    expect(waited).toBeGreaterThanOrEqual(AWIN_RATE_LIMIT_WINDOW_MS);
    expect(waited).toBeLessThanOrEqual(AWIN_RATE_LIMIT_WINDOW_MS + 5);
  });

  it('keeps buckets separate per token', async () => {
    const sleeps: number[] = [];
    const now = () => 1_000_000;
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });

    // Burn the budget on token A entirely.
    for (let i = 0; i < AWIN_RATE_LIMIT_REQUESTS; i++) {
      await acquireRateLimitSlot('tok-X', { now, sleep });
    }
    // Token B must still have its full budget.
    await acquireRateLimitSlot('tok-Y', { now, sleep });
    expect(sleeps).toHaveLength(0);
    expect(_rateLimiterBucketSize('tok-X')).toBe(AWIN_RATE_LIMIT_REQUESTS);
    expect(_rateLimiterBucketSize('tok-Y')).toBe(1);
  });

  it('prunes entries older than the window so a long-quiet token has a fresh budget', async () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const sleep = vi.fn(async (ms: number) => {
      currentTime += ms;
    });

    // Burn the budget.
    for (let i = 0; i < AWIN_RATE_LIMIT_REQUESTS; i++) {
      await acquireRateLimitSlot('tok-prune', { now, sleep });
    }
    // Jump well past the window.
    currentTime += AWIN_RATE_LIMIT_WINDOW_MS * 2;
    // Next acquire should NOT queue — all previous entries have fallen out.
    await acquireRateLimitSlot('tok-prune', { now, sleep });
    expect(sleep).not.toHaveBeenCalled();
    // Bucket size reflects only the most recent acquire.
    expect(_rateLimiterBucketSize('tok-prune')).toBe(1);
  });

  it('integrates with awinAdvRequest: the bucket is consumed per network call', async () => {
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    // Three GETs against the same token should consume three slots.
    for (let i = 0; i < 3; i++) {
      await awinAdvRequest<unknown[]>({
        operation: 'verifyAuth',
        path: '/accounts',
        token: 'integration-tok',
        resilience: DEFAULT_RESILIENCE,
      });
    }
    expect(fetchCalls).toBe(3);
    expect(_rateLimiterBucketSize('integration-tok')).toBe(3);
  });
});
