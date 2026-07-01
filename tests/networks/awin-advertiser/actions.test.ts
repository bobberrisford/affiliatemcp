/**
 * Awin advertiser publisher-decision emitter tests.
 *
 * The emitters are PURE: they build an ApiGapResponse carrying a typed
 * BrowserHandoff and never call fetch, the client, or auth. These tests assert
 * purity, the API-gap shape, constraint-floor inheritance, no-secrets in inputs,
 * a constant Awin-owned startingUrl that ignores hostile input, and the
 * descriptor invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awinAdvertiserActionDescriptors,
  buildApprovePublisherHandoff,
  buildDeclinePublisherHandoff,
  _internals,
} from '../../../src/networks/awin-advertiser/actions.js';
import { BROWSER_CONSTRAINT_FLOOR } from '../../../src/shared/browser-handoff.js';

const baseInput = {
  brand: 'acme',
  programmeId: 'prog-1',
  publisherId: '12345',
  publisherName: 'Cashback Co',
};

describe('Awin advertiser publisher-decision emitters', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    // The emitters must never reach the network. Replace global fetch with a spy
    // and assert it stays untouched.
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it('is pure: building a handoff calls no fetch', () => {
    buildApprovePublisherHandoff(baseInput);
    buildDeclinePublisherHandoff({ ...baseInput, declineReason: 'low quality' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an api-gap with a non-null mutating browser handoff and structured verify', () => {
    for (const response of [
      buildApprovePublisherHandoff(baseInput),
      buildDeclinePublisherHandoff(baseInput),
    ]) {
      expect(response.kind).toBe('api-gap');
      expect(response.network).toBe('awin-advertiser');
      expect(response.reason).toBe('Awin has no public publisher approve/decline endpoint');
      expect(response.userMessage.length).toBeGreaterThan(0);
      const handoff = response.browserFallback;
      expect(handoff).not.toBeNull();
      if (!handoff) throw new Error('expected a browser fallback');
      expect(handoff.mutates).toBe(true);
      expect(handoff.verify.url).toBe(_internals.partnershipsAllUrl(baseInput.programmeId));
      expect(typeof handoff.verify.expect).toBe('string');
      expect(handoff.verify.expect).toContain('12345');
    }
  });

  it('names approve vs decline as the operation', () => {
    expect(buildApprovePublisherHandoff(baseInput).operation).toBe('approvePublisher');
    expect(buildDeclinePublisherHandoff(baseInput).operation).toBe('declinePublisher');
  });

  it('inherits every line of the shared constraint floor, then the Awin additions', () => {
    const handoff = buildApprovePublisherHandoff(baseInput).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    // Floor is present, in order, as the leading slice.
    expect(handoff.constraints.slice(0, BROWSER_CONSTRAINT_FLOOR.length)).toEqual([
      ...BROWSER_CONSTRAINT_FLOOR,
    ]);
    for (const floorRule of BROWSER_CONSTRAINT_FLOOR) {
      expect(handoff.constraints).toContain(floorRule);
    }
    // Awin-specific additions follow the floor.
    expect(handoff.constraints.some((c) => c.includes('only on publisher 12345'))).toBe(true);
    expect(handoff.constraints.some((c) => c.includes('already be decided'))).toBe(true);
    expect(handoff.constraints.some((c) => c.includes('commission, payout, or contract'))).toBe(
      true,
    );
    expect(handoff.constraints.some((c) => c.includes('hand back to the user'))).toBe(true);
    expect(handoff.constraints.length).toBe(BROWSER_CONSTRAINT_FLOOR.length + 4);
  });

  it('carries no secrets in inputs and keeps startingUrl on the Awin origin', () => {
    const handoff = buildDeclinePublisherHandoff({
      ...baseInput,
      declineReason: 'out of category',
    }).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    const keys = Object.keys(handoff.inputs).map((k) => k.toLowerCase());
    for (const banned of ['token', 'cookie', 'session', 'secret', 'password', 'auth']) {
      expect(keys.some((k) => k.includes(banned))).toBe(false);
    }
    // The non-secret, JSON-serialisable fields are present.
    expect(handoff.inputs).toMatchObject({
      publisherId: '12345',
      publisherName: 'Cashback Co',
      decision: 'decline',
      brand: 'acme',
      programmeId: 'prog-1',
      declineReason: 'out of category',
    });
    expect(handoff.startingUrl.startsWith('https://app.awin.com')).toBe(true);
  });

  it('builds startingUrl from the fixed template and ignores a hostile startingUrl in input', () => {
    // startingUrl is NOT part of the input contract; a smuggled value must be
    // ignored. The emitted url is always built from the fixed origin/template
    // and the advertiser id, never from a caller-supplied startingUrl.
    const hostile = {
      ...baseInput,
      startingUrl: 'https://evil.example/phish',
    } as unknown as typeof baseInput;
    const handoff = buildApprovePublisherHandoff(hostile).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    expect(handoff.startingUrl).toBe(_internals.partnershipsAllUrl(baseInput.programmeId));
    expect(handoff.startingUrl).not.toContain('evil.example');
    expect(Object.keys(handoff.inputs)).not.toContain('startingUrl');
  });

  it('interpolates the advertiser id into the fixed partnerships URL template', () => {
    const handoff = buildApprovePublisherHandoff({ ...baseInput, programmeId: '74386' })
      .browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    expect(handoff.startingUrl).toBe(
      'https://app.awin.com/en/awin/advertiser/74386/partnerships/all',
    );
  });

  it('declares two browser/write descriptors with the expected invariants', () => {
    const ids = awinAdvertiserActionDescriptors.map((d) => d.id);
    expect(ids).toEqual([
      'awin-advertiser.approvePublisher',
      'awin-advertiser.declinePublisher',
    ]);
    for (const descriptor of awinAdvertiserActionDescriptors) {
      expect(descriptor.network).toBe('awin-advertiser');
      expect(descriptor.channel).toBe('browser');
      expect(descriptor.effect).toBe('write');
      expect(descriptor.defaultAuthorityTier).toBe(3);
      expect(descriptor.credentialRequirements).toEqual([{ label: 'AWIN_ADVERTISER_API_TOKEN' }]);
    }
  });
});
