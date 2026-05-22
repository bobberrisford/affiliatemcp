import { describe, expect, it } from 'vitest';

import { generateAwinTools } from '../../../src/networks/awin/tools.js';

describe('Awin-specific MCP tools', () => {
  it('registers the expanded Awin tool surface without replacing canonical tools', () => {
    const tools = generateAwinTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'affiliate_awin_download_product_feed',
      'affiliate_awin_generate_tracking_links',
      'affiliate_awin_get_advertiser_performance',
      'affiliate_awin_get_campaign_performance',
      'affiliate_awin_get_creative_performance',
      'affiliate_awin_get_link_builder_quota',
      'affiliate_awin_get_programme_details',
      'affiliate_awin_get_transactions_by_id',
      'affiliate_awin_list_accounts',
      'affiliate_awin_list_commission_groups',
      'affiliate_awin_list_commission_sharing_rules',
      'affiliate_awin_list_offers',
      'affiliate_awin_list_product_feeds',
      'affiliate_awin_list_transaction_queries',
      'affiliate_awin_submit_proof_of_purchase_transaction',
    ]);
  });

  it('advertises JSON input schemas for every Awin-specific tool', () => {
    for (const tool of generateAwinTools()) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.description.split('. ').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('requires advertiserId for programme details and accepts request arrays for Link Builder', () => {
    const tools = new Map(generateAwinTools().map((tool) => [tool.name, tool]));
    const programme = tools.get('affiliate_awin_get_programme_details');
    const links = tools.get('affiliate_awin_generate_tracking_links');
    expect(programme?.inputSchema).toMatchObject({
      required: ['advertiserId'],
    });
    expect(links?.inputSchema).toMatchObject({
      required: ['requests'],
    });
  });
});
