/**
 * Validate the shipped Kwanko advertiser network.json against the canonical
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
  'kwanko-advertiser',
  'network.json',
);

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

const MANDATORY_LIMITATION =
  'Adapter built from public API documentation; not yet verified against a live account.';

describe('Kwanko advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = loadManifest();
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser, credential_scope=multi-brand, supports_brand_ops=true', () => {
    const raw = loadManifest() as {
      side: string;
      credential_scope: string;
      supports_brand_ops: boolean;
    };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });

  it('lists the mandatory unverified limitation first and a read-only limitation', () => {
    const raw = loadManifest() as { known_limitations: string[] };
    expect(raw.known_limitations[0]).toBe(MANDATORY_LIMITATION);
    expect(raw.known_limitations.some((l) => /read-only/i.test(l))).toBe(true);
  });

  it('pins the expected manifest scalars', () => {
    const raw = loadManifest() as Record<string, unknown>;
    expect(raw['slug']).toBe('kwanko-advertiser');
    expect(raw['name']).toBe('Kwanko (advertiser)');
    expect(raw['base_url']).toBe('https://api.kwanko.com');
    expect(raw['auth_model']).toBe('bearer');
    expect(raw['claim_status']).toBe('experimental');
    expect(raw['adapter_version']).toBe('0.1.0');
    expect(raw['env_vars']).toEqual(['KWANKO_ADVERTISER_API_TOKEN']);
  });
});
