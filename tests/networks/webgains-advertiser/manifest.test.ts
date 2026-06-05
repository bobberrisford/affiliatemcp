/**
 * Validate the shipped Webgains advertiser network.json against the canonical
 * schema. Mirrors `tests/networks/impact-advertiser/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

const MANIFEST = path.join(
  process.cwd(),
  'src',
  'networks',
  'webgains-advertiser',
  'network.json',
);

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

describe('Webgains advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(readManifest());
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser and credential_scope=multi-brand', () => {
    const raw = readManifest() as {
      side: string;
      credential_scope: string;
      supports_brand_ops: boolean;
    };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });

  it('leads with the mandatory unverified-account limitation', () => {
    const raw = readManifest() as { known_limitations: string[] };
    expect(raw.known_limitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
    // A read-only entry must be present.
    expect(raw.known_limitations.some((l) => /read-only/i.test(l))).toBe(true);
  });
});
