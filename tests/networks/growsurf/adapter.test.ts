/**
 * GrowSurf adapter — unit tests.
 *
 * Exercises referral-credit status mapping, transformers, request shape (bearer
 * token, the `/v2` prefix, campaign-scoped routes, cursor pagination), the
 * advertiser operations, the requireCtx guard, NotImplemented ops, and
 * verifyAuth. No live calls — fetch is mocked from documented shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { growsurfAdapter, _internals } from '../../../src/networks/growsurf/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'growsurf');
const CTX = { networkBrandId: 'acme' };
const CAMPAIGN_ID = '4pdlhb';

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method, headers });
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, calls };
}

beforeEach(() => {
  _resetBreakers();
  process.env['GROWSURF_API_KEY'] = 'fake-key';
  process.env['GROWSURF_CAMPAIGN_ID'] = CAMPAIGN_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['GROWSURF_API_KEY'];
  delete process.env['GROWSURF_CAMPAIGN_ID'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('GrowSurf transformers', () => {
  it('maps referralStatus to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ referralStatus: 'CREDIT_AWARDED' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ referralStatus: 'CREDIT_EARNED' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ referralStatus: 'CREDIT_PENDING' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ referralStatus: 'FRAUD' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ referralStatus: 'MYSTERY' })).toBe('other');
  });

  it('maps campaign status to a canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus('ENABLED')).toBe('joined');
    expect(_internals.mapProgrammeStatus('DISABLED')).toBe('suspended');
    expect(_internals.mapProgrammeStatus(undefined)).toBe('joined');
  });

  it('normalises epoch-millisecond timestamps to ISO', () => {
    expect(_internals.epochMsToIso(1552404738928)).toBe('2019-03-12T15:32:18.928Z');
    expect(_internals.epochMsToIso(undefined)).toBeUndefined();
  });

  it('maps a participant to a referral-credit Transaction (count, not money)', () => {
    const raw = {
      id: 'f8g9nl',
      email: 'gavin@hooli.com',
      referralCount: 2,
      referralStatus: 'CREDIT_AWARDED',
      createdAt: 1552404738928,
    };
    const t = _internals.toTransaction(raw, CAMPAIGN_ID, 'Pied Piper', new Date('2019-04-01T00:00:00Z'));
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(2);
    expect(t.amount).toBe(2);
    expect(t.currency).toBe(_internals.CREDIT_UNIT);
    expect(t.status).toBe('paid');
    expect(t.programmeId).toBe(CAMPAIGN_ID);
    expect(t.programmeName).toBe('Pied Piper');
  });

  it('models a campaign as a Programme with the credit sentinel currency', () => {
    const p = _internals.toProgramme(loadFixture('campaign.json') as Record<string, unknown>);
    expect(p.id).toBe(CAMPAIGN_ID);
    expect(p.name).toBe('Pied Piper Referral Programme');
    expect(p.status).toBe('joined');
    expect(p.currency).toBe(_internals.CREDIT_UNIT);
    expect(p.commissionRate).toMatchObject({ type: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('GrowSurf request shape', () => {
  it('getProgramme GETs /v2/campaign/:id with a bearer token', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('campaign.json'))]);
    await growsurfAdapter.getProgramme(CAMPAIGN_ID, CTX);
    expect(calls[0]?.url).toContain(`/v2/campaign/${CAMPAIGN_ID}`);
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
  });

  it('listTransactions GETs the campaign then /v2/campaign/:id/participants', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(loadFixture('participants.json')),
    ]);
    await growsurfAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain(`/v2/campaign/${CAMPAIGN_ID}`);
    expect(calls[1]?.url).toContain(`/v2/campaign/${CAMPAIGN_ID}/participants`);
    expect(calls[1]?.url).toContain('limit=100');
  });

  it('refuses to run without a brand context', async () => {
    await expect(growsurfAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('GrowSurf operations', () => {
  it('listProgrammes models the campaign as a single Programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaign.json'))]);
    const programmes = await growsurfAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.name).toBe('Pied Piper Referral Programme');
    expect(programmes[0]?.id).toBe(CAMPAIGN_ID);
  });

  it('getProgramme fetches a single campaign by id', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('campaign.json'))]);
    const programme = await growsurfAdapter.getProgramme(CAMPAIGN_ID, CTX);
    expect(programme.name).toBe('Pied Piper Referral Programme');
    expect(calls[0]?.url).toContain(`/v2/campaign/${CAMPAIGN_ID}`);
  });

  it('listTransactions maps only participants with referral credit and normalises status', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(loadFixture('participants.json')),
    ]);
    const all = await growsurfAdapter.listTransactions(undefined, CTX);
    // The fixture has 4 participants; one has referralCount 0 and is excluded.
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'reversed'].sort());

    mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(loadFixture('participants.json')),
    ]);
    const reversed = await growsurfAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream status is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { referralStatus?: string }).referralStatus).toBe('FRAUD');
  });

  it('getEarningsSummary totals referral credit across a wide window', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(loadFixture('participants.json')),
    ]);
    const summary = await growsurfAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // referralCount: 2 (paid) + 1 (approved) + 3 (reversed) = 6 credits.
    expect(summary.totalEarnings).toBe(6);
    expect(summary.currency).toBe(_internals.CREDIT_UNIT);
    expect(summary.byStatus.paid).toBe(2);
    expect(summary.byStatus.approved).toBe(1);
    expect(summary.byStatus.reversed).toBe(3);
  });

  it('paginates participants while nextId is set', async () => {
    const page1 = {
      participants: [{ id: 'a1', email: 'a@x.com', referralCount: 1, referralStatus: 'CREDIT_AWARDED', createdAt: 1552404738928 }],
      nextId: 'a1',
      more: true,
    };
    const page2 = {
      participants: [{ id: 'a2', email: 'b@x.com', referralCount: 1, referralStatus: 'CREDIT_AWARDED', createdAt: 1552404738928 }],
      nextId: null,
      more: false,
    };
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(page1),
      fakeResponse(page2),
    ]);
    const txns = await growsurfAdapter.listTransactions(undefined, CTX);
    expect(txns).toHaveLength(2);
    // 1 campaign-name call + 2 participant pages.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain('nextId=a1');
  });

  it('returns an empty array when there are no participants with credit', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaign.json')),
      fakeResponse(loadFixture('empty.json')),
    ]);
    const txns = await growsurfAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(growsurfAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      growsurfAdapter.generateTrackingLink({ programmeId: CAMPAIGN_ID, destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('GrowSurf verifyAuth', () => {
  it('returns ok on a 200 campaign probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaign.json'))]);
    const result = await growsurfAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await growsurfAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
