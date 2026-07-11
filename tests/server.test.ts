import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { classifyToolForTelemetry, telemetryOutcomeForThrown } from '../src/server.js';
import { BrandNotRegistered, NetworkError, toErrorEnvelope } from '../src/shared/errors.js';
import { NotImplementedError } from '../src/shared/types.js';

describe('classifyToolForTelemetry', () => {
  it('classifies known meta-tools under the meta network', () => {
    expect(classifyToolForTelemetry('affiliate_get_client_strategy')).toEqual({
      network: 'meta',
      operation: 'get_client_strategy',
    });
    expect(classifyToolForTelemetry('affiliate_list_client_strategies')).toEqual({
      network: 'meta',
      operation: 'list_client_strategies',
    });
    expect(classifyToolForTelemetry('affiliate_run_diagnostic')).toEqual({
      network: 'meta',
      operation: 'run_diagnostic',
    });
    expect(classifyToolForTelemetry('affiliate_list_actions')).toEqual({
      network: 'meta',
      operation: 'list_actions',
    });
  });

  it('keeps adapter tool slugs and operations unchanged', () => {
    expect(classifyToolForTelemetry('affiliate_impact_list_transactions')).toEqual({
      network: 'impact',
      operation: 'list_transactions',
    });
    expect(
      classifyToolForTelemetry('affiliate_impact-advertiser_propose_contract'),
    ).toEqual({
      network: 'impact-advertiser',
      operation: 'propose_contract',
    });
  });
});

describe('telemetryOutcomeForThrown', () => {
  const ctx = { network: 'awin' as const, operation: 'list_transactions' };
  const coerce = (err: unknown) => toErrorEnvelope(err, ctx);

  it('counts a sanctioned NotImplementedError as not_implemented, not internal_error', () => {
    const err = new NotImplementedError('publisher side only');
    expect(telemetryOutcomeForThrown(err, coerce(err))).toBe('not_implemented');
  });

  it('counts an unregistered brand as config_error: an expected user-configuration miss', () => {
    const err = new BrandNotRegistered('acme', 'awin');
    const envelope = coerce(err);
    expect(envelope.type).toBe('config_error');
    expect(telemetryOutcomeForThrown(err, envelope)).toBe('config_error');
  });

  it('counts argument-validation failures as other_error, not internal_error', () => {
    let zodError: unknown;
    try {
      z.object({ brand: z.string() }).parse({});
    } catch (err) {
      zodError = err;
    }
    expect(telemetryOutcomeForThrown(zodError, coerce(zodError))).toBe('other_error');
  });

  it('classifies a structured NetworkError by envelope type and status class', () => {
    const err = new NetworkError({
      type: 'network_api_error',
      network: 'awin',
      operation: 'list_transactions',
      httpStatus: 503,
      message: 'upstream unavailable',
      timestamp: new Date().toISOString(),
    });
    expect(telemetryOutcomeForThrown(err, err.envelope)).toBe('upstream_5xx');
  });

  it('counts a raw unsanctioned throw as internal_error even when coercion guesses a type', () => {
    const err = new TypeError('Cannot read properties of undefined');
    expect(telemetryOutcomeForThrown(err, coerce(err))).toBe('internal_error');
    const timeoutish = new Error('request timed out');
    expect(coerce(timeoutish).type).toBe('timeout');
    expect(telemetryOutcomeForThrown(timeoutish, coerce(timeoutish))).toBe('internal_error');
  });
});
