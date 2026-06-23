import { describe, expect, it } from 'vitest';
import { impactAdvertiserAdapter } from '../../../src/networks/impact-advertiser/adapter.js';
import { generateImpactAdvertiserTools } from '../../../src/networks/impact-advertiser/tools.js';
import { generateAllTools, generateToolsFor } from '../../../src/tools/generate.js';

describe('Impact advertiser contract tool surface', () => {
  it('ships the two reads plus the proposeContract advisement tool, but no write tools', () => {
    const tools = generateImpactAdvertiserTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'affiliate_impact-advertiser_list_contracts',
      'affiliate_impact-advertiser_get_contract',
      'affiliate_impact-advertiser_propose_contract',
    ]);
    // proposeContract is advisement (no network write); the write surface
    // (apply/remove) is not exposed while it remains unbuilt and gated.
    const names = tools.map((tool) => tool.name);
    expect(names.some((n) => /apply_contract|remove_contract/.test(n))).toBe(false);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
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
