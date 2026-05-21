/**
 * Validate the shipped Impact network.json against the canonical schema.
 *
 * Drifts between `src/networks/impact/network.json` and the Zod schema in
 * `scripts/validate-network-json.ts` are easy to miss — the manifest is
 * loaded at runtime by tooling, not by TypeScript. This test catches them
 * at CI time.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Impact network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'impact', 'network.json'),
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
