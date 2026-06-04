/**
 * Validate the shipped Afilio network.json against the canonical schema.
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
    readFileSync(path.join(process.cwd(), 'src', 'networks', 'afilio', 'network.json'), 'utf8'),
  );
}

describe('Afilio network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = loadManifest();
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Afilio-specific fields set correctly', () => {
    const raw = loadManifest();
    expect(raw.slug).toBe('afilio');
    expect(raw.name).toBe('Afilio');
    expect(raw.base_url).toBe('https://v2.afilio.com.br');
    expect(raw.auth_model).toBe('custom');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.setup_requires_approval).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-06-04');
    expect(raw.docs_url).toBe('https://v2.afilio.com.br/Manual/manuais-v2.html');
    // Env vars must include both credential fields.
    expect(raw.env_vars).toContain('AFILIO_AFFILIATE_TOKEN');
    expect(raw.env_vars).toContain('AFILIO_AFF_ID');
  });

  it('every env var matches the strict ^[A-Z][A-Z0-9_]*$ shape', () => {
    const raw = loadManifest();
    for (const v of raw.env_vars as string[]) {
      expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('known_limitations leads with the mandatory not-yet-verified statement', () => {
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
