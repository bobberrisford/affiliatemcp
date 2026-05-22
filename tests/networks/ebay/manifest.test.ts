/**
 * Validate the shipped eBay network.json against the canonical schema.
 *
 * Mirrors tests/networks/awin/manifest.test.ts. Drifts between
 * `src/networks/ebay/network.json` and the Zod schema in
 * `scripts/validate-network-json.ts` are caught here at CI time.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('eBay network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'ebay', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });
});
