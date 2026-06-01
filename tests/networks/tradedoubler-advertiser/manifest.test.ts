/**
 * Validate the shipped Tradedoubler advertiser network.json against the
 * canonical schema. Mirrors tests/networks/impact-advertiser/manifest.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Tradedoubler advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          'src',
          'networks',
          'tradedoubler-advertiser',
          'network.json',
        ),
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
        path.join(
          process.cwd(),
          'src',
          'networks',
          'tradedoubler-advertiser',
          'network.json',
        ),
        'utf8',
      ),
    ) as { side: string; credential_scope: string; supports_brand_ops: boolean };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    // supports_brand_ops is false at v0.1 (listPublishers / listPublisherSectors not yet implemented).
    expect(raw.supports_brand_ops).toBe(false);
  });

  it('includes the mandatory not-yet-verified limitation string', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          'src',
          'networks',
          'tradedoubler-advertiser',
          'network.json',
        ),
        'utf8',
      ),
    ) as { known_limitations: string[] };
    const hasVerificationNote = raw.known_limitations.some((l) =>
      l.includes('not yet verified against a live account'),
    );
    expect(hasVerificationNote).toBe(true);
  });

  it('uses auth_model=custom (token-in-query-string)', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          'src',
          'networks',
          'tradedoubler-advertiser',
          'network.json',
        ),
        'utf8',
      ),
    ) as { auth_model: string };
    expect(raw.auth_model).toBe('custom');
  });

  it('has adapter_version 0.1.0 and claim_status experimental', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          'src',
          'networks',
          'tradedoubler-advertiser',
          'network.json',
        ),
        'utf8',
      ),
    ) as { adapter_version: string; claim_status: string };
    expect(raw.adapter_version).toBe('0.1.0');
    expect(raw.claim_status).toBe('experimental');
  });
});
