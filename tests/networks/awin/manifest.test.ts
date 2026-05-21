/**
 * Validate the shipped Awin network.json against the canonical schema.
 *
 * Why this test exists: drifts between `src/networks/awin/network.json` and
 * the Zod schema in `scripts/validate-network-json.ts` are easy to miss —
 * the manifest is loaded at runtime by tooling, not by TypeScript. This test
 * catches them at CI time.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Awin network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'awin', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      // Surface the issues so the CI log is useful.
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });
});
