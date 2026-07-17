import { afterEach, describe, expect, it } from 'vitest';
import { computeReadiness, snapshotCredentials } from '../../src/shared/action-map.js';
import type { ActionDescriptor } from '../../src/shared/types.js';

const baseDescriptor: ActionDescriptor = {
  id: 'test.advise',
  network: 'test',
  channel: 'api',
  effect: 'advisement',
  defaultAuthorityTier: 1,
  description: 'test action',
  credentialRequirements: [],
};

describe('computeReadiness', () => {
  it('ready when credentials present and the brand is bound to the network', () => {
    expect(computeReadiness([], { brandProvided: true, brandBoundToNetwork: true })).toBe('ready');
  });

  it('unknown (fail-closed) when no brand is provided', () => {
    expect(computeReadiness([], { brandProvided: false, brandBoundToNetwork: false })).toBe(
      'unknown',
    );
  });

  it('unsupported when a brand is provided but not bound to this network', () => {
    expect(computeReadiness([], { brandProvided: true, brandBoundToNetwork: false })).toBe(
      'unsupported',
    );
  });

  it('unsupported scope takes precedence over missing credentials', () => {
    expect(
      computeReadiness([{ label: 'SOME_TOKEN', configured: false }], {
        brandProvided: true,
        brandBoundToNetwork: false,
      }),
    ).toBe('unsupported');
  });

  it('missing_credentials when any required credential is unconfigured', () => {
    expect(
      computeReadiness([{ label: 'SOME_TOKEN', configured: false }], {
        brandProvided: true,
        brandBoundToNetwork: true,
      }),
    ).toBe('missing_credentials');
  });

  it('scope uncertainty takes precedence over credential presence', () => {
    expect(
      computeReadiness([{ label: 'SOME_TOKEN', configured: false }], {
        brandProvided: false,
        brandBoundToNetwork: false,
      }),
    ).toBe('unknown');
  });
});

describe('snapshotCredentials', () => {
  const ENV = 'AMCP_TEST_TOKEN_XYZ';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('reports presence only, never the value', () => {
    process.env[ENV] = 'super-secret-value';
    const d: ActionDescriptor = {
      ...baseDescriptor,
      // input `configured` is ignored; snapshot recomputes from the environment.
      credentialRequirements: [{ label: ENV }],
    };
    const snap = snapshotCredentials(d);
    expect(snap).toEqual([{ label: ENV, configured: true }]);
    expect(JSON.stringify(snap)).not.toContain('super-secret-value');
  });

  it('reports configured:false when the env var is unset or blank', () => {
    const d: ActionDescriptor = {
      ...baseDescriptor,
      credentialRequirements: [{ label: ENV }],
    };
    expect(snapshotCredentials(d)).toEqual([{ label: ENV, configured: false }]);
    process.env[ENV] = '   ';
    expect(snapshotCredentials(d)).toEqual([{ label: ENV, configured: false }]);
  });

  it('empty requirements produce an empty snapshot', () => {
    expect(snapshotCredentials(baseDescriptor)).toEqual([]);
  });
});
