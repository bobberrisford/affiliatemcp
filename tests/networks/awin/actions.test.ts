/**
 * Awin publisher programme-application emitter tests.
 *
 * The emitter is PURE: it builds an ApiGapResponse carrying a typed
 * BrowserHandoff and never calls fetch, the client, or auth. These tests assert
 * purity, the API-gap shape, constraint-floor inheritance, no-secrets in inputs
 * (and specifically no terms evidence in the pure payload, per decision §2), a
 * constant Awin-owned startingUrl that ignores hostile input, and the descriptor
 * invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awinActionDescriptors,
  buildApplyToProgrammeHandoff,
  _internals,
} from '../../../src/networks/awin/actions.js';
import { BROWSER_CONSTRAINT_FLOOR } from '../../../src/shared/browser-handoff.js';

const baseInput = {
  publisherId: '555',
  advertiserId: '1234',
  programmeName: 'Example Brand',
  brand: 'example-brand',
};

describe('Awin publisher programme-application emitter', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    // The emitter must never reach the network. Replace global fetch with a spy
    // and assert it stays untouched.
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it('is pure: building a handoff calls no fetch', () => {
    buildApplyToProgrammeHandoff(baseInput);
    buildApplyToProgrammeHandoff({ ...baseInput, promotionMethodSummary: 'content + email' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an api-gap with a non-null mutating browser handoff and structured verify', () => {
    const response = buildApplyToProgrammeHandoff(baseInput);
    expect(response.kind).toBe('api-gap');
    expect(response.network).toBe('awin');
    expect(response.operation).toBe('applyToProgramme');
    expect(response.reason).toBe('Awin has no public publisher programme-application endpoint');
    expect(response.userMessage.length).toBeGreaterThan(0);
    const handoff = response.browserFallback;
    expect(handoff).not.toBeNull();
    if (!handoff) throw new Error('expected a browser fallback');
    expect(handoff.mutates).toBe(true);
    // verify.url is the publisher's own pending-applications list.
    expect(handoff.verify.url).toBe(_internals.pendingApplicationsUrl('555'));
    expect(handoff.verify.url).toBe(
      'https://ui.awin.com/awin/affiliate/555/merchant-directory/index/tab/pending/page/1',
    );
    expect(handoff.verify.expect).toContain('1234');
  });

  it('builds startingUrl as the per-advertiser programme-detail page in the operator account', () => {
    const handoff = buildApplyToProgrammeHandoff(baseInput).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    expect(handoff.startingUrl).toBe(_internals.programmeDetailUrl('555', '1234'));
    expect(handoff.startingUrl).toBe(
      'https://ui.awin.com/awin/affiliate/555/merchant-profile/1234',
    );
  });

  it('inherits every line of the shared constraint floor, then the Awin additions', () => {
    const handoff = buildApplyToProgrammeHandoff(baseInput).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    // Floor is present, in order, as the leading slice.
    expect(handoff.constraints.slice(0, BROWSER_CONSTRAINT_FLOOR.length)).toEqual([
      ...BROWSER_CONSTRAINT_FLOOR,
    ]);
    // The floor's terms rule is present: the consumer must surface terms.
    expect(
      handoff.constraints.some((c) => c.includes('Never accept terms')),
    ).toBe(true);
    // Awin-specific additions follow the floor.
    expect(handoff.constraints.some((c) => c.includes('only to advertiser 1234'))).toBe(true);
    expect(handoff.constraints.some((c) => c.includes('joinable'))).toBe(true);
    expect(handoff.constraints.some((c) => c.includes('commercial terms'))).toBe(true);
    expect(handoff.constraints.some((c) => c.includes('hand back'))).toBe(true);
    expect(handoff.constraints.length).toBe(BROWSER_CONSTRAINT_FLOOR.length + 4);
  });

  it('carries no secrets and no terms evidence in inputs, and keeps startingUrl on the Awin origin', () => {
    const handoff = buildApplyToProgrammeHandoff({
      ...baseInput,
      promotionMethodSummary: 'cashback site',
    }).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    const keys = Object.keys(handoff.inputs).map((k) => k.toLowerCase());
    for (const banned of ['token', 'cookie', 'session', 'secret', 'password', 'auth']) {
      expect(keys.some((k) => k.includes(banned))).toBe(false);
    }
    // Decision §2: terms evidence is NOT in the pure emitter payload.
    for (const termsKey of ['terms', 'termsseen', 'termsdigest', 'restrictions']) {
      expect(keys).not.toContain(termsKey);
    }
    expect(handoff.inputs).toMatchObject({
      advertiserId: '1234',
      programmeName: 'Example Brand',
      brand: 'example-brand',
      promotionMethodSummary: 'cashback site',
    });
    expect(handoff.startingUrl.startsWith('https://ui.awin.com')).toBe(true);
    // publisherId is used to scope the URLs, never echoed as a handoff input.
    expect(Object.keys(handoff.inputs)).not.toContain('publisherId');
  });

  it('builds URLs from input, ignoring a hostile startingUrl and staying on the Awin origin', () => {
    const hostile = {
      ...baseInput,
      startingUrl: 'https://evil.example/phish',
    } as unknown as typeof baseInput;
    const handoff = buildApplyToProgrammeHandoff(hostile).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    // The emitter never reads a `startingUrl` field; it builds the URL itself.
    expect(handoff.startingUrl).toBe(_internals.programmeDetailUrl('555', '1234'));
    expect(handoff.startingUrl.startsWith('https://ui.awin.com/')).toBe(true);
    expect(handoff.startingUrl).not.toContain('evil.example');
    expect(handoff.verify.url).not.toContain('evil.example');
    expect(Object.keys(handoff.inputs)).not.toContain('startingUrl');
  });

  it('percent-encodes ids so a non-numeric value cannot inject a path or escape the origin', () => {
    const handoff = buildApplyToProgrammeHandoff({
      ...baseInput,
      advertiserId: '../../evil',
    }).browserFallback;
    if (!handoff) throw new Error('expected a browser fallback');
    expect(handoff.startingUrl.startsWith('https://ui.awin.com/awin/affiliate/555/')).toBe(true);
    expect(handoff.startingUrl).not.toContain('../');
  });

  it('declares one browser/write descriptor with the expected invariants', () => {
    expect(awinActionDescriptors.map((d) => d.id)).toEqual(['awin.applyToProgramme']);
    const descriptor = awinActionDescriptors[0];
    if (!descriptor) throw new Error('descriptor missing');
    expect(descriptor.network).toBe('awin');
    expect(descriptor.channel).toBe('browser');
    expect(descriptor.effect).toBe('write');
    expect(descriptor.defaultAuthorityTier).toBe(3);
    expect(descriptor.credentialRequirements).toEqual([
      { label: 'AWIN_API_TOKEN' },
      { label: 'AWIN_PUBLISHER_ID' },
    ]);
  });
});
