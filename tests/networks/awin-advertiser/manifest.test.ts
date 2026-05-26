/**
 * Validate the shipped Awin advertiser network.json against the canonical
 * schema. Mirrors `tests/networks/impact-advertiser/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Awin advertiser network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'awin-advertiser', 'network.json'),
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
        path.join(process.cwd(), 'src', 'networks', 'awin-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { side: string; credential_scope: string; supports_brand_ops: boolean };
    expect(raw.side).toBe('advertiser');
    expect(raw.credential_scope).toBe('multi-brand');
    expect(raw.supports_brand_ops).toBe(true);
  });

  it('declares oauth2 auth and the AWIN_ADVERTISER_API_TOKEN env var', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'awin-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { auth_model: string; env_vars: string[]; base_url: string };
    expect(raw.auth_model).toBe('oauth2');
    expect(raw.env_vars).toContain('AWIN_ADVERTISER_API_TOKEN');
    expect(raw.base_url).toBe('https://api.awin.com');
  });

  it('documents the 20-per-minute rate limit and the plan gate', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'awin-advertiser', 'network.json'),
        'utf8',
      ),
    ) as { known_limitations: string[] };
    const joined = raw.known_limitations.join('\n').toLowerCase();
    expect(joined).toMatch(/20\s+(api\s+)?calls\s+per\s+minute/);
    expect(joined).toMatch(/accelerate|advanced|entry|plan/);
    expect(joined).toContain('read-only');
  });
});
