/**
 * Unit tests for the hosted-digest job's service-authenticated client
 * (`src/hosted-digest/service-client.ts`). `fetch` mocked, no live network
 * calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HostedDigestServiceError,
  issueServiceSession,
  listSubscribers,
  sendDigest,
} from '../../src/hosted-digest/service-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listSubscribers', () => {
  it('sends the service secret as a bearer token and returns the roster', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ subscribers: [{ userId: 'u1', tier: 'solo' }] }), { status: 200 }));

    const subscribers = await listSubscribers('https://hosted.test', 'my-service-secret');

    expect(subscribers).toEqual([{ userId: 'u1', tier: 'solo' }]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hosted.test/admin/subscribers');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer my-service-secret');
  });

  it('throws HostedDigestServiceError on a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(listSubscribers('https://hosted.test', 'x')).rejects.toThrow(HostedDigestServiceError);
  });

  it('throws HostedDigestServiceError on a malformed body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ oops: true }), { status: 200 }));
    await expect(listSubscribers('https://hosted.test', 'x')).rejects.toThrow(HostedDigestServiceError);
  });

  it('throws HostedDigestServiceError on a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(listSubscribers('https://hosted.test', 'x')).rejects.toThrow(HostedDigestServiceError);
  });
});

describe('issueServiceSession', () => {
  it('posts the userId and returns the minted token', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'amcps_minted', exp: 123 }), { status: 200 }));

    const token = await issueServiceSession('https://hosted.test', 'secret', 'hosted_usr_1');

    expect(token).toBe('amcps_minted');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hosted.test/admin/session');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'hosted_usr_1' });
  });

  it('throws on a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(issueServiceSession('https://hosted.test', 'secret', 'u1')).rejects.toThrow(HostedDigestServiceError);
  });
});

describe('sendDigest', () => {
  it('maps 200 to "sent"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const outcome = await sendDigest('https://hosted.test', 'secret', {
      userId: 'u1',
      digestType: 'earnings',
      subject: 's',
      body: 'b',
    });
    expect(outcome).toBe('sent');
  });

  it('maps 403 to "denied"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'entitlement_denied' }), { status: 403 }));
    const outcome = await sendDigest('https://hosted.test', 'secret', {
      userId: 'u1',
      digestType: 'unpaid-commissions',
      subject: 's',
      body: 'b',
    });
    expect(outcome).toBe('denied');
  });

  it('maps 422 to "no_email"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'no_billing_email_on_file' }), { status: 422 }));
    const outcome = await sendDigest('https://hosted.test', 'secret', {
      userId: 'u1',
      digestType: 'earnings',
      subject: 's',
      body: 'b',
    });
    expect(outcome).toBe('no_email');
  });

  it('maps any other non-2xx to "failed"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 502 }));
    const outcome = await sendDigest('https://hosted.test', 'secret', {
      userId: 'u1',
      digestType: 'earnings',
      subject: 's',
      body: 'b',
    });
    expect(outcome).toBe('failed');
  });

  it('sends userId, digestType, subject, and body only — never an email field', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendDigest('https://hosted.test', 'secret', { userId: 'u1', digestType: 'earnings', subject: 's', body: 'b' });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(Object.keys(sentBody).sort()).toEqual(['body', 'digestType', 'subject', 'userId']);
  });
});
