/**
 * Unit tests for the H6 entitlement client
 * (`src/hosted-transport/entitlement-client.ts`), mirroring the existing
 * `vault-client.ts`/`session-auth.ts` test style: `fetch` mocked, no live
 * network calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHostedEntitlement, HostedEntitlementUnavailableError } from '../../src/hosted-transport/entitlement-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchHostedEntitlement', () => {
  it('returns the entitlement on a clean 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tier: 'pro', status: 'active' }), { status: 200 }),
    );
    const entitlement = await fetchHostedEntitlement('amcps_test', 'https://hosted.test');
    expect(entitlement).toEqual({ tier: 'pro', status: 'active' });
  });

  it('sends the caller\'s own bearer token, never a service credential', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ tier: 'solo', status: 'active' }), { status: 200 }));
    await fetchHostedEntitlement('amcps_the_callers_own_token', 'https://hosted.test');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hosted.test/billing/entitlement');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer amcps_the_callers_own_token');
  });

  it('throws HostedEntitlementUnavailableError on a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchHostedEntitlement('t', 'https://hosted.test')).rejects.toThrow(HostedEntitlementUnavailableError);
  });

  it('throws HostedEntitlementUnavailableError on a 401 (never silently treats it as tier none)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'invalid' }), { status: 401 }));
    await expect(fetchHostedEntitlement('t', 'https://hosted.test')).rejects.toThrow(HostedEntitlementUnavailableError);
  });

  it('throws HostedEntitlementUnavailableError on an unexpected non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(fetchHostedEntitlement('t', 'https://hosted.test')).rejects.toThrow(HostedEntitlementUnavailableError);
  });

  it('throws HostedEntitlementUnavailableError on a malformed body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ tier: 'ultra' }), { status: 200 }));
    await expect(fetchHostedEntitlement('t', 'https://hosted.test')).rejects.toThrow(HostedEntitlementUnavailableError);
  });
});
