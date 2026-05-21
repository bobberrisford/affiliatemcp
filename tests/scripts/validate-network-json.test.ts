import { describe, expect, it } from 'vitest';
import { NetworkJsonSchema } from '../../scripts/validate-network-json.js';

describe('NetworkJsonSchema', () => {
  it('accepts a well-formed manifest', () => {
    const r = NetworkJsonSchema.safeParse({
      slug: 'awin',
      name: 'Awin',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN', 'AWIN_PUBLISHER_ID'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'production',
      adapter_version: '0.1.0',
      last_verified: '2026-01-01',
      supports_brand_ops: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a bad slug', () => {
    const r = NetworkJsonSchema.safeParse({
      slug: 'Awin',
      name: 'Awin',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'production',
      adapter_version: '0.1.0',
      last_verified: '2026-01-01',
      supports_brand_ops: false,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown claim_status', () => {
    const r = NetworkJsonSchema.safeParse({
      slug: 'awin',
      name: 'Awin',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'beta',
      adapter_version: '0.1.0',
      last_verified: '2026-01-01',
      supports_brand_ops: false,
    });
    expect(r.success).toBe(false);
  });
});
