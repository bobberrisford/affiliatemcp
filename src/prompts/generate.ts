import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: Prompt['arguments'];
  render: (args: Record<string, string | undefined>) => string;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: 'awin_daily_performance_brief',
    title: 'Awin Daily Performance Brief',
    description:
      'Build a concise Awin publisher performance brief from advertiser reports and transactions.',
    arguments: [
      { name: 'from', description: 'Start date, for example 2026-05-01.', required: false },
      { name: 'to', description: 'End date, for example 2026-05-22.', required: false },
      { name: 'region', description: 'Awin region code, default GB.', required: false },
    ],
    render: (args) => `Create a daily Awin performance brief for ${period(args)}.

Use affiliate_awin_verify_auth first if credentials have not been checked in this session. Then call affiliate_awin_get_advertiser_performance with from=${args.from ?? 'last 30 days'}, to=${args.to ?? 'today'}, region=${args.region ?? 'GB'}, and affiliate_awin_list_transactions for the same period.

Summarise total commission, sales, clicks if available, top advertisers, biggest changes or risks, pending and reversed transaction watch-outs, and suggested next actions. Treat empty 200 responses as valid but say there was no activity for the selected period.`,
  },
  {
    name: 'awin_offer_finder',
    title: 'Awin Offer Finder',
    description:
      'Find Awin promotions or vouchers that fit a publisher campaign or content brief.',
    arguments: [
      { name: 'membership', description: 'joined, notJoined, or all.', required: false },
      { name: 'type', description: 'promotion, voucher, or all.', required: false },
      { name: 'region', description: 'Region code such as GB, US, or DE.', required: false },
      { name: 'exclusiveOnly', description: 'true to show exclusive offers only.', required: false },
    ],
    render: (args) => `Find useful Awin offers for the publisher.

Call affiliate_awin_list_offers with membership=${args.membership ?? 'joined'}, regionCodes=${args.region ?? 'GB'}${args.type ? `, and type=${args.type}` : ''}${args.exclusiveOnly ? `, and exclusiveOnly=${args.exclusiveOnly}` : ''}. If the user has a specific advertiser or topic in mind, filter or rank the returned offers accordingly.

Return a short shortlist with advertiser, offer title, type, dates, voucher visibility, destination URL, tracking URL when present, and any caveats about not-joined advertisers or hidden voucher codes.`,
  },
  {
    name: 'awin_link_builder_workflow',
    title: 'Awin Link Builder Workflow',
    description:
      'Guide link generation for an Awin advertiser with membership and quota checks.',
    arguments: [
      { name: 'advertiserId', description: 'Awin advertiser/programme ID.', required: false },
      { name: 'destinationUrl', description: 'Destination URL to deeplink to.', required: false },
      { name: 'campaign', description: 'Optional Awin campaign parameter.', required: false },
    ],
    render: (args) => `Generate an Awin tracking link safely.

If advertiserId is missing, call affiliate_awin_list_programmes to identify the advertiser first. Call affiliate_awin_get_link_builder_quota, then affiliate_awin_get_programme_details for advertiserId=${args.advertiserId ?? '<ask or discover advertiserId>'}, and finally affiliate_awin_generate_tracking_links with one request using destinationUrl=${args.destinationUrl ?? '<ask for destination URL>'}${args.campaign ? ` and campaign=${args.campaign}` : ''}.

Return the generated long tracking URL, any short URL only if Awin returned one, deeplink support warnings, quota context, and whether the advertiser appears joined before promotion.`,
  },
  {
    name: 'awin_transaction_investigation',
    title: 'Awin Transaction Investigation',
    description:
      'Investigate pending, reversed, unpaid, or specific Awin transactions.',
    arguments: [
      { name: 'transactionIds', description: 'Comma-separated transaction IDs.', required: false },
      { name: 'status', description: 'pending, approved, reversed, paid, or other.', required: false },
      { name: 'from', description: 'Start date.', required: false },
      { name: 'to', description: 'End date.', required: false },
    ],
    render: (args) => `Investigate Awin transactions for the publisher.

If transactionIds is provided (${args.transactionIds ?? 'none'}), call affiliate_awin_get_transactions_by_id first. Otherwise call affiliate_awin_list_transactions with status=${args.status ?? 'pending or reversed'}, from=${args.from ?? 'last 30 days'}, and to=${args.to ?? 'today'}, then call affiliate_awin_list_transaction_queries if the question is about missing, incorrect, or declined transactions.

Explain the transaction status, age, commission, advertiser, relevant click/order references if exposed, reversal reasons, and recommended follow-up. Preserve uncertainty when Awin does not expose a field or the account has no rows in the selected period.`,
  },
  {
    name: 'awin_programme_opportunity_scan',
    title: 'Awin Programme Opportunity Scan',
    description:
      'Assess Awin programmes before a publisher decides what to promote next.',
    arguments: [
      { name: 'relationship', description: 'joined, pending, notjoined, or any.', required: false },
      { name: 'search', description: 'Optional merchant/category search term.', required: false },
      { name: 'region', description: 'Region code such as GB.', required: false },
    ],
    render: (args) => `Scan Awin programme opportunities for the publisher.

Call affiliate_awin_list_programmes with status=${args.relationship ?? 'joined'}${args.search ? ` and search=${args.search}` : ''}. For the best candidates, call affiliate_awin_get_programme_details and affiliate_awin_list_commission_groups; use affiliate_awin_get_advertiser_performance when there is existing activity.

Rank opportunities by fit, commission potential, EPC or KPI signals when present, deeplink availability, valid domains, offer availability, and operational risk such as pending/suspended membership.`,
  },
];

export function listPrompts(): Prompt[] {
  return PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments,
  }));
}

export function getPrompt(name: string, args: Record<string, string | undefined> = {}): GetPromptResult {
  const prompt = PROMPTS.find((candidate) => candidate.name === name);
  if (!prompt) {
    throw new Error(`No prompt named "${name}" is registered.`);
  }
  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: prompt.render(args),
        },
      },
    ],
  };
}

function period(args: Record<string, string | undefined>): string {
  const from = args.from ?? 'the last 30 days';
  const to = args.to ?? 'today';
  return `${from} through ${to}`;
}
