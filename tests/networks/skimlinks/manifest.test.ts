/**
 * Validate the shipped Skimlinks network.json against the canonical schema.
 *
 * Mirror of `tests/networks/cj/manifest.test.ts` — drift between the manifest
 * and the Zod schema is easy to miss because the manifest is loaded at runtime
 * by tooling rather than checked by TypeScript.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Skimlinks network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'skimlinks', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Skimlinks-specific fields set correctly', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'skimlinks', 'network.json'),
        'utf8',
      ),
    );
    expect(raw.slug).toBe('skimlinks');
    expect(raw.auth_model).toBe('oauth2');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-05-28');
    // Env vars must include all three credential fields.
    expect(raw.env_vars).toContain('SKIMLINKS_CLIENT_ID');
    expect(raw.env_vars).toContain('SKIMLINKS_CLIENT_SECRET');
    expect(raw.env_vars).toContain('SKIMLINKS_PUBLISHER_ID');
    // known_limitations must include the mandatory "built from public docs" string.
    expect(
      (raw.known_limitations as string[]).some((s: string) =>
        s.includes('not yet verified against a live account'),
      ),
    ).toBe(true);
  });
});
