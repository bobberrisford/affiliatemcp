/**
 * Validate the shipped CJ advertiser network.json against the canonical
 * schema. Mirrors `tests/networks/impact-advertiser/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('CJ advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'cj-advertiser', 'network.json'),
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
        path.join(process.cwd(), 'src', 'networks', 'cj-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { side: string; credential_scope: string; supports_brand_ops: boolean };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });

  it('declares bearer auth and the CJ_ADVERTISER_API_TOKEN env var', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'cj-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { auth_model: string; env_vars: string[]; base_url: string };
    expect(raw.auth_model).toBe('bearer');
    expect(raw.env_vars).toContain('CJ_ADVERTISER_API_TOKEN');
    expect(raw.base_url).toBe('https://commissions.api.cj.com');
  });
});
