/**
 * Tool generator.
 *
 * Produces the MCP tool definitions from the adapter registry:
 *   - 7 publisher tools per registered adapter (one per publisher operation).
 *   - 2 meta tools: `affiliate_run_diagnostic`, `affiliate_list_networks`.
 *
 * Tool descriptions follow PRD §5.5 — three sentences:
 *   1. WHAT the tool does.
 *   2. WHEN to use it.
 *   3. WHAT it returns and which other tools it commonly pairs with.
 */

import { z } from 'zod';
import type {
  AdapterCallContext,
  AdapterOperation,
  NetworkAdapter,
} from '../shared/types.js';
import { NotImplementedError } from '../shared/types.js';
import { getAdapters } from '../shared/registry.js';
import { loadBrands } from '../shared/brands.js';
import { generateAwinTools } from '../networks/awin/tools.js';
import type { ToolDefinition } from './types.js';
import { toJsonSchema } from './schema.js';

export type { ToolDefinition } from './types.js';

// Re-usable Zod schemas for tool inputs.
const ProgrammeQuerySchema = z
  .object({
    status: z.union([z.string(), z.array(z.string())]).optional(),
    search: z.string().optional(),
    categories: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const TransactionQuerySchema = z
  .object({
    programmeId: z.string().optional(),
    status: z.union([z.string(), z.array(z.string())]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    minAgeDays: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const ClickQuerySchema = z
  .object({
    programmeId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const GetProgrammeSchema = z.object({ programmeId: z.string() }).strict();
const GenerateTrackingLinkSchema = z
  .object({ programmeId: z.string(), destinationUrl: z.string() })
  .strict();
const EmptySchema = z.object({}).strict();

const MediaPartnerQuerySchema = z
  .object({
    status: z.union([z.string(), z.array(z.string())]).optional(),
    search: z.string().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const ProgrammePerformanceQuerySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    programmeId: z.string().optional(),
    publisherId: z.string().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

function toolNameFor(network: string, op: AdapterOperation): string {
  // e.g. `affiliate_awin_list_programmes`
  const snake = op.replace(/([A-Z])/g, '_$1').toLowerCase();
  return `affiliate_${network}_${snake}`.replace(/__+/g, '_');
}

interface OpSpec {
  op: AdapterOperation;
  description: (networkName: string) => string;
  schema: z.ZodTypeAny;
  /**
   * Set on advertiser-only ops (e.g. listMediaPartners, getProgrammePerformance).
   * Such ops are wired on advertiser-side adapters only; the publisher side
   * never exposes them as tools.
   */
  advertiserOnly?: boolean;
  /**
   * Invoke the adapter method. `ctx` is `undefined` for publisher-side calls
   * and populated for advertiser-side calls (`networkBrandId` resolved via
   * brand-resolver before this fires).
   */
  invoke: (
    adapter: NetworkAdapter,
    args: unknown,
    ctx?: AdapterCallContext,
  ) => Promise<unknown>;
}

const OP_SPECS: OpSpec[] = [
  {
    op: 'listProgrammes',
    description: (n) =>
      `List affiliate programmes the publisher has joined on ${n} (or which are available to join). ` +
      `Use this when the user asks "which merchants am I working with?", "what programmes do I have on ${n}?", or wants a partner inventory. ` +
      `Returns an array of Programme records and pairs naturally with get_programme for drill-down and list_transactions for activity.`,
    schema: ProgrammeQuerySchema,
    invoke: (a, args, ctx) =>
      a.listProgrammes(ProgrammeQuerySchema.parse(args ?? {}) as never, ctx),
  },
  {
    op: 'getProgramme',
    description: (n) =>
      `Fetch a single programme on ${n} by its network programme id. ` +
      `Use this when you already know the programme id and need its full record (commission, status, advertiser URL). ` +
      `Returns a single Programme; pair with list_programmes when you need to discover the id first.`,
    schema: GetProgrammeSchema,
    invoke: (a, args, ctx) => {
      const { programmeId } = GetProgrammeSchema.parse(args ?? {});
      return a.getProgramme(programmeId, ctx);
    },
  },
  {
    op: 'listTransactions',
    description: (n) =>
      `List affiliate transactions (commissions earned, pending, reversed, or paid) on ${n} within a window or for a specific programme. ` +
      `Use this when the user asks "what did I earn last month?", "what's still pending?", or "show me reversed sales". ` +
      `Returns Transaction records including derived ageDays; pair with get_earnings_summary for aggregate totals.`,
    schema: TransactionQuerySchema,
    invoke: (a, args, ctx) =>
      a.listTransactions(TransactionQuerySchema.parse(args ?? {}) as never, ctx),
  },
  {
    op: 'getEarningsSummary',
    description: (n) =>
      `Summarise earnings on ${n} across a date window, with breakdowns by programme and by transaction status. ` +
      `Use this when the user wants a single-figure answer plus context — e.g. "total earnings in Q1 with status split". ` +
      `Returns an EarningsSummary including oldestUnpaidAgeDays; pair with list_transactions to drill into the underlying records.`,
    schema: TransactionQuerySchema,
    invoke: (a, args, ctx) =>
      a.getEarningsSummary(TransactionQuerySchema.parse(args ?? {}) as never, ctx),
  },
  {
    op: 'listClicks',
    description: (n) =>
      `List recent affiliate clicks on ${n}, optionally filtered by programme and date. ` +
      `Use this for traffic-side debugging — e.g. "are my links being clicked at all?" or "where is traffic going on ${n}?". ` +
      `Returns Click records; pair with list_transactions to compare clicks vs conversions.`,
    schema: ClickQuerySchema,
    invoke: (a, args, ctx) =>
      a.listClicks(ClickQuerySchema.parse(args ?? {}) as never, ctx),
  },
  {
    op: 'generateTrackingLink',
    description: (n) =>
      `Generate a tracking link on ${n} for a given programme and destination URL. ` +
      `Use this when the user wants to share an affiliate link to a specific product or page on a merchant they have joined. ` +
      `Returns a TrackingLink; pair with list_programmes to confirm the programmeId before calling.`,
    schema: GenerateTrackingLinkSchema,
    invoke: (a, args, ctx) => {
      const parsed = GenerateTrackingLinkSchema.parse(args ?? {});
      return a.generateTrackingLink(parsed, ctx);
    },
  },
  {
    op: 'verifyAuth',
    description: (n) =>
      `Verify the configured credentials for ${n} are valid by calling a minimal authenticated endpoint. ` +
      `Use this at the start of a session, after rotating keys, or when another operation returns an auth error. ` +
      `Returns {ok:true, identity?} or {ok:false, reason}; pair with affiliate_run_diagnostic for a full health check.`,
    schema: EmptySchema,
    invoke: (a, _args, ctx) => a.verifyAuth(ctx),
  },
  // -- advertiser-only ops below. Wired only when adapter.meta.side === 'advertiser'.
  {
    op: 'listMediaPartners',
    advertiserOnly: true,
    description: (n) =>
      `List the media partners (publishers) running on the brand's programme at ${n}. ` +
      `Use this when the user asks "who is promoting us on ${n}?", "which publishers are active on our programme?", or wants an outbound roster. ` +
      `Returns MediaPartner records with normalised status; pair with the matching get_programme_performance tool on ${n} to drill into per-publisher performance.`,
    schema: MediaPartnerQuerySchema,
    invoke: (a, args, ctx) => {
      if (typeof a.listMediaPartners !== 'function') {
        throw new NotImplementedError(
          `Adapter "${a.slug}" does not implement listMediaPartners; advertiser adapters must override it.`,
        );
      }
      return a.listMediaPartners(MediaPartnerQuerySchema.parse(args ?? {}) as never, ctx);
    },
  },
  {
    op: 'getProgrammePerformance',
    advertiserOnly: true,
    description: (n) =>
      `Fetch per-publisher performance for the brand's programme at ${n} — clicks, conversions, gross sale, and commission, by date. ` +
      `Use this when the user asks "how is each publisher performing on ${n}?", "show me the top-earning partners last month", or wants the per-publisher rollup. ` +
      `Returns ProgrammePerformanceRow records; pair with list_media_partners to discover publisher ids and list_transactions for transaction-level drill-down.`,
    schema: ProgrammePerformanceQuerySchema,
    invoke: (a, args, ctx) => {
      if (typeof a.getProgrammePerformance !== 'function') {
        throw new NotImplementedError(
          `Adapter "${a.slug}" does not implement getProgrammePerformance; advertiser adapters must override it.`,
        );
      }
      return a.getProgrammePerformance(
        ProgrammePerformanceQuerySchema.parse(args ?? {}) as never,
        ctx,
      );
    },
  },
];

export function generateToolsFor(adapter: NetworkAdapter): ToolDefinition[] {
  const isAdvertiser = adapter.meta.side === 'advertiser';
  // Publisher adapters never see advertiser-only operations; advertiser
  // adapters get the full op set.
  const specs = OP_SPECS.filter((s) => isAdvertiser || !s.advertiserOnly);

  return specs.map((spec) => {
    if (!isAdvertiser) {
      return {
        name: toolNameFor(adapter.slug, spec.op),
        description: spec.description(adapter.name),
        inputSchema: toJsonSchema(spec.schema),
        handle: (args: unknown) => spec.invoke(adapter, args),
      };
    }

    // Advertiser-side: add a required `brand` argument and resolve it to a
    // `networkBrandId` via brands.json before the adapter is called. The
    // resolved ctx is threaded into the adapter invocation so each method
    // knows which brand under the multi-brand credential set to address.
    const advertiserSchema = withBrandArg(spec.schema);
    return {
      name: toolNameFor(adapter.slug, spec.op),
      description: spec.description(adapter.name),
      inputSchema: toJsonSchema(advertiserSchema),
      handle: async (args: unknown) => {
        const parsed = advertiserSchema.parse(args ?? {}) as {
          brand: string;
        } & Record<string, unknown>;
        const { buildAdapterCallContext } = await import('../shared/brand-resolver.js');
        // Throws BrandNotRegistered (config_error envelope) if the brand
        // isn't bound to this network in brands.json. Happens BEFORE any
        // network call goes out.
        const ctx = buildAdapterCallContext(parsed.brand, adapter.slug);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { brand: _brand, ...rest } = parsed;
        return spec.invoke(adapter, rest, ctx);
      },
    };
  });
}

/** Attach a required `brand: string` field to an existing Zod object schema. */
function withBrandArg(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    return schema.extend({ brand: z.string().min(1) });
  }
  return z.object({ brand: z.string().min(1) }).strict();
}

export function generateMetaTools(): ToolDefinition[] {
  return [
    {
      name: 'affiliate_run_diagnostic',
      description:
        'Run a capabilities diagnostic across one or all registered affiliate networks. ' +
        'Use this to answer "is everything working?" or to confirm which operations a given network actually supports. ' +
        'Returns NetworkCapabilities per network; pair with the per-network verify_auth tools when you need to isolate an auth failure.',
      inputSchema: {
        type: 'object',
        properties: { network: { type: 'string' } },
        additionalProperties: false,
      },
      handle: async (args) => {
        const parsed = z
          .object({ network: z.string().optional() })
          .strict()
          .parse(args ?? {});
        const { runDiagnostic } = await import('../shared/diagnostic.js');
        return runDiagnostic(parsed.network);
      },
    },
    {
      name: 'affiliate_list_networks',
      description:
        'List the affiliate networks this server has adapters registered for, along with their adapter version and claim_status. ' +
        'Use this to discover which networks are wired up before invoking a per-network tool. ' +
        'Returns a NetworkMeta[] array; pair with affiliate_run_diagnostic for live capability data.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async () => getAdapters().map((a) => a.meta),
    },
    {
      name: 'affiliate_resolve_brand',
      description:
        'List the logical brands the operator has bound in brands.json, optionally filtered by network slug. ' +
        'Use this when the user asks "which brands do I have on Impact?" or "show me everything I have registered for Acme" before invoking an advertiser-side tool. ' +
        'Returns an array of {brand, network, networkBrandId} entries; pair with the per-network advertiser tools, each of which requires the `brand` argument shown here.',
      inputSchema: {
        type: 'object',
        properties: { network: { type: 'string' } },
        additionalProperties: false,
      },
      handle: async (args) => {
        const parsed = z
          .object({ network: z.string().optional() })
          .strict()
          .parse(args ?? {});
        const file = loadBrands();
        const rows: Array<{ brand: string; network: string; networkBrandId: string }> = [];
        for (const [slug, bindings] of Object.entries(file.brands)) {
          for (const b of bindings) {
            if (parsed.network && b.network !== parsed.network) continue;
            rows.push({ brand: slug, network: b.network, networkBrandId: b.networkBrandId });
          }
        }
        return rows;
      },
    },
  ];
}

export function generateAllTools(): ToolDefinition[] {
  const adapterTools = getAdapters().flatMap((a) => [
    ...generateToolsFor(a),
    ...(a.slug === 'awin' ? generateAwinTools() : []),
  ]);
  return [...generateMetaTools(), ...adapterTools];
}
