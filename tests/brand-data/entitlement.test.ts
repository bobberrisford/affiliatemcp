import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildEntitlementRequired,
  entitlementState,
  GATED_TOOLS,
  isEntitled,
} from '../../src/brand-data/entitlement.js';

let original: string | undefined;

beforeEach(() => {
  original = process.env['AFFILIATE_MCP_ENTITLED'];
});
afterEach(() => {
  if (original === undefined) delete process.env['AFFILIATE_MCP_ENTITLED'];
  else process.env['AFFILIATE_MCP_ENTITLED'] = original;
});

describe('isEntitled (dormant gate)', () => {
  it('defaults to entitled when the flag is unset or empty', () => {
    delete process.env['AFFILIATE_MCP_ENTITLED'];
    expect(isEntitled()).toBe(true);
    process.env['AFFILIATE_MCP_ENTITLED'] = '   ';
    expect(isEntitled()).toBe(true);
  });

  it('withholds entitlement only for explicit off values', () => {
    for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      process.env['AFFILIATE_MCP_ENTITLED'] = off;
      expect(isEntitled(), `"${off}" should withhold`).toBe(false);
    }
  });

  it('treats any other value as entitled', () => {
    for (const on of ['1', 'true', 'on', 'yes', 'paid']) {
      process.env['AFFILIATE_MCP_ENTITLED'] = on;
      expect(isEntitled(), `"${on}" should entitle`).toBe(true);
    }
  });
});

describe('entitlementState', () => {
  it('reflects the flag', () => {
    delete process.env['AFFILIATE_MCP_ENTITLED'];
    expect(entitlementState()).toMatchObject({ entitled: true, tier: 'paid' });
    process.env['AFFILIATE_MCP_ENTITLED'] = 'off';
    expect(entitlementState()).toMatchObject({ entitled: false, tier: 'free' });
  });
});

describe('GATED_TOOLS / buildEntitlementRequired', () => {
  it('gates get_brand_rows but not the free snapshot tool', () => {
    expect(GATED_TOOLS.has('affiliate_get_brand_rows')).toBe(true);
    expect(GATED_TOOLS.has('affiliate_build_brand_snapshot')).toBe(false);
  });

  it('builds a structured entitlement_required result naming the tool', () => {
    expect(buildEntitlementRequired('affiliate_get_brand_rows')).toMatchObject({
      error: 'entitlement_required',
      entitled: false,
      tier: 'paid',
    });
    expect(buildEntitlementRequired('affiliate_get_brand_rows').message).toContain(
      'affiliate_get_brand_rows',
    );
  });
});
