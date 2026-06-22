import { describe, expect, it } from 'vitest';

import { classifyToolForTelemetry } from '../src/server.js';

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
