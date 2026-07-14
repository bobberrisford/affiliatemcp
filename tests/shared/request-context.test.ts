/**
 * Request-scoped identity seam (hosted workstream H1).
 *
 * Covers:
 *   - outside any request context, identity and credential overlay lookups
 *     behave as if the seam did not exist (local-path parity);
 *   - `runInRequestContext` makes an identity and credential overlay visible
 *     for the whole async lifetime of the wrapped call, including across
 *     `await` boundaries;
 *   - two concurrent contexts do not leak into each other;
 *   - `getCredential` (`src/shared/config.ts`) consults the overlay first and
 *     falls back to `process.env` exactly as before this seam existed.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getContextCredential,
  getRequestContext,
  getRequestIdentity,
  LOCAL_IDENTITY,
  localDefaultContext,
  runInRequestContext,
} from '../../src/shared/request-context.js';
import { getCredential } from '../../src/shared/config.js';

const TEST_CRED = 'TEST_REQUEST_CONTEXT_CREDENTIAL';

afterEach(() => {
  delete process.env[TEST_CRED];
});

describe('request context — no active context (local-path parity)', () => {
  it('getRequestContext() is undefined', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('getRequestIdentity() falls back to LOCAL_IDENTITY', () => {
    expect(getRequestIdentity()).toBe(LOCAL_IDENTITY);
  });

  it('getContextCredential() returns undefined', () => {
    expect(getContextCredential(TEST_CRED)).toBeUndefined();
  });

  it('localDefaultContext() carries the fixed identity and no overlays', () => {
    const ctx = localDefaultContext();
    expect(ctx.identity).toBe(LOCAL_IDENTITY);
    expect(ctx.credentials).toBeUndefined();
    expect(ctx.brandStore).toBeUndefined();
    expect(ctx.clientStrategyStore).toBeUndefined();
  });
});

describe('runInRequestContext — overlay resolution', () => {
  it('makes the identity visible inside the callback', () => {
    const seen = runInRequestContext({ identity: 'tenant-a' }, () => getRequestIdentity());
    expect(seen).toBe('tenant-a');
  });

  it('identity does not leak outside the callback', () => {
    runInRequestContext({ identity: 'tenant-a' }, () => getRequestIdentity());
    expect(getRequestIdentity()).toBe(LOCAL_IDENTITY);
  });

  it('makes a credential overlay visible inside the callback, and only for named keys', () => {
    const result = runInRequestContext(
      { identity: 'tenant-a', credentials: { AWIN_API_TOKEN: 'tenant-a-token' } },
      () => ({
        overlaid: getContextCredential('AWIN_API_TOKEN'),
        missing: getContextCredential('CJ_API_TOKEN'),
      }),
    );
    expect(result.overlaid).toBe('tenant-a-token');
    expect(result.missing).toBeUndefined();
  });

  it('stays visible across await boundaries inside the callback', async () => {
    const seen = await runInRequestContext({ identity: 'tenant-async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      return getRequestIdentity();
    });
    expect(seen).toBe('tenant-async');
  });

  it('two concurrent contexts do not leak into each other', async () => {
    const run = (identity: string, delayMs: number) =>
      runInRequestContext({ identity }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return getRequestIdentity();
      });

    const [a, b] = await Promise.all([run('tenant-1', 10), run('tenant-2', 0)]);
    expect(a).toBe('tenant-1');
    expect(b).toBe('tenant-2');
  });
});

describe('getCredential — context overlay first, process.env fallback', () => {
  it('falls back to process.env when no context is active (today\'s behaviour)', () => {
    process.env[TEST_CRED] = 'from-env';
    expect(getCredential(TEST_CRED)).toBe('from-env');
  });

  it('falls back to process.env when a context is active but has no overlay for this name', () => {
    process.env[TEST_CRED] = 'from-env';
    const result = runInRequestContext({ identity: 'tenant-a' }, () => getCredential(TEST_CRED));
    expect(result).toBe('from-env');
  });

  it('prefers the context overlay over process.env when both are present', () => {
    process.env[TEST_CRED] = 'from-env';
    const result = runInRequestContext(
      { identity: 'tenant-a', credentials: { [TEST_CRED]: 'from-overlay' } },
      () => getCredential(TEST_CRED),
    );
    expect(result).toBe('from-overlay');
  });

  it('returns undefined when neither the overlay nor process.env has the credential', () => {
    delete process.env[TEST_CRED];
    const result = runInRequestContext({ identity: 'tenant-a' }, () => getCredential(TEST_CRED));
    expect(result).toBeUndefined();
  });

  it('the local default context is byte-identical to no context at all', () => {
    process.env[TEST_CRED] = 'from-env';
    const withoutContext = getCredential(TEST_CRED);
    const withLocalDefault = runInRequestContext(localDefaultContext(), () =>
      getCredential(TEST_CRED),
    );
    expect(withLocalDefault).toBe(withoutContext);
  });
});
