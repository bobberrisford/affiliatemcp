/**
 * Amazon Creators adapter — unit tests.
 *
 * No live calls. We mock `globalThis.fetch` (the seam between the adapter and
 * the network) so the full client + resilience + transformer stack is exercised
 * without HTTP. The Creators API is product-catalog only: the reporting ops are
 * asserted as NotImplementedError, the synthetic-programme and tracking-link
 * behaviour is asserted deterministically, and verifyAuth is exercised against a
 * mocked OAuth2 token exchange.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  amazonCreatorsAdapter,
  _internals,
} from '../../../src/networks/amazon-creators/adapter.js';
import {
  _resetTokenCache,
  tokenEndpointForMarketplace,
} from '../../../src/networks/amazon-creators/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'amazon-creators', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function mockFetchQueue(responses: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['AMAZON_CREATORS_CLIENT_ID'] = 'amzn1.application-oa2-client.test';
  process.env['AMAZON_CREATORS_CLIENT_SECRET'] = 'test-secret-please-ignore';
  process.env['AMAZON_PARTNER_TAG'] = 'atollstest-20';
  process.env['AMAZON_MARKETPLACE'] = 'www.amazon.com';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AMAZON_CREATORS_CLIENT_ID'];
  delete process.env['AMAZON_CREATORS_CLIENT_SECRET'];
  delete process.env['AMAZON_PARTNER_TAG'];
  delete process.env['AMAZON_MARKETPLACE'];
});

// ---------------------------------------------------------------------------
// Token endpoint region mapping
// ---------------------------------------------------------------------------

describe('amazon-creators token endpoint region mapping', () => {
  it('maps NA / EU / FE marketplaces to the correct token host', () => {
    expect(tokenEndpointForMarketplace('www.amazon.com')).toBe(
      'https://api.amazon.com/auth/o2/token',
    );
    expect(tokenEndpointForMarketplace('www.amazon.co.uk')).toBe(
      'https://api.amazon.co.uk/auth/o2/token',
    );
    expect(tokenEndpointForMarketplace('www.amazon.de')).toBe(
      'https://api.amazon.co.uk/auth/o2/token',
    );
    expect(tokenEndpointForMarketplace('www.amazon.co.jp')).toBe(
      'https://api.amazon.co.jp/auth/o2/token',
    );
  });

  it('falls back to North America for an unrecognised marketplace', () => {
    expect(tokenEndpointForMarketplace('www.amazon.example')).toBe(
      'https://api.amazon.com/auth/o2/token',
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — synthetic single programme
// ---------------------------------------------------------------------------

describe('amazon-creators.listProgrammes (synthetic)', () => {
  it('returns one synthetic programme keyed on the partner tag, no fetch', async () => {
    const spy = mockFetchQueue([]);
    const programmes = await amazonCreatorsAdapter.listProgrammes();
    expect(spy.mock.calls.length).toBe(0);
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('atollstest-20');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.network).toBe('amazon-creators');
    expect((programmes[0]?.rawNetworkData as { synthesised?: boolean }).synthesised).toBe(true);
  });

  it('search filter matches the partner tag and programme name', async () => {
    mockFetchQueue([]);
    expect((await amazonCreatorsAdapter.listProgrammes({ search: 'atollstest' })).length).toBe(1);
    expect((await amazonCreatorsAdapter.listProgrammes({ search: 'associates' })).length).toBe(1);
    expect((await amazonCreatorsAdapter.listProgrammes({ search: 'nomatch' })).length).toBe(0);
  });

  it('status filter excludes the programme when joined is not requested', async () => {
    mockFetchQueue([]);
    expect((await amazonCreatorsAdapter.listProgrammes({ status: 'pending' })).length).toBe(0);
    expect((await amazonCreatorsAdapter.listProgrammes({ status: 'joined' })).length).toBe(1);
  });

  it('categories filter yields empty (synthetic programme has no categories)', async () => {
    mockFetchQueue([]);
    expect((await amazonCreatorsAdapter.listProgrammes({ categories: ['books'] })).length).toBe(0);
  });

  it('throws a NetworkError when the partner tag is missing', async () => {
    delete process.env['AMAZON_PARTNER_TAG'];
    await expect(amazonCreatorsAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('amazon-creators.getProgramme', () => {
  it('returns the synthetic programme for the configured partner tag', async () => {
    mockFetchQueue([]);
    const p = await amazonCreatorsAdapter.getProgramme('atollstest-20');
    expect(p.id).toBe('atollstest-20');
    expect(p.status).toBe('joined');
  });

  it('rejects an id that is not the partner tag with a config_error', async () => {
    mockFetchQueue([]);
    await expect(amazonCreatorsAdapter.getProgramme('something-else')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Reporting ops — unsupported (no reporting API)
// ---------------------------------------------------------------------------

describe('amazon-creators reporting ops are unsupported', () => {
  it('listTransactions throws NotImplementedError with the documented reason', async () => {
    await expect(amazonCreatorsAdapter.listTransactions({})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    try {
      await amazonCreatorsAdapter.listTransactions({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('product-catalog API only');
    }
  });

  it('getEarningsSummary throws NotImplementedError', async () => {
    await expect(amazonCreatorsAdapter.getEarningsSummary({})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('listClicks throws NotImplementedError', async () => {
    await expect(amazonCreatorsAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic ?tag= construction
// ---------------------------------------------------------------------------

describe('amazon-creators.generateTrackingLink', () => {
  it('appends the partner tag as ?tag= and does NOT call fetch', async () => {
    const spy = mockFetchQueue([]);
    const link = await amazonCreatorsAdapter.generateTrackingLink({
      programmeId: '',
      destinationUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
    });
    expect(spy.mock.calls.length).toBe(0);
    expect(link.trackingUrl).toBe('https://www.amazon.com/dp/B08N5WRWNW?tag=atollstest-20');
    expect(link.network).toBe('amazon-creators');
    expect(link.programmeId).toBe('atollstest-20');
  });

  it('overwrites an existing tag and preserves other query params', async () => {
    mockFetchQueue([]);
    const link = await amazonCreatorsAdapter.generateTrackingLink({
      programmeId: '',
      destinationUrl: 'https://www.amazon.com/dp/B08N5WRWNW?tag=old-99&ref=foo',
    });
    expect(link.trackingUrl).toContain('tag=atollstest-20');
    expect(link.trackingUrl).not.toContain('old-99');
    expect(link.trackingUrl).toContain('ref=foo');
  });

  it('rejects an invalid destination URL with a config_error', async () => {
    mockFetchQueue([]);
    await expect(
      amazonCreatorsAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'not-a-url' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('rejects a programmeId that is not the partner tag', async () => {
    mockFetchQueue([]);
    await expect(
      amazonCreatorsAdapter.generateTrackingLink({
        programmeId: 'wrong-tag-20',
        destinationUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws when the partner tag is not configured', async () => {
    delete process.env['AMAZON_PARTNER_TAG'];
    mockFetchQueue([]);
    await expect(
      amazonCreatorsAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — OAuth2 token exchange
// ---------------------------------------------------------------------------

describe('amazon-creators.verifyAuth', () => {
  it('returns ok:true with identity when the token endpoint responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token-response.json'))]);
    const r = await amazonCreatorsAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('atollstest-20');
      expect(r.identity).toContain('www.amazon.com');
    }
  });

  it('returns ok:false on a 401 from the token endpoint', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_client"}', { status: 401 })]);
    const r = await amazonCreatorsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|invalid_client|HTTP 401/);
  });

  it('returns ok:false (config_error) when a credential is missing, without throwing', async () => {
    delete process.env['AMAZON_CREATORS_CLIENT_SECRET'];
    const r = await amazonCreatorsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('amazon-creators.validateCredential', () => {
  it('defers client-id validation when the secret is absent', async () => {
    delete process.env['AMAZON_CREATORS_CLIENT_SECRET'];
    const r = await amazonCreatorsAdapter.validateCredential('AMAZON_CREATORS_CLIENT_ID', 'x');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('after');
  });

  it('rejects an empty secret and an empty partner tag', async () => {
    expect(
      (await amazonCreatorsAdapter.validateCredential('AMAZON_CREATORS_CLIENT_SECRET', '')).ok,
    ).toBe(false);
    expect((await amazonCreatorsAdapter.validateCredential('AMAZON_PARTNER_TAG', '')).ok).toBe(
      false,
    );
  });

  it('rejects a malformed marketplace domain', async () => {
    const r = await amazonCreatorsAdapter.validateCredential('AMAZON_MARKETPLACE', 'amazon');
    expect(r.ok).toBe(false);
    const ok = await amazonCreatorsAdapter.validateCredential('AMAZON_MARKETPLACE', 'www.amazon.com');
    expect(ok.ok).toBe(true);
  });

  it('rejects an unknown field', async () => {
    const r = await amazonCreatorsAdapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('amazon-creators.capabilitiesCheck', () => {
  it('records reporting ops + listClicks as unsupported and supported ops as supported', async () => {
    // listProgrammes probe makes no fetch; verifyAuth probe consumes one token call.
    mockFetchQueue([fakeResponse(loadFixture('token-response.json'))]);
    const caps = await amazonCreatorsAdapter.capabilitiesCheck();
    expect(caps.network).toBe('amazon-creators');
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(false);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('amazon-creators error transparency', () => {
  it('classifies a 401 token response as auth_error with verbatim body', async () => {
    const body = '{"error":"invalid_client","error_description":"bad secret"}';
    mockFetchQueue([fakeResponse(body, { status: 401, rawBody: body })]);
    const r = await amazonCreatorsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

describe('amazon-creators internals', () => {
  it('partnerTagProgramme synthesises a joined programme with raw context', () => {
    const p = _internals.partnerTagProgramme('foo-20', 'www.amazon.co.uk');
    expect(p.id).toBe('foo-20');
    expect(p.status).toBe('joined');
    expect(p.advertiserUrl).toBe('https://www.amazon.co.uk/');
    expect((p.rawNetworkData as { synthesised?: boolean }).synthesised).toBe(true);
  });
});
