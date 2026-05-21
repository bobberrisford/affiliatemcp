import { beforeEach, describe, expect, it } from 'vitest';
import { generateAllTools, generateMetaTools } from '../../src/tools/generate.js';
import { _clearRegistry } from '../../src/shared/registry.js';

beforeEach(() => _clearRegistry());

describe('tool generator', () => {
  it('always emits the two meta tools', () => {
    const meta = generateMetaTools();
    const names = meta.map((t) => t.name).sort();
    expect(names).toEqual(['affiliate_list_networks', 'affiliate_run_diagnostic']);
  });

  it('with no adapters registered, only meta tools are present', () => {
    const all = generateAllTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      'affiliate_list_networks',
      'affiliate_run_diagnostic',
    ]);
  });

  it('each meta tool description follows the three-sentence pattern', () => {
    for (const t of generateMetaTools()) {
      // Heuristic: at least two ". " separators (three sentences).
      const periods = (t.description.match(/\. /g) ?? []).length;
      expect(periods).toBeGreaterThanOrEqual(2);
    }
  });
});
