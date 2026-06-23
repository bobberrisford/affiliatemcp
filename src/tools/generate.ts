/**
 * Tool generator.
 *
 * Produces the MCP tool definitions from the adapter registry:
 *   - 7 publisher tools per registered adapter (one per publisher operation).
 *   - 7 meta tools: network discovery/diagnostics, brand resolution, advisory
 *     client-strategy read/write/list, and the action capability map.
 *
 * Tool descriptions follow PRD §5.5 — three sentences:
 *   1. WHAT the tool does.
 *   2. WHEN to use it.
 *   3. WHAT it returns and which other tools it commonly pairs with.
 */

import { z } from 'zod';
import type {
  ActionMapEntry,
  AdapterCallContext,
  AdapterOperation,
  KpiParseError,
  KpiTarget,
  NetworkAdapter,
  OperationCapability,
  NetworkMeta,
} from '../shared/types.js';
import { NotImplementedError } from '../shared/types.js';
import { getAdapters } from '../shared/registry.js';
import { computeReadiness, snapshotCredentials } from '../shared/action-map.js';
import { collectActionDescriptors } from './action-map.js';
import { isValidBrandSlug, loadBrands } from '../shared/brands.js';
import {
  type ClientStrategySummary,
  isOrphan,
  listClientStrategies,
  loadClientStrategy,
  parseKpiBlock,
  saveKpi,
  saveStrategy,
} from '../shared/client-strategy.js';
import { generateAwinTools } from '../networks/awin/tools.js';
import { generateImpactAdvertiserTools } from '../networks/impact-advertiser/tools.js';
import { generateAwinAdvertiserTools } from '../networks/awin-advertiser/tools.js';
import { generateTradedoublerTools } from '../networks/tradedoubler/tools.js';
import type { ToolDefinition } from './types.js';
import { toJsonSchema } from './schema.js';
import { cacheKey, credentialHashFor, pickTtl, withCache } from '../shared/cache.js';
import type { DiagnosticResult } from '../shared/diagnostic.js';

export type { ToolDefinition } from './types.js';

export type RunDiagnosticMetaResult = DiagnosticResult;

export type ListNetworksMetaResult = Array<
  NetworkMeta & {
    operationClaimStatuses: Record<string, OperationCapability['claimStatus']>;
  }
>;

export type ResolveBrandMetaResult = Array<{
  brand: string;
  network: string;
  networkBrandId: string;
}>;

export interface GetClientStrategyMetaResult {
  brand: string;
  orphan: boolean;
  strategy: {
    present: boolean;
    markdown?: string;
  };
  kpi: {
    present: boolean;
    version?: number;
    targets: KpiTarget[];
    parseErrors: KpiParseError[];
  };
}

export type SetClientStrategyMetaResult =
  | {
      brand: string;
      written: false;
      reason: string;
    }
  | {
      brand: string;
      written: false;
      parseErrors: KpiParseError[];
    }
  | {
      brand: string;
      written: true;
      wrote: {
        strategy: boolean;
        kpi: boolean;
      };
      orphan: boolean;
    };

export type ListClientStrategiesMetaResult = ClientStrategySummary[];

/**
 * `affiliate_list_actions` returns the resolved action map, OR — when a
 * `network`/`brand` filter names something unknown — an explicit
 * unsupported-scope result. The discriminated shape means a typo'd filter is
 * distinguishable from a valid scope that legitimately has no actions (which
 * returns `[]`), per the accepted decision (#231 §3).
 */
export type ListActionsMetaResult =
  | ActionMapEntry[]
  | {
      unsupportedScope: {
        dimension: 'network' | 'brand' | 'brand_network';
        value: string;
      };
      message: string;
    };

const ListActionsSchema = z
  .object({
    network: z.string().trim().min(1).optional(),
    brand: z.string().trim().min(1).optional(),
    effect: z.enum(['read', 'advisement', 'write']).optional(),
    channel: z.enum(['api', 'browser', 'none']).optional(),
  })
  .strict();

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

/**
 * MCP tool names are capped at 64 characters by the Anthropic API; a single
 * over-length name makes a client reject the entire tool list. Only advertiser
 * slugs (carrying the `-advertiser` suffix) get close, and exactly one combo
 * overflows today: `affiliate_commission-factory-advertiser_get_programme_performance`
 * (65 chars). When — and only when — the assembled name would exceed the cap,
 * abbreviate the slug's `-advertiser` suffix to `-adv`; every other name stays
 * byte-identical, and any future long advertiser name is handled automatically.
 */
const MAX_TOOL_NAME_LEN = 64;

function toolNameFor(network: string, op: AdapterOperation): string {
  // e.g. `affiliate_awin_list_programmes`
  const snake = op.replace(/([A-Z])/g, '_$1').toLowerCase();
  const name = `affiliate_${network}_${snake}`.replace(/__+/g, '_');
  if (name.length <= MAX_TOOL_NAME_LEN) return name;
  const shortened = `affiliate_${network.replace(/-advertiser$/, '-adv')}_${snake}`.replace(
    /__+/g,
    '_',
  );
  return shortened;
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
        handle: (args: unknown) => {
          // Parse once so the cache key uses the canonical args (defaults
          // applied, unknown fields stripped) rather than whatever the caller
          // happened to pass through.
          const parsedArgs = spec.schema.parse(args ?? {}) as unknown;
          const ttl = pickTtl(spec.op, parsedArgs, new Date(), false);
          if (ttl <= 0) {
            return spec.invoke(adapter, parsedArgs);
          }
          const key = cacheKey({
            network: adapter.slug,
            operation: spec.op,
            args: parsedArgs,
            adapterVersion: adapter.meta.adapterVersion,
            credentialHash: credentialHashFor(adapter.slug),
          });
          return withCache(key, ttl, () => spec.invoke(adapter, parsedArgs));
        },
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
        // network call goes out — and intentionally before the cache layer
        // so an unknown brand still surfaces correctly instead of returning
        // a cached result for a brand the user has since removed.
        const ctx = buildAdapterCallContext(parsed.brand, adapter.slug);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { brand: _brand, ...rest } = parsed;
        const ttl = pickTtl(spec.op, rest, new Date(), true);
        if (ttl <= 0) {
          return spec.invoke(adapter, rest, ctx);
        }
        const key = cacheKey({
          network: adapter.slug,
          operation: spec.op,
          // Include the resolved networkBrandId so two brands sharing the
          // same credential set get separate cache entries.
          args: { ...rest, __networkBrandId: ctx.networkBrandId },
          adapterVersion: adapter.meta.adapterVersion,
          credentialHash: credentialHashFor(adapter.slug),
        });
        return withCache(key, ttl, () => spec.invoke(adapter, rest, ctx));
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
      handle: async (args): Promise<RunDiagnosticMetaResult> => {
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
        'Returns a NetworkMeta[] array (additively extended with `operationClaimStatuses` — per-op claim-status overrides emitted by an adapter\'s capabilities()); pair with affiliate_run_diagnostic for live capability data.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async (): Promise<ListNetworksMetaResult> => {
        // Additive shape: original NetworkMeta fields are preserved verbatim;
        // `operationClaimStatuses` is a NEW optional field that surfaces
        // per-op claimStatus overrides for callers that want to distinguish
        // a fully-verified op from one whose underlying contract is only
        // partially verified. Empty object when an adapter emits no overrides.
        const adapters = getAdapters();
        const enriched = await Promise.all(
          adapters.map(async (a) => {
            let operationClaimStatuses: Record<string, OperationCapability['claimStatus']> = {};
            try {
              const caps = await a.capabilitiesCheck();
              for (const [op, cap] of Object.entries(caps.operations)) {
                if (cap.claimStatus) operationClaimStatuses[op] = cap.claimStatus;
              }
            } catch {
              // Adapter capabilitiesCheck failed — surface meta unchanged.
              // The diagnostic tool is the right place to expose that failure.
              operationClaimStatuses = {};
            }
            return { ...a.meta, operationClaimStatuses };
          }),
        );
        return enriched;
      },
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
      handle: async (args): Promise<ResolveBrandMetaResult> => {
        const parsed = z
          .object({ network: z.string().optional() })
          .strict()
          .parse(args ?? {});
        const file = loadBrands();
        const rows: ResolveBrandMetaResult = [];
        for (const [slug, bindings] of Object.entries(file.brands)) {
          for (const b of bindings) {
            if (parsed.network && b.network !== parsed.network) continue;
            rows.push({ brand: slug, network: b.network, networkBrandId: b.networkBrandId });
          }
        }
        return rows;
      },
    },
    {
      name: 'affiliate_get_client_strategy',
      description:
        'Read the advisory strategy and KPI context an operator has recorded for one brand (the brand slug from brands.json). ' +
        'Use this before producing a report so a delta can be judged against the client\'s own plan rather than reported bare. ' +
        'Returns { brand, orphan, strategy:{present,markdown}, kpi:{present,version,targets,parseErrors} }; targets are already parsed, parseErrors must be reported and excluded from verdicts, and the context is advisory only and never authorises a write.',
      inputSchema: {
        type: 'object',
        properties: { brand: { type: 'string' } },
        required: ['brand'],
        additionalProperties: false,
      },
      handle: async (args): Promise<GetClientStrategyMetaResult> => {
        const parsed = z.object({ brand: z.string() }).strict().parse(args ?? {});
        const c = loadClientStrategy(parsed.brand);
        return {
          brand: c.brand,
          orphan: c.orphan,
          strategy: {
            present: c.strategy.present,
            ...(c.strategy.markdown !== undefined ? { markdown: c.strategy.markdown } : {}),
          },
          kpi: {
            present: c.kpi.present,
            ...(c.kpi.parsed?.version !== undefined ? { version: c.kpi.parsed.version } : {}),
            targets: c.kpi.parsed?.targets ?? [],
            parseErrors: c.kpi.parsed?.errors ?? [],
          },
        };
      },
    },
    {
      name: 'affiliate_set_client_strategy',
      description:
        'Write the advisory Strategy.md and/or KPI.md for one brand (the brand slug from brands.json) to the local config directory. ' +
        'Use this only after confirming the content with the operator; the onboarding skill drafts and confirms, this tool persists. ' +
        'kpiMarkdown is validated against the fenced ```kpi grammar and is rejected without writing if it has parse errors (returned as parseErrors); these are local-config writes, not network writes, and never authorise a network action.',
      inputSchema: {
        type: 'object',
        properties: {
          brand: { type: 'string' },
          strategyMarkdown: { type: 'string' },
          kpiMarkdown: { type: 'string' },
        },
        required: ['brand'],
        additionalProperties: false,
      },
      handle: async (args): Promise<SetClientStrategyMetaResult> => {
        const parsed = z
          .object({
            brand: z.string(),
            strategyMarkdown: z.string().optional(),
            kpiMarkdown: z.string().optional(),
          })
          .strict()
          .refine((d) => d.strategyMarkdown !== undefined || d.kpiMarkdown !== undefined, {
            message: 'Provide strategyMarkdown, kpiMarkdown, or both.',
          })
          .parse(args ?? {});

        if (!isValidBrandSlug(parsed.brand)) {
          return {
            brand: parsed.brand,
            written: false,
            reason: `Invalid brand slug "${parsed.brand}". Use lowercase letters, digits, and hyphens only.`,
          };
        }

        // Validate KPI before writing anything; a malformed block is rejected
        // whole rather than persisted to fail silently on the next read.
        if (parsed.kpiMarkdown !== undefined) {
          const result = parseKpiBlock(parsed.kpiMarkdown);
          if (result.errors.length > 0) {
            return { brand: parsed.brand, written: false, parseErrors: result.errors };
          }
        }

        const wrote = { strategy: false, kpi: false };
        if (parsed.strategyMarkdown !== undefined) {
          saveStrategy(parsed.brand, parsed.strategyMarkdown);
          wrote.strategy = true;
        }
        if (parsed.kpiMarkdown !== undefined) {
          saveKpi(parsed.brand, parsed.kpiMarkdown);
          wrote.kpi = true;
        }
        return { brand: parsed.brand, written: true, wrote, orphan: isOrphan(parsed.brand) };
      },
    },
    {
      name: 'affiliate_list_client_strategies',
      description:
        'List which brands have advisory strategy recorded, covering both brands bound in brands.json and any client directory on disk. ' +
        'Use this to drive a portfolio rollup or to prompt the operator to record strategy for a brand that has none. ' +
        'Returns an array of { slug, hasStrategy, hasKpi, registered, orphan }; orphan flags a strategy directory whose slug has no brand binding.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async (): Promise<ListClientStrategiesMetaResult> => listClientStrategies(),
    },
    {
      name: 'affiliate_list_actions',
      description:
        'List the doing-surface actions (advisement, write, and known gaps) the configured adapters declare, with channel, effect, default authority tier, and local readiness. ' +
        'Use this to see what is possible and what it would cost in approvals before granting a write credential or planning a change; filter by network, brand, effect, or channel, and note it never executes an action, drives a browser, or checks live auth. ' +
        'Returns an ActionMapEntry[] (or an explicit unsupported-scope result for an unknown network/brand); for live credential and endpoint health use affiliate_run_diagnostic, and for network discovery use affiliate_list_networks.',
      inputSchema: toJsonSchema(ListActionsSchema),
      annotations: { readOnlyHint: true },
      handle: async (args): Promise<ListActionsMetaResult> => {
        const f = ListActionsSchema.parse(args ?? {});
        const registeredNetworks = new Set(getAdapters().map((adapter) => adapter.slug));
        // Explicit unknown-scope results — never an ambiguous empty list (#231 §3).
        if (f.network !== undefined && !registeredNetworks.has(f.network)) {
          return {
            unsupportedScope: { dimension: 'network', value: f.network },
            message: `No registered adapter for network "${f.network}". Call affiliate_list_networks to see registered networks.`,
          };
        }
        let brandNetworks: Set<string> | undefined;
        if (f.brand !== undefined) {
          const bindings = loadBrands().brands[f.brand];
          if (!bindings || bindings.length === 0) {
            return {
              unsupportedScope: { dimension: 'brand', value: f.brand },
              message: `No brand "${f.brand}" is bound in brands.json. Call affiliate_resolve_brand to see bound brands.`,
            };
          }
          brandNetworks = new Set(
            bindings
              .map((binding) => binding.network)
              .filter((network) => registeredNetworks.has(network)),
          );
          if (brandNetworks.size === 0) {
            return {
              unsupportedScope: { dimension: 'brand', value: f.brand },
              message: `Brand "${f.brand}" has no binding to a registered adapter. Call affiliate_list_networks and affiliate_resolve_brand to inspect the configuration.`,
            };
          }
          if (f.network !== undefined && !brandNetworks.has(f.network)) {
            return {
              unsupportedScope: {
                dimension: 'brand_network',
                value: `${f.brand}@${f.network}`,
              },
              message: `Brand "${f.brand}" is not bound to network "${f.network}". Call affiliate_resolve_brand to see its network bindings.`,
            };
          }
        }
        // Non-probing: registry read + brands.json read + pure helpers only.
        let descriptors = collectActionDescriptors();
        if (f.network) descriptors = descriptors.filter((d) => d.network === f.network);
        if (brandNetworks) descriptors = descriptors.filter((d) => brandNetworks.has(d.network));
        if (f.effect) descriptors = descriptors.filter((d) => d.effect === f.effect);
        if (f.channel) descriptors = descriptors.filter((d) => d.channel === f.channel);
        return descriptors.map((d) => {
          const credentials = snapshotCredentials(d);
          const readiness = computeReadiness(credentials, {
            brandProvided: f.brand !== undefined,
            brandBoundToNetwork: brandNetworks ? brandNetworks.has(d.network) : false,
          });
          return {
            descriptor: d,
            readiness,
            credentials,
            liveHealthVia: 'affiliate_run_diagnostic' as const,
          };
        });
      },
    },
  ];
}

export function generateAllTools(): ToolDefinition[] {
  const adapterTools = getAdapters().flatMap((a) => [
    ...generateToolsFor(a),
    ...(a.slug === 'awin' ? generateAwinTools() : []),
    ...(a.slug === 'impact-advertiser' ? generateImpactAdvertiserTools() : []),
    ...(a.slug === 'awin-advertiser' ? generateAwinAdvertiserTools() : []),
    ...(a.slug === 'tradedoubler' ? generateTradedoublerTools() : []),
  ]);
  return [...generateMetaTools(), ...adapterTools];
}
