import { describe, expect, it } from 'vitest';
import {
  NetworkJsonSchema,
  validatePromotionFreshness,
  type NetworkJson,
} from '../../scripts/validate-network-json.js';

function manifest(overrides: Partial<NetworkJson> = {}): NetworkJson {
  return {
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
    side: 'publisher',
    credential_scope: 'single-brand',
    ...overrides,
  };
}

describe('NetworkJsonSchema', () => {
  it('accepts a well-formed manifest', () => {
    const r = NetworkJsonSchema.safeParse(manifest());
    expect(r.success).toBe(true);
  });

  it('rejects a bad slug', () => {
    const r = NetworkJsonSchema.safeParse(manifest({ slug: 'Awin' }));
    expect(r.success).toBe(false);
  });

  it('rejects an unknown claim_status', () => {
    const r = NetworkJsonSchema.safeParse(manifest({ claim_status: 'beta' as never }));
    expect(r.success).toBe(false);
  });
});

describe('validatePromotionFreshness', () => {
  const now = new Date('2026-06-18T12:00:00Z');

  it('accepts partial and production claims inside the 180-day freshness window', () => {
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'partial', last_verified: '2025-12-20' }),
        now,
      ),
    ).toEqual([]);
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'production', last_verified: '2025-12-20' }),
        now,
      ),
    ).toEqual([]);
  });

  it('rejects stale partial and production claims', () => {
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'partial', last_verified: '2025-12-19' }),
        now,
      )[0],
    ).toContain('181 days old');
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'production', last_verified: '2025-12-19' }),
        now,
      )[0],
    ).toContain('181 days old');
  });

  it('does not apply freshness to experimental claims', () => {
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'experimental', last_verified: '2020-01-01' }),
        now,
      ),
    ).toEqual([]);
  });

  it('rejects promoted claims dated in the future', () => {
    expect(
      validatePromotionFreshness(
        manifest({ claim_status: 'partial', last_verified: '2026-06-19' }),
        now,
      )[0],
    ).toContain('future verification date');
  });
});
