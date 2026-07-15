/**
 * Unit tests for `verifySessionRemote` — the transport-side check the hosted
 * MCP endpoint runs on every request (`src/hosted-transport/session-auth.ts`).
 *
 * Focus: the staged OAuth bearer migration
 * (`docs/decisions/2026-07-15-hosted-connector-oauth.md`). An OAuth access
 * token and a legacy pasted bearer are the same `amcps_` wire format and
 * differ only in lifetime, so this suite proves the lifetime cap
 * (`maxLifetimeSeconds`) is what drops long-lived bearers while keeping
 * short-lived OAuth access tokens — and that with no cap set, both are
 * accepted (the dual-accept window). The hosted Worker's own
 * `/auth/session/verify` behaviour is covered by `hosted/test/worker.test.ts`
 * and `hosted/test/scope.test.ts`; here the verify endpoint is a mocked
 * `fetch` so the transport-side decision can be exercised in isolation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HostedAuthUnavailableError,
  verifySessionRemote,
} from '../../src/hosted-transport/session-auth.js';

const AUTH_URL = 'https://hosted.test';
const DAY = 24 * 60 * 60;

interface VerifyBody {
  userId?: unknown;
  exp?: unknown;
  iss?: unknown;
  scope?: unknown;
}

/** Mock global fetch so `/auth/session/verify` returns `body` with `status`. */
function mockVerify(body: VerifyBody, status = 200): void {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifySessionRemote — verify response shape', () => {
  it('returns { userId, exp, iss } when the verify body carries iss', async () => {
    const iss = 1_000_000;
    const exp = iss + 3600;
    mockVerify({ userId: 'hosted_usr_a', exp, iss, scope: 'full' });

    const result = await verifySessionRemote('amcps_tok', AUTH_URL);

    expect(result).toEqual({ userId: 'hosted_usr_a', exp, iss });
  });

  it('returns null when the Worker rejects the token with a 401', async () => {
    mockVerify({ error: 'invalid_token' } as VerifyBody, 401);
    expect(await verifySessionRemote('amcps_bad', AUTH_URL)).toBeNull();
  });
});

describe('verifySessionRemote — dual-accept window (no cap configured)', () => {
  it('accepts a long-lived (30-day) bearer when maxLifetimeSeconds is unset', async () => {
    const iss = 2_000_000;
    const exp = iss + 30 * DAY;
    mockVerify({ userId: 'hosted_usr_legacy', exp, iss, scope: 'full' });

    const result = await verifySessionRemote('amcps_legacy', AUTH_URL);

    // No cap → the legacy bearer is still accepted (nothing already connected
    // breaks during the deprecation window).
    expect(result).toEqual({ userId: 'hosted_usr_legacy', exp, iss });
  });
});

describe('verifySessionRemote — lifetime cap enforced (maxLifetimeSeconds set)', () => {
  const CAP = 7200; // comfortably above the 1h OAuth TTL, far below the 30-day bearer

  it('accepts a short-lived (1h) OAuth access token', async () => {
    const iss = 3_000_000;
    const exp = iss + 3600;
    mockVerify({ userId: 'hosted_usr_oauth', exp, iss, scope: 'full' });

    const result = await verifySessionRemote('amcps_oauth', AUTH_URL, { maxLifetimeSeconds: CAP });

    expect(result).toEqual({ userId: 'hosted_usr_oauth', exp, iss });
  });

  it('rejects a long-lived (30-day) pasted bearer', async () => {
    const iss = 4_000_000;
    const exp = iss + 30 * DAY;
    mockVerify({ userId: 'hosted_usr_legacy', exp, iss, scope: 'full' });

    const result = await verifySessionRemote('amcps_legacy', AUTH_URL, { maxLifetimeSeconds: CAP });

    expect(result).toBeNull();
  });

  it('fails closed (rejects) when iss is absent from the verify body', async () => {
    const iss = 5_000_000;
    const exp = iss + 3600; // lifetime would be within the cap IF iss were known
    mockVerify({ userId: 'hosted_usr_no_iss', exp, scope: 'full' });

    const result = await verifySessionRemote('amcps_no_iss', AUTH_URL, { maxLifetimeSeconds: CAP });

    // Lifetime cannot be computed without iss, so it cannot be shown to be
    // within bounds → reject.
    expect(result).toBeNull();
  });

  it('fails closed (rejects) when iss is present but not a number', async () => {
    const iss = 6_000_000;
    mockVerify({ userId: 'hosted_usr_bad_iss', exp: iss + 3600, iss: 'not-a-number', scope: 'full' });

    const result = await verifySessionRemote('amcps_bad_iss', AUTH_URL, { maxLifetimeSeconds: CAP });

    expect(result).toBeNull();
  });
});

describe('verifySessionRemote — invariants preserved regardless of cap', () => {
  it('refuses a digest-scoped token when no cap is set', async () => {
    const iss = 7_000_000;
    mockVerify({ userId: 'hosted_usr_digest', exp: iss + 900, iss, scope: 'digest' });

    expect(await verifySessionRemote('amcps_digest', AUTH_URL)).toBeNull();
  });

  it('refuses a digest-scoped token even when its lifetime is within the cap', async () => {
    const iss = 8_000_000;
    mockVerify({ userId: 'hosted_usr_digest', exp: iss + 900, iss, scope: 'digest' });

    expect(
      await verifySessionRemote('amcps_digest', AUTH_URL, { maxLifetimeSeconds: 7200 }),
    ).toBeNull();
  });

  it('throws HostedAuthUnavailableError on a non-ok, non-401 verify response', async () => {
    mockVerify({ error: 'internal_error' } as VerifyBody, 500);

    await expect(verifySessionRemote('amcps_tok', AUTH_URL, { maxLifetimeSeconds: 7200 })).rejects.toBeInstanceOf(
      HostedAuthUnavailableError,
    );
  });
});
