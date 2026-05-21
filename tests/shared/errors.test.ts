import { describe, expect, it } from 'vitest';
import {
  buildErrorEnvelope,
  isErrorEnvelope,
  NetworkError,
  NotImplementedError,
  toErrorEnvelope,
} from '../../src/shared/errors.js';

describe('error envelope', () => {
  it('buildErrorEnvelope produces a stable shape with ISO timestamp', () => {
    const env = buildErrorEnvelope({
      type: 'auth_error',
      network: 'awin',
      operation: 'listProgrammes',
      message: 'bad token',
    });
    expect(env.type).toBe('auth_error');
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isErrorEnvelope(env)).toBe(true);
  });

  it('coerces NotImplementedError to a not_implemented envelope', () => {
    const env = toErrorEnvelope(new NotImplementedError('nope'), {
      network: 'awin',
      operation: 'listClicks',
    });
    expect(env.type).toBe('not_implemented');
    expect(env.message).toBe('nope');
  });

  it('coerces a NetworkError by passing its envelope through', () => {
    const original = buildErrorEnvelope({
      type: 'rate_limit',
      network: 'awin',
      operation: 'listProgrammes',
      message: 'slow down',
    });
    const env = toErrorEnvelope(new NetworkError(original), {
      network: 'awin',
      operation: 'listProgrammes',
    });
    expect(env).toEqual(original);
  });

  it('classifies plain errors by message hint', () => {
    const env = toErrorEnvelope(new Error('Request timed out'), {
      network: 'awin',
      operation: 'listProgrammes',
    });
    expect(env.type).toBe('timeout');
  });
});
