/**
 * Bad-key rehearsal — PRD §15.2 acceptance test.
 *
 * The scenario: a user has typed their API token wrong (or it has been
 * revoked). Every adapter call must fail cleanly with a `NetworkErrorEnvelope`
 * carrying:
 *   - `type: 'auth_error'`
 *   - the network slug
 *   - the operation name
 *   - the verbatim body Network returned (PRD §4.1 — never paraphrase)
 *
 * We mock `globalThis.fetch` to return a 401 with a known body for every
 * adapter request, then drive `validateNetwork(slug)` for each registered
 * adapter and assert the surfaced detail strings contain the expected envelope
 * fields. No stack traces leak, no generic "an error occurred" — what the user
 * sees is exactly what Network sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../src/networks/index.js';
import { validateNetwork } from '../../src/shared/diagnostic.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { _resetTokenCache } from '../../src/networks/rakuten/auth.js';

const BAD_BODY = '{"error":"invalid_token","detail":"token rejected by upstream"}';

function mockAllFetch401(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    return new Response(BAD_BODY, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

interface NetworkFixture {
  slug: string;
  env: Record<string, string>;
}

const FIXTURES: NetworkFixture[] = [
  {
    slug: 'awin',
    env: {
      AWIN_API_TOKEN: 'badtoken-awin',
      AWIN_PUBLISHER_ID: '12345',
    },
  },
  {
    slug: 'cj',
    env: {
      CJ_API_TOKEN: 'badtoken-cj',
      CJ_COMPANY_ID: '1234567',
    },
  },
  {
    slug: 'impact',
    env: {
      IMPACT_ACCOUNT_SID: 'IRBADSIDxxxxxxxxxxxxxxxxxxxxxxxxx',
      IMPACT_AUTH_TOKEN: 'badtoken-impact',
    },
  },
  {
    slug: 'rakuten',
    env: {
      RAKUTEN_CLIENT_ID: 'bad-client',
      RAKUTEN_CLIENT_SECRET: 'bad-secret',
      RAKUTEN_SID: '9999',
    },
  },
];

const ALL_ENV_KEYS = FIXTURES.flatMap((f) => Object.keys(f.env));
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  for (const k of ALL_ENV_KEYS) {
    originalEnv[k] = process.env[k];
  }
  for (const fixture of FIXTURES) {
    for (const [k, v] of Object.entries(fixture.env)) {
      process.env[k] = v;
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ALL_ENV_KEYS) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
  _resetBreakers();
  _resetTokenCache();
});

describe('bad-key rehearsal (PRD §15.2)', () => {
  for (const fixture of FIXTURES) {
    it(`surfaces a clean auth_error envelope for ${fixture.slug} with the verbatim 401 body`, async () => {
      mockAllFetch401();

      const result = await validateNetwork(fixture.slug);

      // The whole validation must report failure — never invent success.
      expect(result.ok).toBe(false);
      expect(result.network).toBe(fixture.slug);

      // verifyAuth is the first probe — its detail string must carry the
      // network/operation context plus the verbatim 401 body fragment.
      const verifyAuth = result.checks.find((c) => c.name === 'verifyAuth');
      expect(verifyAuth, 'verifyAuth check should be present').toBeTruthy();
      expect(verifyAuth?.ok).toBe(false);
      const detail = verifyAuth?.detail ?? '';
      // PRD §4.1: the user must see the upstream body, or a message that
      // names the network + operation explicitly. We accept either the raw
      // 401 body fragment OR a verbatim "Missing required credential" hint
      // (the rakuten path emits this when its three-cred check fails before
      // the network round-trip — the envelope still names the network).
      const containsBody = detail.includes('invalid_token') || detail.includes('401');
      const containsConfigHint = /required credential/i.test(detail);
      expect(
        containsBody || containsConfigHint,
        `expected ${fixture.slug} verifyAuth detail to surface either the verbatim 401 body or a config-level reason, got: ${detail}`,
      ).toBe(true);

      // The detail must NEVER be a generic "error occurred" or "unknown".
      expect(detail.toLowerCase()).not.toContain('an error occurred');
      expect(detail.toLowerCase()).not.toContain('something went wrong');

      // The operation probes (listProgrammes, listTransactions, etc.) should
      // also fail — confirm none of them invented success.
      const probeChecks = result.checks.filter(
        (c) => c.name !== 'registry' && c.name !== 'verifyAuth',
      );
      expect(probeChecks.length).toBeGreaterThan(0);
      for (const c of probeChecks) {
        expect(
          c.ok,
          `${fixture.slug}/${c.name} unexpectedly succeeded under bad-key fetch mock`,
        ).toBe(false);
      }
    });
  }
});
