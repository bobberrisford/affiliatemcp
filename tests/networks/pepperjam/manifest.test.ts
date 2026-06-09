/**
 * Validate the shipped Pepperjam network.json against the canonical schema.
 *
 * Mirror of `tests/networks/everflow/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

function loadManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'networks', 'pepperjam', 'network.json'), 'utf8'),
  );
}

describe('Pepperjam network.json', () => {
  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(loadManifest());
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares auth_model as custom (apiKey query param)', () => {
    expect(loadManifest().auth_model).toBe('custom');
  });

  it('declares side publisher and single-brand credential scope', () => {
    const m = loadManifest();
    expect(m.side).toBe('publisher');
    expect(m.credential_scope).toBe('single-brand');
    expect(m.supports_brand_ops).toBe(false);
  });

  it('carries the mandated experimental, amount-unit and distinct-from-partnerize limitations', () => {
    const limits = loadManifest().known_limitations as string[];
    expect(limits.some((l) => l.toLowerCase().includes('experimental'))).toBe(true);
    expect(limits.some((l) => l.toLowerCase().includes('major currency units'))).toBe(true);
    expect(limits.some((l) => l.toLowerCase().includes('partnerize'))).toBe(true);
  });

  it('uses the Pepperjam env var and base URL', () => {
    const m = loadManifest();
    expect(m.env_vars).toEqual(['PEPPERJAM_API_KEY']);
    expect(m.base_url).toBe('https://api.pepperjamnetwork.com');
  });
});
