/**
 * Smoke test: shared types compile and `NotImplementedError` behaves correctly.
 * The real type contract is enforced at build time by `npm run typecheck`.
 */

import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../src/shared/types.js';
import type { NetworkErrorEnvelope, Programme, Transaction } from '../../src/shared/types.js';

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
});
