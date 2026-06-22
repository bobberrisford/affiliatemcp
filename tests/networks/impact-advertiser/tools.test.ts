import { describe, expect, it } from 'vitest';
import { impactAdvertiserAdapter } from '../../../src/networks/impact-advertiser/adapter.js';
import { generateImpactAdvertiserTools } from '../../../src/networks/impact-advertiser/tools.js';
import { generateAllTools, generateToolsFor } from '../../../src/tools/generate.js';

describe('Impact advertiser contract tool surface', () => {
  it('ships reads + propose (readOnly) and the two gated writes (destructive)', () => {
    const tools = generateImpactAdvertiserTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'affiliate_impact-advertiser_list_contracts',
      'affiliate_impact-advertiser_get_contract',
      'affiliate_impact-advertiser_propose_contract',
      'affiliate_impact-advertiser_apply_contract',
      'affiliate_impact-advertiser_remove_contract',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    // Reads + advisement carry readOnlyHint; the writes carry destructiveHint.
    for (const n of [
      'affiliate_impact-advertiser_list_contracts',
      'affiliate_impact-advertiser_get_contract',
      'affiliate_impact-advertiser_propose_contract',
    ]) {
      expect(byName[n]!.annotations?.readOnlyHint).toBe(true);
    }
    for (const n of [
      'affiliate_impact-advertiser_apply_contract',
      'affiliate_impact-advertiser_remove_contract',
    ]) {
      expect(byName[n]!.annotations?.destructiveHint).toBe(true);
      expect(byName[n]!.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('adds the reads only to Impact rather than every advertiser adapter', () => {
    const standardNames = generateToolsFor(impactAdvertiserAdapter).map((tool) => tool.name);
    expect(standardNames).not.toContain('affiliate_impact-advertiser_list_contracts');

    const allNames = generateAllTools().map((tool) => tool.name);
    expect(allNames).toContain('affiliate_impact-advertiser_list_contracts');
    expect(allNames).toContain('affiliate_impact-advertiser_get_contract');
    expect(allNames).toContain('affiliate_impact-advertiser_propose_contract');
  });

  it('requires brand and programmeId and constrains status and page cursor', () => {
    const list = generateImpactAdvertiserTools()[0];
    expect(list).toBeDefined();
    if (!list) throw new Error('list_contracts tool missing');
    const schema = list.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required).toEqual(expect.arrayContaining(['brand', 'programmeId']));
    expect(schema.properties).toHaveProperty('cursor');
    expect(schema.properties).toHaveProperty('status');
  });
});
