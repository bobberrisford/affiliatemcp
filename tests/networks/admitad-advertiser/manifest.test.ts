/**
 * Validate the shipped Admitad advertiser network.json against the canonical
 * schema. Mirrors `tests/networks/impact-advertiser/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

const MANIFEST_PATH = path.join(
  process.cwd(),
  'src',
  'networks',
  'admitad-advertiser',
  'network.json',
);

const MANDATORY_LIMITATION =
  'Adapter built from public API documentation; not yet verified against a live account.';

describe('Admitad advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser, credential_scope=multi-brand, supports_brand_ops=true', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      side: string;
      credential_scope: string;
      supports_brand_ops: boolean;
    };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });

  it('carries the mandatory experimental limitation as the first entry', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      known_limitations: string[];
    };
    expect(raw.known_limitations[0]).toBe(MANDATORY_LIMITATION);
    // and a read-only limitation is present.
    expect(raw.known_limitations.some((l) => /read-only/i.test(l))).toBe(true);
  });
});
