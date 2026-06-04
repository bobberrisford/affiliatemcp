/**
 * Validate the shipped Kwanko network.json against the canonical schema.
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
      path.join(process.cwd(), 'src', 'networks', 'kwanko', 'network.json'),
      'utf8',
    ),
  );
}

describe('Kwanko network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = loadManifest();
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Kwanko-specific fields set correctly', () => {
    const raw = loadManifest();
    expect(raw.slug).toBe('kwanko');
    expect(raw.name).toBe('Kwanko');
    expect(raw.base_url).toBe('https://api.kwanko.com');
    expect(raw.auth_model).toBe('bearer');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.setup_requires_approval).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-06-04');
    expect(raw.docs_url).toBe('https://developers.kwanko.com/');
    // Env var must be present and match the credential the adapter reads.
    expect(raw.env_vars).toContain('KWANKO_API_TOKEN');
  });

  it('lists the mandatory "not yet verified" limitation FIRST', () => {
    const raw = loadManifest();
    const limitations = raw.known_limitations as string[];
    expect(limitations.length).toBeGreaterThan(0);
    expect(limitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
  });
});
