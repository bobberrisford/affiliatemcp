/**
 * Config-parsing tests for the hosted transport (`src/hosted-transport/env.ts`),
 * focused on the slice-2b `HOSTED_TRANSPORT_PUBLIC_URL` → `resourceUrl`
 * normalisation: it must be reduced to its origin so a deployer who sets a
 * path-bearing value (e.g. the `…/mcp` endpoint) still gets a working
 * `/.well-known/oauth-protected-resource` URL rather than a 404.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHostedTransportConfig } from '../../src/hosted-transport/env.js';

const SAVE = { ...process.env };

beforeEach(() => {
  // The two required URLs; everything else defaults.
  process.env.HOSTED_AUTH_URL = 'https://worker.example';
  process.env.HOSTED_VAULT_URL = 'https://worker.example';
  delete process.env.HOSTED_TRANSPORT_PUBLIC_URL;
});

afterEach(() => {
  process.env = { ...SAVE };
});

describe('loadHostedTransportConfig — resourceUrl (slice 2b)', () => {
  it('is undefined when HOSTED_TRANSPORT_PUBLIC_URL is unset (discovery off)', () => {
    expect(loadHostedTransportConfig().resourceUrl).toBeUndefined();
  });

  it('is the origin when set to a bare origin', () => {
    process.env.HOSTED_TRANSPORT_PUBLIC_URL = 'https://transport.example';
    expect(loadHostedTransportConfig().resourceUrl).toBe('https://transport.example');
  });

  it('normalises a path-bearing value (…/mcp) down to the origin', () => {
    process.env.HOSTED_TRANSPORT_PUBLIC_URL = 'https://transport.example/mcp';
    expect(loadHostedTransportConfig().resourceUrl).toBe('https://transport.example');
  });

  it('strips a trailing slash to the origin', () => {
    process.env.HOSTED_TRANSPORT_PUBLIC_URL = 'https://transport.example:8443/';
    expect(loadHostedTransportConfig().resourceUrl).toBe('https://transport.example:8443');
  });

  it('throws on a set-but-invalid value', () => {
    process.env.HOSTED_TRANSPORT_PUBLIC_URL = 'not a url';
    expect(() => loadHostedTransportConfig()).toThrow(/HOSTED_TRANSPORT_PUBLIC_URL/);
  });
});
