/**
 * Smoke test: shared types compile and `NotImplementedError` behaves correctly.
 * The real type contract is enforced at build time by `npm run typecheck`.
 */

import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../src/shared/types.js';
import type {
  Contract,
  ContractQuery,
  NetworkErrorEnvelope,
  NetworkMeta,
  Programme,
  Transaction,
} from '../../src/shared/types.js';

describe('shared types', () => {
  it('NotImplementedError carries a reason', () => {
    const e = new NotImplementedError('foo not implemented');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('NotImplementedError');
    expect(e.reason).toBe('foo not implemented');
  });

  it('a minimal Programme record is structurally valid', () => {
    const p: Programme = {
      id: 'X',
      name: 'X',
      network: 'awin',
      status: 'joined',
      rawNetworkData: {},
    };
    expect(p.id).toBe('X');
  });

  it('a minimal Transaction record carries ageDays', () => {
    const t: Transaction = {
      id: 't1',
      network: 'awin',
      programmeId: 'p1',
      programmeName: 'P',
      status: 'pending',
      amount: 10,
      currency: 'GBP',
      commission: 1,
      dateConverted: '2026-01-01T00:00:00Z',
      ageDays: 7,
      rawNetworkData: {},
    };
    expect(t.ageDays).toBe(7);
  });

  it('NetworkErrorEnvelope shape is stable', () => {
    const env: NetworkErrorEnvelope = {
      type: 'auth_error',
      network: 'awin',
      operation: 'listProgrammes',
      message: 'nope',
      timestamp: new Date().toISOString(),
    };
    expect(env.type).toBe('auth_error');
  });

  it('Programme accepts additive cross-network identity fields', () => {
    const p: Programme = {
      id: 'X',
      name: 'Acme',
      network: 'awin',
      status: 'joined',
      rawNetworkData: {},
      merchantKey: 'acme.com',
      merchantKeySource: 'fallback-domain',
    };
    expect(p.merchantKey).toBe('acme.com');
    expect(p.merchantKeySource).toBe('fallback-domain');
  });

  it('Transaction accepts additive statusRaw and merchantKey fields', () => {
    const t: Transaction = {
      id: 't1',
      network: 'impact',
      programmeId: 'p1',
      programmeName: 'P',
      status: 'other',
      statusRaw: 'LOCKED',
      amount: 10,
      currency: 'USD',
      commission: 1,
      dateConverted: '2026-01-01T00:00:00Z',
      ageDays: 7,
      merchantKey: 'acme.com',
      rawNetworkData: {},
    };
    expect(t.statusRaw).toBe('LOCKED');
    expect(t.merchantKey).toBe('acme.com');
  });

  it('a minimal read-only Contract record is structurally valid', () => {
    const c: Contract = {
      id: 'CT-1',
      network: 'impact-advertiser',
      programmeId: 'CMP-42',
      status: 'active',
      rawNetworkData: {},
    };
    expect(c.id).toBe('CT-1');
    expect(c.status).toBe('active');
  });

  it('Contract accepts optional partner, terms, and date fields', () => {
    const c: Contract = {
      id: 'CT-1',
      network: 'impact-advertiser',
      programmeId: 'CMP-42',
      programmeName: 'Acme Spring Sale',
      mediaPartnerId: 'MP-1',
      mediaPartnerName: 'BestDeals.com',
      status: 'pending',
      payoutTerms: '8% of sale amount',
      effectiveDate: '2026-01-01T00:00:00.000Z',
      expiryDate: '2026-12-31T00:00:00.000Z',
      rawNetworkData: {},
    };
    expect(c.mediaPartnerName).toBe('BestDeals.com');
    expect(c.payoutTerms).toContain('8%');
  });

  it('ContractQuery scopes by programme, status, and media partner', () => {
    const q: ContractQuery = {
      programmeId: 'CMP-42',
      status: ['active', 'pending'],
      mediaPartnerId: 'MP-1',
      limit: 50,
    };
    expect(q.programmeId).toBe('CMP-42');
    expect(Array.isArray(q.status)).toBe(true);
  });

  it('NetworkMeta accepts optional networkTimezone', () => {
    const meta: NetworkMeta = {
      slug: 'awin',
      name: 'Awin',
      baseUrl: 'https://api.awin.com',
      authModel: 'bearer',
      adapterVersion: '0.1.0',
      claimStatus: 'partial',
      knownLimitations: [],
      supportsBrandOps: false,
      setupTimeEstimateMinutes: 5,
      setupRequiresApproval: false,
      side: 'publisher',
      credentialScope: 'single-brand',
      networkTimezone: 'Europe/London',
    };
    expect(meta.networkTimezone).toBe('Europe/London');
  });
});
