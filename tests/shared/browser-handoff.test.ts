/**
 * Browser-handoff contract: constraint floor composition and payload
 * round-trip. See docs/decisions/2026-06-12-browser-handoff-contract.md.
 *
 * The type contract itself is enforced at build time by `npm run typecheck`;
 * these tests pin the runtime behaviour the floor and the payload promise.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_CONSTRAINT_FLOOR, composeConstraints } from '../../src/shared/browser-handoff.js';
import type { ApiGapResponse, BrowserHandoff } from '../../src/shared/types.js';

describe('browser-handoff constraint floor', () => {
  it('places the full floor first, in order, followed by the per-action additions', () => {
    const composed = composeConstraints(['x']);
    // The leading slice is exactly the floor, in order.
    expect(composed.slice(0, BROWSER_CONSTRAINT_FLOOR.length)).toEqual([
      ...BROWSER_CONSTRAINT_FLOOR,
    ]);
    // The per-action addition follows the floor.
    expect(composed[composed.length - 1]).toBe('x');
    expect(composed).toHaveLength(BROWSER_CONSTRAINT_FLOOR.length + 1);
  });

  it('includes every floor rule in the composed output (superset check)', () => {
    const composed = composeConstraints(['only-addition']);
    for (const rule of BROWSER_CONSTRAINT_FLOOR) {
      expect(composed).toContain(rule);
    }
  });

  it('returns just the floor when there are no per-action additions', () => {
    expect(composeConstraints([])).toEqual([...BROWSER_CONSTRAINT_FLOOR]);
  });
});

describe('browser-handoff payload round-trip', () => {
  it('a BrowserHandoff survives JSON round-trip unchanged', () => {
    const handoff: BrowserHandoff = {
      goal: 'Apply to programme 12345 on Impact',
      startingUrl: 'https://app.impact.com/secure/mediapartner/apply/12345',
      inputs: { programmeId: '12345', promotionalMethods: ['blog', 'email'] },
      constraints: composeConstraints(['Stop if the apply button is missing.']),
      mutates: true,
      verify: { url: 'https://app.impact.com/secure/mediapartner/contracts', expect: 'pending' },
      hints: ['The apply button is in the top-right of the programme page.'],
    };
    expect(JSON.parse(JSON.stringify(handoff))).toEqual(handoff);
  });

  it('an ApiGapResponse with a non-null fallback survives JSON round-trip unchanged', () => {
    const response: ApiGapResponse = {
      kind: 'api-gap',
      network: 'impact-advertiser',
      operation: 'applyToProgram',
      reason: 'Impact exposes no API endpoint to apply to a programme.',
      userMessage:
        'Impact does not let me apply to this programme through its API. I can hand you a guided browser flow instead.',
      browserFallback: {
        goal: 'Apply to programme 12345 on Impact',
        startingUrl: 'https://app.impact.com/secure/mediapartner/apply/12345',
        inputs: { programmeId: '12345' },
        constraints: composeConstraints([]),
        mutates: true,
        verify: { expect: 'pending' },
      },
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('an ApiGapResponse with a null fallback survives JSON round-trip unchanged', () => {
    const response: ApiGapResponse = {
      kind: 'api-gap',
      network: 'impact-advertiser',
      operation: 'applyToProgram',
      reason: 'Impact exposes no API endpoint to apply to a programme.',
      userMessage:
        'Impact does not let me apply to this programme through its API, and I do not have a browser route for it yet.',
      browserFallback: null,
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });
});
