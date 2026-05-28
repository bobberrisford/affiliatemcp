/**
 * Validate the shipped Everflow advertiser network.json against the canonical
 * schema. Mirrors tests/networks/impact-advertiser/manifest.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

const manifestPath = path.join(
  process.cwd(),
  'src',
  'networks',
  'everflow-advertiser',
  'network.json',
);

function loadManifest(): unknown {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

describe('Everflow advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = loadManifest();
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser and credential_scope=multi-brand', () => {
    const raw = loadManifest() as {
      side: string;
      credential_scope: string;
      supports_brand_ops: boolean;
    };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
  });

  it('uses auth_model=custom (X-Eflow-API-Key header)', () => {
    const raw = loadManifest() as { auth_model: string };
    expect(raw.auth_model).toBe('custom');
  });

  it('declares the correct env vars', () => {
    const raw = loadManifest() as { env_vars: string[] };
    expect(raw.env_vars).toContain('EVERFLOW_API_KEY');
    expect(raw.env_vars).toContain('EVERFLOW_ADVERTISER_ID');
  });

  it('includes the required known-limitations string about live verification', () => {
    const raw = loadManifest() as { known_limitations: string[] };
    const hasVerificationNote = raw.known_limitations.some((l) =>
      l.includes('not yet verified against a live account'),
    );
    expect(hasVerificationNote).toBe(true);
  });

  it('uses last_verified date format YYYY-MM-DD', () => {
    const raw = loadManifest() as { last_verified: string };
    expect(raw.last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses claim_status=experimental (appropriate for unverified adapter)', () => {
    const raw = loadManifest() as { claim_status: string };
    expect(raw.claim_status).toBe('experimental');
  });

  it('has a valid base_url pointing to eflow.team', () => {
    const raw = loadManifest() as { base_url: string };
    expect(raw.base_url).toContain('eflow.team');
    expect(() => new URL(raw.base_url)).not.toThrow();
  });

  it('has a valid docs_url', () => {
    const raw = loadManifest() as { docs_url?: string };
    if (raw.docs_url) {
      const docsUrl = raw.docs_url;
      expect(() => new URL(docsUrl)).not.toThrow();
      expect(docsUrl).toContain('everflow.io');
    }
  });
});
