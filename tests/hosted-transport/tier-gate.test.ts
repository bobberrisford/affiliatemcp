/**
 * Unit tests for the H6 billing-tier gate helpers (`src/hosted-transport/tier-gate.ts`).
 * Pure functions — no network, no KV — mirroring `dispatch.ts`'s existing hosted-only
 * decision helpers, which this module was deliberately shaped to match.
 */

import { describe, expect, it } from 'vitest';

import { checkNetworkCap, checkTierEntitlement, SOLO_NETWORK_CAP } from '../../src/hosted-transport/tier-gate.js';
import { META_NETWORK } from '../../src/hosted-transport/dispatch.js';

describe('checkTierEntitlement', () => {
  it('refuses tier "none"', () => {
    const refusal = checkTierEntitlement('none');
    expect(refusal).toBeDefined();
    expect(refusal?.error).toBe('entitlement_required');
    expect(refusal?.entitled).toBe(false);
    expect(refusal?.tier).toBe('none');
  });

  it('allows tier "solo"', () => {
    expect(checkTierEntitlement('solo')).toBeUndefined();
  });

  it('allows tier "pro"', () => {
    expect(checkTierEntitlement('pro')).toBeUndefined();
  });
});

describe('checkNetworkCap', () => {
  it('never caps the pro tier, regardless of how many networks are connected', () => {
    const many = Array.from({ length: 20 }, (_, i) => `network-${i}`);
    expect(checkNetworkCap('pro', 'new-network', many)).toBeUndefined();
  });

  it('never caps meta tools', () => {
    const atCap = Array.from({ length: SOLO_NETWORK_CAP }, (_, i) => `network-${i}`);
    expect(checkNetworkCap('solo', META_NETWORK, atCap)).toBeUndefined();
  });

  it('allows a solo caller under the cap to connect a new network', () => {
    expect(checkNetworkCap('solo', 'awin', ['cj', 'impact'])).toBeUndefined();
  });

  it('allows a solo caller at the cap to keep using an already-connected network', () => {
    const atCap = ['awin', 'cj', 'impact', 'rakuten', 'shareasale'];
    expect(atCap).toHaveLength(SOLO_NETWORK_CAP);
    expect(checkNetworkCap('solo', 'cj', atCap)).toBeUndefined();
  });

  it('refuses a solo caller at the cap trying to connect a new, sixth network', () => {
    const atCap = ['awin', 'cj', 'impact', 'rakuten', 'shareasale'];
    const refusal = checkNetworkCap('solo', 'admitad', atCap);
    expect(refusal).toBeDefined();
    expect(refusal?.error).toBe('network_cap_exceeded');
    expect(refusal?.tier).toBe('solo');
    expect(refusal?.message).toContain('admitad');
  });

  it('allows a solo caller with fewer than the cap even when the network is new', () => {
    expect(checkNetworkCap('solo', 'awin', [])).toBeUndefined();
  });
});
