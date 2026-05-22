import { describe, expect, it } from 'vitest';

import { getPrompt, listPrompts } from '../../../src/prompts/generate.js';

describe('Awin MCP prompts', () => {
  it('lists the Awin journey prompts', () => {
    const names = listPrompts().map((prompt) => prompt.name).sort();
    expect(names).toEqual([
      'awin_daily_performance_brief',
      'awin_link_builder_workflow',
      'awin_offer_finder',
      'awin_programme_opportunity_scan',
      'awin_transaction_investigation',
    ]);
  });

  it('gets a prompt as MCP user messages with interpolated arguments', () => {
    const prompt = getPrompt('awin_link_builder_workflow', {
      advertiserId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/paperbacks',
      campaign: 'newsletter',
    });
    expect(prompt.messages[0]?.role).toBe('user');
    const content = prompt.messages[0]?.content;
    expect(content?.type).toBe('text');
    if (content?.type === 'text') {
      expect(content.text).toContain('affiliate_awin_get_link_builder_quota');
      expect(content.text).toContain('advertiserId=1001');
      expect(content.text).toContain('campaign=newsletter');
    }
  });

  it('throws a clear error for an unknown prompt', () => {
    expect(() => getPrompt('not_a_real_prompt')).toThrow(/No prompt named/);
  });
});
