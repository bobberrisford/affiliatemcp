import { describe, expect, it } from 'vitest';

import { validPayload } from '../../telemetry-cloudflare/src/schema.js';

const valid = {
  schema_version: 1,
  day: '2026-06-11',
  monthly_install_id: '9b874b35-8b7d-4da7-8058-7f340d5f5c0a',
  package_version: '0.6.6',
  surface: 'npm',
  counts: [{ network: 'awin', operation: 'list_transactions', outcome: 'success', count: 2 }],
};

describe('Cloudflare telemetry payload schema', () => {
  it('accepts the documented allowlisted shape', () => {
    expect(validPayload(valid)).toBe(true);
  });

  it('accepts schema v2 fine-grained outcomes and keeps each version to its own vocabulary', () => {
    const v2Outcomes = [
      'not_implemented',
      'timeout',
      'circuit_open',
      'network_unavailable',
      'upstream_4xx',
      'upstream_5xx',
      'internal_error',
    ];
    for (const outcome of v2Outcomes) {
      const counts = [{ ...valid.counts[0], outcome }];
      expect(validPayload({ ...valid, schema_version: 2, counts })).toBe(true);
      // A v1 client never emits these; a payload claiming v1 with them is invalid.
      expect(validPayload({ ...valid, counts })).toBe(false);
    }
    // Legacy v1 outcomes remain valid under both versions.
    expect(validPayload({ ...valid, schema_version: 2 })).toBe(true);
    expect(validPayload({ ...valid, schema_version: 3 })).toBe(false);
  });

  it('rejects unknown fields and sensitive-looking free text', () => {
    expect(validPayload({ ...valid, prompt: 'show my earnings' })).toBe(false);
    expect(
      validPayload({
        ...valid,
        counts: [{ ...valid.counts[0], operation: 'error: token rejected for account 123' }],
      }),
    ).toBe(false);
  });

  it('rejects unknown outcomes, surfaces, oversized counts, and empty summaries', () => {
    expect(validPayload({ ...valid, surface: 'darwin' })).toBe(false);
    expect(validPayload({ ...valid, counts: [{ ...valid.counts[0], outcome: 'HTTP 401' }] })).toBe(
      false,
    );
    expect(validPayload({ ...valid, counts: [{ ...valid.counts[0], count: 1_000_001 }] })).toBe(
      false,
    );
    expect(validPayload({ ...valid, counts: [] })).toBe(false);
    expect(validPayload({ ...valid, day: '2026-99-99' })).toBe(false);
  });
});
