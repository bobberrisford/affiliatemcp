/**
 * Unit tests for the free-tier meter client
 * (`src/hosted-transport/meter-client.ts`), mirroring the
 * `entitlement-client.ts` test style: `fetch` mocked, no live network calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeFreeWindow, MeterUnavailableError } from '../../src/hosted-transport/meter-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consumeFreeWindow', () => {
  it('returns the decision on a clean 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, remaining: 2, resetAt: 123 }), { status: 200 }),
    );
    const decision = await consumeFreeWindow('amcps_test', 'https://hosted.test');
    expect(decision).toEqual({ allowed: true, remaining: 2, resetAt: 123 });
  });

  it('accepts a null resetAt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, remaining: 3, resetAt: null }), { status: 200 }),
    );
    const decision = await consumeFreeWindow('t', 'https://hosted.test');
    expect(decision.resetAt).toBeNull();
  });

  it('POSTs to /billing/meter with the caller\'s own bearer token', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ allowed: false, remaining: 0, resetAt: 1 }), { status: 200 }));
    await consumeFreeWindow('amcps_the_callers_own_token', 'https://hosted.test');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hosted.test/billing/meter');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer amcps_the_callers_own_token');
  });

  it('throws MeterUnavailableError on a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(consumeFreeWindow('t', 'https://hosted.test')).rejects.toThrow(MeterUnavailableError);
  });

  it('throws MeterUnavailableError on a 401 (never silently treats it as out of free reports)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'invalid' }), { status: 401 }));
    await expect(consumeFreeWindow('t', 'https://hosted.test')).rejects.toThrow(MeterUnavailableError);
  });

  it('throws MeterUnavailableError on an unexpected non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(consumeFreeWindow('t', 'https://hosted.test')).rejects.toThrow(MeterUnavailableError);
  });

  it('throws MeterUnavailableError on a malformed body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ allowed: 'yes' }), { status: 200 }),
    );
    await expect(consumeFreeWindow('t', 'https://hosted.test')).rejects.toThrow(MeterUnavailableError);
  });
});
