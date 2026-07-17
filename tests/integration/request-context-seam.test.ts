/**
 * End-to-end integration: request-scoped credential resolution through a
 * real adapter (hosted workstream H1).
 *
 * `src/shared/config.ts`'s `getCredential`/`requireCredential` is the single
 * seam nearly every adapter's credential read already funnels through (see
 * the H1 investigation notes in the PR description). This suite proves the
 * seam end to end using the real CJ adapter rather than a stub:
 *   - a request-context credential overlay reaches the adapter's actual HTTP
 *     call (the Authorization header) even when `process.env` disagrees or
 *     has nothing at all;
 *   - with no request context — the local server's default state before H1
 *     — behaviour is identical to calling the adapter directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cjAdapter } from '../../src/networks/cj/adapter.js';
import { _resetBreakers } from '../../src/shared/resilience.js';
import { localDefaultContext, runInRequestContext } from '../../src/shared/request-context.js';

/** Typed the same way `tests/networks/cj/adapter.test.ts` types its fetch mock. */
function mockFetch(companyId: string): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => fakeMeResponse(companyId));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function fakeMeResponse(companyId: string): Response {
  return new Response(
    JSON.stringify({ data: { me: { id: 'u1', companyId, name: 'Test Co' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  _resetBreakers();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

describe('request-context credential overlay reaches a real adapter call', () => {
  it('an overlay token is used even when process.env has no CJ_API_TOKEN at all', async () => {
    delete process.env['CJ_API_TOKEN'];
    process.env['CJ_COMPANY_ID'] = '1234567';

    const spy = mockFetch('1234567');

    const result = await runInRequestContext(
      { identity: 'tenant-overlay', credentials: { CJ_API_TOKEN: 'tenant-overlay-token' } },
      () => cjAdapter.verifyAuth(),
    );

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const auth = (init?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer tenant-overlay-token');
  });

  it('an overlay token wins over a conflicting process.env value', async () => {
    process.env['CJ_API_TOKEN'] = 'env-token-should-not-be-used';
    process.env['CJ_COMPANY_ID'] = '1234567';

    const spy = mockFetch('1234567');

    await runInRequestContext(
      { identity: 'tenant-overlay', credentials: { CJ_API_TOKEN: 'tenant-overlay-token' } },
      () => cjAdapter.verifyAuth(),
    );

    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const auth = (init?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer tenant-overlay-token');
  });

  it('localDefaultContext() behaves exactly like calling the adapter with no context at all', async () => {
    process.env['CJ_API_TOKEN'] = 'plain-env-token';
    process.env['CJ_COMPANY_ID'] = '1234567';

    const spy = mockFetch('1234567');
    const withoutContext = await cjAdapter.verifyAuth();
    const authWithoutContext = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;

    spy.mockClear();
    const withLocalDefault = await runInRequestContext(localDefaultContext(), () =>
      cjAdapter.verifyAuth(),
    );
    const authWithLocalDefault = (spy.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;

    expect(withLocalDefault).toEqual(withoutContext);
    expect(authWithLocalDefault['Authorization']).toBe(authWithoutContext['Authorization']);
  });
});
