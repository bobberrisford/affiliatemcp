/**
 * Validate the shipped ValueCommerce network.json against the canonical schema.
 *
 * Mirror of `tests/networks/skimlinks/manifest.test.ts` — drift between the
 * manifest and the Zod schema is easy to miss because the manifest is loaded at
 * runtime by tooling rather than checked by TypeScript.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

function loadManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'src', 'networks', 'value-commerce', 'network.json'),
      'utf8',
    ),
  );
}

describe('ValueCommerce network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = loadManifest();
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required ValueCommerce-specific fields set correctly', () => {
    const raw = loadManifest();
    expect(raw.slug).toBe('value-commerce');
    expect(raw.name).toBe('ValueCommerce');
    expect(raw.base_url).toBe('https://api.valuecommerce.com');
    expect(raw.auth_model).toBe('custom');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.setup_requires_approval).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-06-04');
    expect(raw.docs_url).toBe('https://pub-docs.valuecommerce.ne.jp/');
    // Env vars must include both credential fields.
    expect(raw.env_vars).toContain('VALUE_COMMERCE_CLIENT_KEY');
    expect(raw.env_vars).toContain('VALUE_COMMERCE_CLIENT_SECRET');
  });

  it('declares the mandatory "built from public docs" limitation first', () => {
    const raw = loadManifest();
    const limitations = raw.known_limitations as string[];
    expect(limitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
    expect(
      limitations.some((s) => s.includes('not yet verified against a live account')),
    ).toBe(true);
  });
});
