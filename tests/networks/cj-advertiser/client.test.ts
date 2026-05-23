/**
 * CJ advertiser HTTP client — read-only guard tests.
 *
 * The most safety-critical piece of this adapter. The brand surface is much
 * more sensitive than the publisher surface; an accidental mutation could
 * move money. We assert defence-in-depth:
 *   1. `mutation` operations are rejected BEFORE any network call.
 *   2. `subscription` operations are similarly rejected.
 *   3. Mutation keywords disguised inside string literals or comments do NOT
 *      trip the guard (otherwise a downstream contributor would mask real
 *      writes by quoting them).
 *   4. `query` operations pass (sanity check).
 *   5. Empty / malformed documents are rejected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertReadOnlyQuery,
  cjAdvGraphQL,
  CJ_ADVERTISER_GRAPHQL,
} from '../../../src/networks/cj-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';

beforeEach(() => {
  _resetBreakers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertReadOnlyQuery', () => {
  it('accepts a named query', () => {
    expect(() =>
      assertReadOnlyQuery('query Foo { commissionDetails { count } }', 'verifyAuth'),
    ).not.toThrow();
  });

  it('accepts an anonymous query (shorthand `{ ... }`)', () => {
    expect(() => assertReadOnlyQuery('{ commissionDetails { count } }', 'verifyAuth')).not.toThrow();
  });

  it('rejects a mutation operation with config_error', () => {
    expect(() =>
      assertReadOnlyQuery('mutation Bad { overrideStatus(id: "1") { ok } }', 'listTransactions'),
    ).toThrow(NetworkError);
    try {
      assertReadOnlyQuery('mutation Bad { overrideStatus(id: "1") { ok } }', 'listTransactions');
    } catch (err) {
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('config_error');
      expect(e.envelope.message.toLowerCase()).toContain('read-only');
      expect(e.envelope.message.toLowerCase()).toContain('mutation');
    }
  });

  it('rejects a subscription operation', () => {
    expect(() =>
      assertReadOnlyQuery('subscription Foo { commissionUpdates { id } }', 'listTransactions'),
    ).toThrow(NetworkError);
  });

  it('rejects an empty document', () => {
    expect(() => assertReadOnlyQuery('', 'verifyAuth')).toThrow(NetworkError);
    expect(() => assertReadOnlyQuery('   \n   ', 'verifyAuth')).toThrow(NetworkError);
  });

  it('rejects a malformed document with no recognisable query keyword', () => {
    expect(() => assertReadOnlyQuery('fragment foo on Bar { x }', 'verifyAuth')).toThrow(NetworkError);
  });

  it('is not fooled by the word "mutation" inside a string literal', () => {
    // A query whose argument value contains the word "mutation" should pass.
    const doc = 'query Foo { commissionDetails(actionType: "not a mutation") { count } }';
    expect(() => assertReadOnlyQuery(doc, 'listTransactions')).not.toThrow();
  });

  it('is not fooled by the word "mutation" inside a comment', () => {
    const doc = '# this is not a mutation\nquery Foo { commissionDetails { count } }';
    expect(() => assertReadOnlyQuery(doc, 'listTransactions')).not.toThrow();
  });

  it('catches a mutation buried after a comment block', () => {
    const doc = '# innocent comment\nmutation Evil { doStuff { ok } }';
    expect(() => assertReadOnlyQuery(doc, 'listTransactions')).toThrow(NetworkError);
  });

  it('catches a mutation that comes before a (would-be) query in the same document', () => {
    const doc = 'mutation Bad { x } query Innocent { commissionDetails { count } }';
    expect(() => assertReadOnlyQuery(doc, 'listTransactions')).toThrow(NetworkError);
  });
});

describe('cjAdvGraphQL', () => {
  it('refuses a mutation BEFORE making any network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      cjAdvGraphQL({
        operation: 'listTransactions',
        endpoint: CJ_ADVERTISER_GRAPHQL,
        query: 'mutation Bad { overrideStatus(id: "1") { ok } }',
        token: 'PAT',
        resilience: DEFAULT_RESILIENCE,
      }),
    ).rejects.toBeInstanceOf(NetworkError);

    // The critical assertion: fetch must NEVER have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes a valid query through and surfaces the response data', async () => {
    const body = { data: { commissionDetails: { count: 0, payloadComplete: true } } };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const r = await cjAdvGraphQL<{ commissionDetails: { count: number } }>({
      operation: 'verifyAuth',
      endpoint: CJ_ADVERTISER_GRAPHQL,
      query: 'query Probe { commissionDetails { count } }',
      token: 'PAT',
      resilience: DEFAULT_RESILIENCE,
    });
    expect(r.commissionDetails.count).toBe(0);
  });
});
