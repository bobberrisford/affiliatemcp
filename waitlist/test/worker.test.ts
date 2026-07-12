/**
 * Worker route tests for the waitlist Worker. Resend is mocked via a spy on
 * global fetch — no live network calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import type { Env } from '../src/env.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RESEND_API_KEY: 're_test_x',
    RESEND_AUDIENCE_ID: 'aud_test_x',
    SITE_ORIGIN: 'https://agenticaffiliate.ai',
    ...overrides,
  };
}

const post = (path: string, body?: unknown) =>
  new Request(`https://waitlist.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function mockResendResponse(status: number, body: unknown = {}): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('health', () => {
  it('GET /health responds 200', async () => {
    const res = await worker.fetch(new Request('https://waitlist.test/health'), makeEnv());
    expect(res.status).toBe(200);
  });

  it('GET / also responds 200', async () => {
    const res = await worker.fetch(new Request('https://waitlist.test/'), makeEnv());
    expect(res.status).toBe(200);
  });

  it('unknown routes are a 404', async () => {
    const res = await worker.fetch(new Request('https://waitlist.test/nope'), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('OPTIONS preflight from the configured site origin reflects it back', async () => {
    const req = new Request('https://waitlist.test/waitlist', {
      method: 'OPTIONS',
      headers: { origin: 'https://agenticaffiliate.ai' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://agenticaffiliate.ai');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('does not set access-control-allow-origin for a disallowed origin', async () => {
    const req = new Request('https://waitlist.test/waitlist', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('omits access-control-allow-origin when no Origin header is sent', async () => {
    const req = new Request('https://waitlist.test/waitlist', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /waitlist validation', () => {
  it('rejects a missing email with a structured 400', async () => {
    const res = await worker.fetch(post('/waitlist', { side: 'publisher' }), makeEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('invalid_email');
  });

  it('rejects a malformed email with a structured 400', async () => {
    const res = await worker.fetch(post('/waitlist', { email: 'not-an-email' }), makeEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_email');
  });

  it('rejects an invalid side value', async () => {
    const res = await worker.fetch(post('/waitlist', { email: 'a@example.com', side: 'reseller' }), makeEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_side');
  });

  it('rejects an oversized networks string', async () => {
    const res = await worker.fetch(
      post('/waitlist', { email: 'a@example.com', networks: 'x'.repeat(501) }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_networks');
  });

  it('rejects a malformed JSON body', async () => {
    const req = new Request('https://waitlist.test/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('rejects a missing body', async () => {
    const req = new Request('https://waitlist.test/waitlist', { method: 'POST' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });
});

describe('POST /waitlist success path', () => {
  it('adds a valid submission to the Resend audience with an email-only payload', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'ctn_1' }), { status: 200 }));

    const res = await worker.fetch(
      post('/waitlist', { email: 'person@example.com', networks: 'Awin, CJ', side: 'publisher' }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.resend.com/audiences/aud_test_x/contacts');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer re_test_x');
    // The Resend payload is email-only: networks/side are accepted from the
    // form but deliberately not forwarded (see src/index.ts header comment).
    expect(JSON.parse(init.body as string)).toEqual({ email: 'person@example.com' });
  });

  it('maps a Resend duplicate-contact conflict (409) to a success response', async () => {
    mockResendResponse(409, { message: 'Contact already exists' });
    const res = await worker.fetch(post('/waitlist', { email: 'person@example.com' }), makeEnv());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('sets the allowed CORS origin on a successful response', async () => {
    mockResendResponse(200, { id: 'ctn_1' });
    const req = new Request('https://waitlist.test/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://agenticaffiliate.ai' },
      body: JSON.stringify({ email: 'person@example.com' }),
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('access-control-allow-origin')).toBe('https://agenticaffiliate.ai');
  });
});

describe('POST /waitlist upstream failure', () => {
  it('surfaces a genuine Resend failure as a 502 without leaking upstream detail', async () => {
    mockResendResponse(401, { message: 'invalid api key' });
    const res = await worker.fetch(post('/waitlist', { email: 'person@example.com' }), makeEnv());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('waitlist_failed');
  });

  it('returns 502 when the Resend request itself throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await worker.fetch(post('/waitlist', { email: 'person@example.com' }), makeEnv());
    expect(res.status).toBe(502);
  });

  it('never logs the submitted email address, on success or failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockResendResponse(500, { message: 'server error' });
    await worker.fetch(post('/waitlist', { email: 'secret-person@example.com' }), makeEnv());

    for (const call of errorSpy.mock.calls) {
      const line = call.join(' ');
      expect(line).not.toContain('secret-person@example.com');
    }
  });
});
