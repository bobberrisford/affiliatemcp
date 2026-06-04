/**
 * Validate the shipped Daisycon network.json against the canonical schema.
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
      path.join(process.cwd(), 'src', 'networks', 'daisycon', 'network.json'),
      'utf8',
    ),
  );
}

describe('Daisycon network.json', () => {
  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(loadManifest());
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Daisycon-specific fields set correctly', () => {
    const raw = loadManifest();
    expect(raw.slug).toBe('daisycon');
    expect(raw.auth_model).toBe('oauth2');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-06-04');
    // Env vars must include the OAuth credential fields and the publisher id.
    expect(raw.env_vars).toContain('DAISYCON_CLIENT_ID');
    expect(raw.env_vars).toContain('DAISYCON_CLIENT_SECRET');
    expect(raw.env_vars).toContain('DAISYCON_PUBLISHER_ID');
    // The mandatory "built from public docs" limitation must be present, first.
    const limitations = raw.known_limitations as string[];
    expect(limitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
    expect(
      limitations.some((s) => s.includes('not yet verified against a live account')),
    ).toBe(true);
  });
});
