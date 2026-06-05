/**
 * Validate the shipped Coupang Partners network.json against the canonical schema.
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
      path.join(process.cwd(), 'src', 'networks', 'coupang-partners', 'network.json'),
      'utf8',
    ),
  );
}

describe('Coupang Partners network.json', () => {
  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(loadManifest());
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required Coupang Partners-specific fields set correctly', () => {
    const raw = loadManifest();
    expect(raw.slug).toBe('coupang-partners');
    expect(raw.name).toBe('Coupang Partners');
    expect(raw.base_url).toBe('https://api-gateway.coupang.com');
    expect(raw.auth_model).toBe('custom');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.supports_brand_ops).toBe(false);
    expect(raw.setup_requires_approval).toBe(false);
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toBe('2026-06-04');
    expect(raw.docs_url).toBe(
      'https://partner-developers.coupangcorp.com/hc/ko/categories/360005470572-API-Docs',
    );
  });

  it('declares both HMAC credential env vars', () => {
    const raw = loadManifest();
    expect(raw.env_vars).toContain('COUPANG_PARTNERS_ACCESS_KEY');
    expect(raw.env_vars).toContain('COUPANG_PARTNERS_SECRET_KEY');
  });

  it('leads with the mandatory unverified limitation and notes the rate limits', () => {
    const limitations = loadManifest().known_limitations as string[];
    expect(limitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
    expect(limitations.some((s) => /rate limit/i.test(s))).toBe(true);
  });
});
