/**
 * Validate the shipped Impact advertiser network.json against the canonical
 * schema. Mirrors `tests/networks/impact/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Impact advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'impact-advertiser', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser and credential_scope=multi-brand', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'impact-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { side: string; credential_scope: string; supports_brand_ops: boolean };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });
});
