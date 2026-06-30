/**
 * Awin production-claim guard.
 *
 * Why this test exists: Awin (publisher) was promoted from `partial` to
 * `production` under the promotion gate. Two things must not silently regress
 * afterwards:
 *   1. The runtime META and the shipped manifest must agree that the claim is
 *      `production` — they are edited in two places and drift is easy to miss.
 *   2. The honest-claim disclosures the gate required (no click data; live
 *      commission-status mapping not yet evidenced against a high-activity
 *      account) must stay visible. Dropping them would turn an honest
 *      production claim into an overclaim.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { awinAdapter } from '../../../src/networks/awin/adapter.js';

describe('Awin production claim', () => {
  it('declares production in both the runtime META and the shipped manifest', () => {
    expect(awinAdapter.meta.claimStatus).toBe('production');

    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'awin', 'network.json'),
        'utf8',
      ),
    ) as { claim_status: string };
    expect(manifest.claim_status).toBe('production');
  });

  it('keeps the honest-claim disclosures visible at production', () => {
    const limitations = awinAdapter.meta.knownLimitations ?? [];
    // No click-level data from the public publisher API.
    expect(limitations.some((l) => /listClicks is unsupported/i.test(l))).toBe(true);
    // Live commission-status mapping is not yet evidenced.
    expect(limitations.some((l) => /not yet evidenced/i.test(l))).toBe(true);
  });
});
