/**
 * Validate the shipped Everflow network.json against the canonical schema.
 *
 * Mirror of `tests/networks/cj/manifest.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

describe('Everflow network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'everflow', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) {
      throw new Error(JSON.stringify(r.error.issues, null, 2));
    }
  });

  it('has the required known_limitations entry', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'everflow', 'network.json'),
        'utf8',
      ),
    );
    expect(raw.known_limitations).toContain(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
  });

  it('declares auth_model as custom', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'everflow', 'network.json'),
        'utf8',
      ),
    );
    expect(raw.auth_model).toBe('custom');
  });

  it('declares side as publisher', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'everflow', 'network.json'),
        'utf8',
      ),
    );
    expect(raw.side).toBe('publisher');
  });
});
