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
import type { NetworkAdapter, AdapterOperation } from '../shared/types.js';
import { getAdapters } from '../shared/registry.js';

/**
 * The shape we return for each tool. JSON Schema input shapes are derived from
 * Zod definitions so adapter generators can share them with the validator.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Bound handler. Resolves to the result the MCP server should return as content. */
  handle: (args: unknown) => Promise<unknown>;
}

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

// JSON-Schema-ish projections (the MCP SDK expects a plain object, not a Zod schema).
function toJsonSchema(zodSchema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal hand-rolled projection. Enough for the SDK to advertise inputs.
  // Detailed JSON Schema generation isn't a goal at v0.1 — adapters validate
  // arguments via the Zod schema at call time.
  if (zodSchema instanceof z.ZodObject) {
    const shape = zodSchema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = describe(v);
      if (!v.isOptional()) required.push(k);
    }
    const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  return { type: 'object', additionalProperties: true };
}

function describe(t: z.ZodTypeAny): Record<string, unknown> {
  if (t instanceof z.ZodOptional) return describe(t.unwrap());
  if (t instanceof z.ZodString) return { type: 'string' };
  if (t instanceof z.ZodNumber) return { type: 'number' };
  if (t instanceof z.ZodBoolean) return { type: 'boolean' };
  if (t instanceof z.ZodArray) return { type: 'array', items: describe(t.element) };
  if (t instanceof z.ZodUnion) {
    return { oneOf: (t.options as z.ZodTypeAny[]).map(describe) };
  }
  if (t instanceof z.ZodObject) return toJsonSchema(t);
  return {};
}

function toolNameFor(network: string, op: AdapterOperation): string {
  // e.g. `affiliate_awin_list_programmes`
  const snake = op.replace(/([A-Z])/g, '_$1').toLowerCase();
  return `affiliate_${network}_${snake}`.replace(/__+/g, '_');
}

interface OpSpec {
  op: AdapterOperation;
  description: (networkName: string) => string;
  schema: z.ZodTypeAny;
  invoke: (adapter: NetworkAdapter, args: unknown) => Promise<unknown>;
}

const OP_SPECS: OpSpec[] = [
  {
    op: 'listProgrammes',
    description: (n) =>
      `List affiliate programmes the publisher has joined on ${n} (or which are available to join). ` +
      `Use this when the user asks "which merchants am I working with?", "what programmes do I have on ${n}?", or wants a partner inventory. ` +
      `Returns an array of Programme records and pairs naturally with get_programme for drill-down and list_transactions for activity.`,
    schema: ProgrammeQuerySchema,
    invoke: (a, args) => a.listProgrammes(ProgrammeQuerySchema.parse(args ?? {}) as never),
  },
  {
    op: 'getProgramme',
    description: (n) =>
      `Fetch a single programme on ${n} by its network programme id. ` +
      `Use this when you already know the programme id and need its full record (commission, status, advertiser URL). ` +
      `Returns a single Programme; pair with list_programmes when you need to discover the id first.`,
    schema: GetProgrammeSchema,
    invoke: (a, args) => {
      const { programmeId } = GetProgrammeSchema.parse(args ?? {});
      return a.getProgramme(programmeId);
    },
  },
  {
    op: 'listTransactions',
    description: (n) =>
      `List affiliate transactions (commissions earned, pending, reversed, or paid) on ${n} within a window or for a specific programme. ` +
      `Use this when the user asks "what did I earn last month?", "what's still pending?", or "show me reversed sales". ` +
      `Returns Transaction records including derived ageDays; pair with get_earnings_summary for aggregate totals.`,
    schema: TransactionQuerySchema,
    invoke: (a, args) => a.listTransactions(TransactionQuerySchema.parse(args ?? {}) as never),
  },
  {
    op: 'getEarningsSummary',
    description: (n) =>
      `Summarise earnings on ${n} across a date window, with breakdowns by programme and by transaction status. ` +
      `Use this when the user wants a single-figure answer plus context — e.g. "total earnings in Q1 with status split". ` +
      `Returns an EarningsSummary including oldestUnpaidAgeDays; pair with list_transactions to drill into the underlying records.`,
    schema: TransactionQuerySchema,
    invoke: (a, args) => a.getEarningsSummary(TransactionQuerySchema.parse(args ?? {}) as never),
  },
  {
    op: 'listClicks',
    description: (n) =>
      `List recent affiliate clicks on ${n}, optionally filtered by programme and date. ` +
      `Use this for traffic-side debugging — e.g. "are my links being clicked at all?" or "where is traffic going on ${n}?". ` +
      `Returns Click records; pair with list_transactions to compare clicks vs conversions.`,
    schema: ClickQuerySchema,
    invoke: (a, args) => a.listClicks(ClickQuerySchema.parse(args ?? {}) as never),
  },
  {
    op: 'generateTrackingLink',
    description: (n) =>
      `Generate a tracking link on ${n} for a given programme and destination URL. ` +
      `Use this when the user wants to share an affiliate link to a specific product or page on a merchant they have joined. ` +
      `Returns a TrackingLink; pair with list_programmes to confirm the programmeId before calling.`,
    schema: GenerateTrackingLinkSchema,
    invoke: (a, args) => {
      const parsed = GenerateTrackingLinkSchema.parse(args ?? {});
      return a.generateTrackingLink(parsed);
    },
  },
  {
    op: 'verifyAuth',
    description: (n) =>
      `Verify the configured credentials for ${n} are valid by calling a minimal authenticated endpoint. ` +
      `Use this at the start of a session, after rotating keys, or when another operation returns an auth error. ` +
      `Returns {ok:true, identity?} or {ok:false, reason}; pair with affiliate_run_diagnostic for a full health check.`,
    schema: EmptySchema,
    invoke: (a) => a.verifyAuth(),
  },
];

export function generateToolsFor(adapter: NetworkAdapter): ToolDefinition[] {
  return OP_SPECS.map((spec) => ({
    name: toolNameFor(adapter.slug, spec.op),
    description: spec.description(adapter.name),
    inputSchema: toJsonSchema(spec.schema),
    handle: (args) => spec.invoke(adapter, args),
  }));
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
  ];
}

export function generateAllTools(): ToolDefinition[] {
  const adapterTools = getAdapters().flatMap((a) => generateToolsFor(a));
  return [...generateMetaTools(), ...adapterTools];
}
