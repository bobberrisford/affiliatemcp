/**
 * Validate the Partnerize advertiser network.json against the canonical schema.
 * Mirrors tests/networks/impact-advertiser/manifest.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Partnerize advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('declares side=advertiser and credential_scope=multi-brand', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { side: string; credential_scope: string; supports_brand_ops: boolean };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
  });

  it('declares the correct env_vars', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { env_vars: string[] };
    expect(raw.env_vars).toContain('PARTNERIZE_APPLICATION_KEY');
    expect(raw.env_vars).toContain('PARTNERIZE_USER_API_KEY');
  });

  it('has claim_status=experimental and adapter_version=0.1.0', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { claim_status: string; adapter_version: string; last_verified: string };
    expect(raw.claim_status).toBe('experimental');
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('includes the mandatory live-verification limitation string', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { known_limitations: string[] };
    const verificationNote = raw.known_limitations.find((l) =>
      l.includes('not yet verified against a live account'),
    );
    expect(verificationNote).toBeTruthy();
  });

  it('has a valid docs_url', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'partnerize-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { docs_url?: string };
    expect(raw.docs_url).toBeTruthy();
    expect(() => new URL(raw.docs_url as string)).not.toThrow();
  });
});
