import { beforeEach, describe, expect, it } from 'vitest';
import { runDiagnostic, validateNetwork } from '../../src/shared/diagnostic.js';
import { _clearRegistry } from '../../src/shared/registry.js';

beforeEach(() => _clearRegistry());

describe('diagnostic engine', () => {
  it('runDiagnostic returns an empty result list when no adapters registered', async () => {
    const r = await runDiagnostic();
    expect(r.results).toEqual([]);
  });

  it('runDiagnostic reports unknown slug honestly', async () => {
    const r = await runDiagnostic('nonexistent');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.error?.message).toMatch(/No adapter/);
  });

  it('validateNetwork fails cleanly on unknown slug', async () => {
    const r = await validateNetwork('nonexistent');
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.name).toBe('registry');
    expect(r.checks[0]?.ok).toBe(false);
  });
});
