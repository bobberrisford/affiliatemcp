/**
 * Validate the shipped Offer18 network.json against the canonical schema.
 *
 * Mirror of `tests/networks/everflow/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

function loadManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'networks', 'offer18', 'network.json'), 'utf8'),
  );
}

describe('Offer18 network.json', () => {
  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(loadManifest());
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required experimental known_limitations entry', () => {
    const raw = loadManifest();
    expect(raw.known_limitations).toContain(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
  });

  it('records the per-tenant base URL limitation', () => {
    const raw = loadManifest() as { known_limitations: string[] };
    expect(raw.known_limitations.some((l) => l.includes('OFFER18_BASE_URL'))).toBe(true);
  });

  it('records the amount-unit assumption', () => {
    const raw = loadManifest() as { known_limitations: string[] };
    expect(raw.known_limitations.some((l) => l.toLowerCase().includes('amount unit'))).toBe(true);
  });

  it('declares auth_model as custom', () => {
    expect(loadManifest().auth_model).toBe('custom');
  });

  it('declares side as publisher and credential_scope as single-brand', () => {
    const raw = loadManifest();
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
  });

  it('lists every credential env var', () => {
    const raw = loadManifest() as { env_vars: string[] };
    expect(raw.env_vars).toEqual([
      'OFFER18_BASE_URL',
      'OFFER18_API_KEY',
      'OFFER18_SECRET_KEY',
      'OFFER18_MID',
    ]);
  });
});
