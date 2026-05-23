import { z } from 'zod';
import type { ToolDefinition } from '../../tools/types.js';
import { toJsonSchema } from '../../tools/schema.js';
import {
  downloadProductFeed,
  generateLinksBatch,
  getAdvertiserPerformance,
  getCampaignPerformance,
  getCreativePerformance,
  getLinkBuilderQuota,
  getProgrammeDetails,
  getTransactionsByIds,
  listAccounts,
  listCommissionGroups,
  listCommissionSharingRules,
  listOffers,
  listProductFeeds,
  listTransactionQueries,
  submitProofOfPurchaseTransaction,
} from './endpoints/index.js';
import { configError } from './endpoints/shared.js';

const EmptySchema = z.object({}).strict();
const IdSchema = z.union([z.string(), z.number()]);

const AccountSchema = z
  .object({
    accountType: z.enum(['publisher', 'advertiser', 'all']).optional(),
  })
  .strict();

const ProgrammeDetailsSchema = z
  .object({
    advertiserId: IdSchema,
    relationship: z
      .enum(['joined', 'pending', 'suspended', 'rejected', 'notjoined', 'any'])
      .optional(),
  })
  .strict();

const CommissionGroupsSchema = z
  .object({
    advertiserId: IdSchema,
    effectiveDate: z.string().optional(),
    extraConditionsDetails: z.boolean().optional(),
  })
  .strict();

const TransactionsByIdSchema = z
  .object({
    ids: z.array(IdSchema),
    showBasketProducts: z.boolean().optional(),
    timezone: z.string().optional(),
  })
  .strict();

const TransactionQueriesSchema = z
  .object({
    advertiserIds: z.array(IdSchema).optional(),
    clickRefs: z.array(z.string()).optional(),
    dateType: z.enum(['enquiryDate', 'transactionDate', 'validationDate']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    statuses: z.array(z.enum(['pending', 'approved', 'declined'])).optional(),
    timezone: z.string().optional(),
    pageNumber: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional(),
  })
  .strict();

const ReportSchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    dateType: z.enum(['transaction', 'validation']).optional(),
    region: z.string().optional(),
    timezone: z.string().optional(),
  })
  .strict();

const CampaignReportSchema = ReportSchema.extend({
  advertiserIds: z.array(IdSchema).optional(),
  campaign: z.string().optional(),
  includeNumbersWithoutCampaign: z.boolean().optional(),
  interval: z.enum(['day', 'month', 'year']).optional(),
}).strict();

const LinkParametersSchema = z
  .object({
    campaign: z.string().optional(),
    clickref: z.string().optional(),
    clickref2: z.string().optional(),
    clickref3: z.string().optional(),
    clickref4: z.string().optional(),
    clickref5: z.string().optional(),
    clickref6: z.string().optional(),
  })
  .strict();

const LinkRequestSchema = z
  .object({
    advertiserId: IdSchema,
    destinationUrl: z.string().optional(),
    parameters: LinkParametersSchema.optional(),
    shorten: z.boolean().optional(),
  })
  .strict();

const GenerateTrackingLinksSchema = z
  .object({
    requests: z.array(LinkRequestSchema),
  })
  .strict();

const OffersSchema = z
  .object({
    advertiserIds: z.array(z.number().int().positive()).optional(),
    exclusiveOnly: z.boolean().optional(),
    membership: z.enum(['joined', 'notJoined', 'all']).optional(),
    regionCodes: z.array(z.string()).optional(),
    status: z.enum(['active', 'expiringSoon', 'upcoming']).optional(),
    type: z.enum(['promotion', 'voucher', 'all']).optional(),
    updatedSince: z.string().optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
  })
  .strict();

const ProductFeedDownloadSchema = z
  .object({
    advertiserId: IdSchema.optional(),
    vertical: z.string().optional(),
    locale: z.string().optional(),
    format: z.enum(['legacy', 'google-jsonl']).optional(),
  })
  .strict();

const ProofOfPurchaseSchema = z
  .object({
    advertiserId: IdSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export function generateAwinTools(): ToolDefinition[] {
  return [
    tool(
      'affiliate_awin_list_accounts',
      'List Awin accounts the configured token can access, defaulting to publisher accounts. Use this at setup time or when a user has access to multiple publisher IDs. Returns account IDs, names, roles, and raw Awin account metadata.',
      AccountSchema,
      (args) => {
        const parsed = AccountSchema.parse(args ?? {});
        return listAccounts(parsed.accountType ?? 'publisher');
      },
    ),
    tool(
      'affiliate_awin_get_programme_details',
      'Fetch Awin programme details for a specific advertiser ID. Use this before promoting a merchant when the user needs description, KPI, deeplink status, valid domains, and commission range. Returns the detailed programme envelope with raw Awin data preserved.',
      ProgrammeDetailsSchema,
      (args) => getProgrammeDetails(ProgrammeDetailsSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_list_commission_groups',
      'List the commission groups and rates a publisher receives for an Awin advertiser. Use this when deciding which products, customer types, or tracked parts are worth promoting. Returns commission group codes, names, rate values, conditions, and raw Awin data.',
      CommissionGroupsSchema,
      (args) => listCommissionGroups(CommissionGroupsSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_list_commission_sharing_rules',
      'List commission-sharing rules for an Awin service partner publisher account. Use this only for publishers using Awin commission sharing workflows. Returns rule IDs, publisher and service partner shares, titles, timestamps, and raw Awin data.',
      EmptySchema,
      () => listCommissionSharingRules(),
    ),
    tool(
      'affiliate_awin_get_transactions_by_id',
      'Fetch individual Awin transactions by numeric transaction IDs. Use this when investigating a known transaction from a report, support ticket, or previous list_transactions result. Returns matching transaction rows and can include basket products when Awin exposes them.',
      TransactionsByIdSchema,
      (args) => getTransactionsByIds(TransactionsByIdSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_list_transaction_queries',
      'List Awin transaction queries raised by or visible to the publisher. Use this when investigating missing, incorrect, pending, or declined transaction enquiries. Returns paginated transaction query rows with advertiser, click reference, status, and amount fields.',
      TransactionQueriesSchema,
      (args) => listTransactionQueries(TransactionQueriesSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_get_advertiser_performance',
      'Fetch Awin publisher performance aggregated by advertiser. Use this for daily or weekly revenue, click, impression, approval, and commission summaries by merchant. Returns report rows plus the exact query and raw Awin response.',
      ReportSchema,
      (args) => getAdvertiserPerformance(ReportSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_get_creative_performance',
      'Fetch Awin publisher performance aggregated by creative. Use this when comparing banners, text links, and creative tags across advertisers. Returns creative report rows plus the exact query and raw Awin response.',
      ReportSchema,
      (args) => getCreativePerformance(ReportSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_get_campaign_performance',
      'Fetch Awin publisher performance aggregated by campaign parameter. Use this when the user tracks placements with the campaign parameter and wants campaign-level clicks, sales, and commission. Returns campaign report rows plus the exact query and raw Awin response.',
      CampaignReportSchema,
      (args) => getCampaignPerformance(CampaignReportSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_generate_tracking_links',
      'Generate Awin tracking links through the official Link Builder API for one or many advertiser destinations. Use this when the user wants Awin to validate deeplink support or generate up to 100 links in one workflow. Returns generated link responses and preserves per-request failures from Awin.',
      GenerateTrackingLinksSchema,
      async (args) => {
        const parsed = GenerateTrackingLinksSchema.parse(args ?? {});
        if (parsed.requests.some((request) => request.shorten === true)) {
          throw configError(
            'generateLinksBatch',
            'Awin batch Link Builder does not support short links.',
            'Remove `shorten` from affiliate_awin_generate_tracking_links requests, or use the canonical single-link tool for local long-link construction.',
          );
        }
        return generateLinksBatch(parsed.requests);
      },
    ),
    tool(
      'affiliate_awin_get_link_builder_quota',
      'Fetch Awin Link Builder quota for the configured publisher account. Use this before generating shortened links or diagnosing link-builder rate issues. Returns the 24-hour limit, current usage, and raw Awin response.',
      EmptySchema,
      () => getLinkBuilderQuota(),
    ),
    tool(
      'affiliate_awin_list_offers',
      'Experimentally retrieve Awin promotions and voucher offers visible to the publisher; live validation currently returned Awin HTTP 500 for the supplied account. Use this to find joined or not-joined offers by advertiser, region, membership, offer type, status, exclusivity, or updated-since date once the endpoint is validated for the account. Returns offer rows with voucher visibility exactly as Awin provides it when Awin responds 200.',
      OffersSchema,
      (args) => listOffers(OffersSchema.parse(args ?? {})),
    ),
    tool(
      'affiliate_awin_list_product_feeds',
      'Return the current Awin product feed implementation status for this repo. Use this when a user asks for product feed access before the separate feed API key flow is configured. Returns an actionable not-enabled envelope with required credentials and documentation links.',
      EmptySchema,
      () => Promise.resolve(listProductFeeds()),
    ),
    tool(
      'affiliate_awin_download_product_feed',
      'Return the current Awin product feed download implementation status for this repo. Use this when a user asks to download an Awin product feed and needs to know why the PR does not fetch large files yet. Returns an actionable not-enabled envelope with endpoint shape, required credentials, and next steps.',
      ProductFeedDownloadSchema,
      (args) => Promise.resolve(downloadProductFeed(ProductFeedDownloadSchema.parse(args ?? {}))),
    ),
    tool(
      'affiliate_awin_submit_proof_of_purchase_transaction',
      'Return the current Awin Proof of Purchase implementation status without writing transactions. Use this when a user asks about CLO or proof-of-purchase order submission and needs activation requirements. Returns an activation-gated envelope and never submits live orders.',
      ProofOfPurchaseSchema,
      (args) =>
        Promise.resolve(submitProofOfPurchaseTransaction(ProofOfPurchaseSchema.parse(args ?? {}))),
    ),
  ];
}

function tool<T extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: T,
  handle: (args: unknown) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: toJsonSchema(schema),
    handle,
  };
}
