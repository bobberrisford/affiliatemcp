/**
 * Validate the shipped Sovrn Commerce network.json against the canonical schema.
 *
 * Mirror of tests/networks/cj/manifest.test.ts — drift between the manifest
 * and the Zod schema is easy to miss because the manifest is loaded at runtime
 * by tooling rather than checked by TypeScript.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Sovrn Commerce network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'sovrn-commerce', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Sovrn Commerce fields', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'sovrn-commerce', 'network.json'),
        'utf8',
      ),
    );
    expect(raw.slug).toBe('sovrn-commerce');
    expect(raw.auth_model).toBe('custom');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.env_vars).toContain('SOVRN_SECRET_KEY');
    expect(raw.env_vars).toContain('SOVRN_API_KEY');
    expect(raw.known_limitations).toContain(
      'Adapter built from public API documentation; response field names confirmed from developer.sovrn.com but not yet verified against a live account.',
    );
    expect(raw.last_verified).toBe('2026-05-28');
  });
});
