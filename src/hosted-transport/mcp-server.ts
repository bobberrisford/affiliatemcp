/**
 * Hosted MCP `Server` wiring (H4, extended by H6).
 *
 * Deliberately structured to mirror `src/server.ts`'s `CallToolRequestSchema`
 * handler closely — same tool registry (`generateAllTools`), same entitlement
 * gate, same error-envelope and result-size-guard handling, same telemetry
 * classification — so a reviewer can diff the two side by side. `src/server.ts`
 * itself is untouched by this slice (the workstream brief requires the local
 * stdio path stay byte-identical); this is a parallel, additive module, not a
 * refactor of it. The behavioural additions are hosted-only: resolving the
 * per-request identity and vault-credential overlay
 * (`getHostedCallInfo`/`resolveCredentialOverlay`), the per-user rate limit
 * (`checkRateLimit`), the per-user audit line (`recordHostedAudit`), and (H6)
 * the billing-tier gate — an active Solo/Pro subscription is required before
 * any hosted tool call proceeds, and Solo is additionally capped at
 * `SOLO_NETWORK_CAP` distinct connected networks (`tier-gate.ts`).
 *
 * Gate ordering, cheapest-refusal-first: tool lookup -> brand-data
 * entitlement gate (unchanged) -> hosted billing-tier gate (one HTTP call to
 * the hosted Worker) -> free-tier meter (one HTTP call, `free` tier only,
 * decision 2026-07-18) -> per-tier rate limit (no HTTP call) -> Solo network
 * cap (one HTTP call, vault list) -> vault-credential overlay (one HTTP
 * call) -> adapter dispatch. Since the freemium amendment, an authenticated
 * caller is at worst `free` (the hosted Worker's `resolveEntitlement` no
 * longer returns `none`); a `free` caller whose weekly allowance is spent is
 * refused at the meter, before the rate-limit bucket, the Solo network-cap
 * vault list, and the credential overlay, so an out-of-quota caller never
 * causes those downstream round trips.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { generateAllTools, type ToolDefinition } from '../tools/generate.js';
import { guardToolResult } from '../tools/result-guard.js';
import { getPrompt, listPrompts } from '../prompts/generate.js';
import { buildEntitlementRequired, GATED_TOOLS, isEntitled } from '../brand-data/entitlement.js';
import { recordActionAudit } from '../shared/audit.js';
import { isErrorEnvelope, NetworkError, toErrorEnvelope } from '../shared/errors.js';
import { createLogger } from '../shared/logging.js';
import { PACKAGE_VERSION, recordTelemetry } from '../shared/telemetry.js';
import { runInRequestContext } from '../shared/request-context.js';
import { classifyToolForTelemetry, telemetryOutcomeForThrown } from '../server.js';

// Side-effect import: registers every network adapter with the shared registry.
// Idempotent (module evaluation is cached) and already happens transitively via
// `../server.js`; imported directly too so this module never silently depends
// on that import ordering.
import '../networks/index.js';

import { getHostedCallInfo } from './call-context.js';
import { checkRateLimit, META_NETWORK, resolveCredentialOverlay } from './dispatch.js';
import { recordHostedAudit } from './audit.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type { HostedTransportConfig } from './env.js';
import { fetchHostedEntitlement, HostedEntitlementUnavailableError } from './entitlement-client.js';
import { consumeFreeWindow, MeterUnavailableError } from './meter-client.js';
import { listConnectedNetworks, VaultUnavailableError } from './vault-client.js';
import { buildFreeQuotaRefusal, checkNetworkCap, checkTierEntitlement } from './tier-gate.js';

const log = createLogger('hosted-transport');

const SERVER_INFO = {
  name: 'affiliate-mcp-hosted',
  version: PACKAGE_VERSION,
} as const;

/** Per-tier rate limiters (H6). `pro` also serves as the fallback for any tier not otherwise
 * differentiated: `solo` when no Solo-specific env override is set (see `env.ts`'s
 * `rateLimitCapacitySolo`/`rateLimitRefillPerSecondSolo` fallback), and `free`, whose primary
 * bound is the weekly meter (decision 2026-07-18) with this bucket only a burst guard. */
export interface HostedTierRateLimiters {
  solo: TokenBucketRateLimiter;
  pro: TokenBucketRateLimiter;
}

export interface HostedMcpServerDeps {
  config: HostedTransportConfig;
  limiters: HostedTierRateLimiters;
}

/** Builds one hosted `Server` instance with every tool/prompt handler wired. A fresh instance is
 * created per MCP session (see `http-server.ts`), matching the SDK's own streamable-HTTP example. */
export function buildHostedMcpServer(deps: HostedMcpServerDeps): Server {
  const tools = generateAllTools();
  const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    const callInfo = getHostedCallInfo();
    if (!callInfo) {
      // Defensive only: `http-server.ts` always establishes this context
      // before dispatching into the transport. Reaching here means a bug in
      // the request wiring, not a client mistake — refuse rather than run an
      // adapter call with no resolved identity or vault overlay.
      log.error({ tool: name }, 'tools/call reached with no hosted call context');
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { error: 'internal_error', message: 'No authenticated hosted request context.' },
              null,
              2,
            ),
          },
        ],
      };
    }
    const { userId, bearerToken } = callInfo;

    const tool = toolMap.get(name);
    if (!tool) {
      log.warn({ tool: name }, 'unknown tool requested');
      recordHostedAudit({ userId, network: 'meta', operation: name, outcome: 'error' });
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'unknown_tool',
                message: `No tool named "${name}" is registered.`,
                hint: 'Call affiliate_list_networks to see which networks are available, or affiliate_run_diagnostic for live capabilities.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const telemetry = classifyToolForTelemetry(name);

    // Entitlement gate: identical semantics to `src/server.ts` — dormant by
    // default, applied after the tool resolves and before its handler runs.
    if (GATED_TOOLS.has(name) && !isEntitled()) {
      recordActionAudit({
        event: 'write_denied',
        action: `brand-data.${name}`,
        network: 'meta',
        reasonCode: 'entitlement',
        summary: `${name} requires the paid brand-data tier`,
      });
      recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
      recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'denied' });
      log.info({ tool: name }, 'entitlement gate: denied');
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: JSON.stringify(buildEntitlementRequired(name), null, 2) },
        ],
      };
    }

    // H6 billing-tier gate, part 1: does this caller have any hosted tier at
    // all? Cheapest check first — one HTTP call to the hosted Worker's
    // billing route, no vault read, no rate-limit bucket touched, so a
    // `tier: 'none'` caller never causes anything downstream to run.
    let entitlement;
    try {
      entitlement = await fetchHostedEntitlement(bearerToken, deps.config.authUrl);
    } catch (err) {
      const message =
        err instanceof HostedEntitlementUnavailableError
          ? err.message
          : `unexpected error reading the hosted billing service: ${(err as Error).message}`;
      recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
      recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'error' });
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'billing_unavailable',
                message: `Could not read the hosted subscription state: ${message}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const tierRefusal = checkTierEntitlement(entitlement.tier);
    if (tierRefusal) {
      recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
      recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'denied' });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(tierRefusal, null, 2) }],
      };
    }

    // Free-tier meter (decision 2026-07-18): a `free` caller's tool calls are
    // metered to a rolling weekly report allowance. One HTTP call to the hosted
    // Worker, made ONLY for the free tier — a paid caller is never metered and
    // never hits this. The Worker owns the durable per-user, per-window count
    // (`hosted/src/meter.ts`); this consults it and, when the allowance is
    // spent, returns the structured `free_quota_exceeded` upgrade prompt. A
    // meter-service outage is surfaced honestly as `meter_unavailable`, never
    // faked into "out of free reports" nor silently waved through.
    if (entitlement.tier === 'free') {
      let meter;
      try {
        meter = await consumeFreeWindow(bearerToken, deps.config.authUrl);
      } catch (err) {
        const message =
          err instanceof MeterUnavailableError
            ? err.message
            : `unexpected error reading the hosted meter service: ${(err as Error).message}`;
        recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
        recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'error' });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'meter_unavailable', message: `Could not read the free-tier report meter: ${message}` },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (!meter.allowed) {
        const quotaRefusal = buildFreeQuotaRefusal(meter.resetAt);
        recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
        recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'denied' });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(quotaRefusal, null, 2) }],
        };
      }
    }

    // Per-user rate limit (H4, tier-aware since H6): checked before any
    // vault call or adapter dispatch, so an over-limit user never even
    // causes a vault round-trip. Solo and Pro draw from separate buckets so
    // one tier's traffic can never exhaust the other's limit.
    // Solo draws from its own bucket; `pro` and `free` share the other. Free
    // is already bounded by the weekly meter above, so the rate limiter is only
    // a burst guard for it, not its primary constraint.
    const limiter = entitlement.tier === 'solo' ? deps.limiters.solo : deps.limiters.pro;
    const rateLimitEnvelope = checkRateLimit(limiter, userId, telemetry.network, telemetry.operation);
    if (rateLimitEnvelope) {
      recordTelemetry(telemetry.network, telemetry.operation, 'rate_limit');
      recordHostedAudit({
        userId,
        network: telemetry.network,
        operation: telemetry.operation,
        outcome: 'rate_limited',
      });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(rateLimitEnvelope, null, 2) }],
      };
    }

    // H6 billing-tier gate, part 2: the Solo-tier distinct-network cap. Only
    // Solo callers pay this extra vault round-trip; Pro and (unreachable
    // here) none skip straight past `checkNetworkCap`.
    if (entitlement.tier === 'solo' && telemetry.network !== META_NETWORK) {
      let connectedNetworks: string[];
      try {
        connectedNetworks = await listConnectedNetworks(bearerToken, deps.config.vaultUrl);
      } catch (err) {
        const message =
          err instanceof VaultUnavailableError
            ? err.message
            : `unexpected error reading the hosted vault: ${(err as Error).message}`;
        recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
        recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'error' });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'vault_unavailable', message: `Could not read the connected-network list: ${message}` },
                null,
                2,
              ),
            },
          ],
        };
      }
      const capRefusal = checkNetworkCap(entitlement.tier, telemetry.network, connectedNetworks);
      if (capRefusal) {
        recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
        recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'denied' });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(capRefusal, null, 2) }],
        };
      }
    }

    // Per-request vault-credential overlay (H4 + H1 + H3): read this user's
    // stored credential for the target network, over HTTP, using the same
    // bearer token they authenticated this call with.
    const overlay = await resolveCredentialOverlay(telemetry.network, telemetry.operation, bearerToken, deps.config.vaultUrl);
    if (!overlay.ok) {
      recordTelemetry(telemetry.network, telemetry.operation, 'other_error');
      recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'error' });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(overlay.envelope, null, 2) }],
      };
    }

    try {
      const result = await runInRequestContext({ identity: userId, credentials: overlay.credentials }, () =>
        tool.handle(args),
      );
      recordTelemetry(telemetry.network, telemetry.operation, 'success');
      const requestOffset =
        typeof (args as Record<string, unknown> | undefined)?.['offset'] === 'number'
          ? ((args as Record<string, unknown>)['offset'] as number)
          : 0;
      const schemaProps = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      const guarded = guardToolResult(name, result, undefined, {
        baseOffset: requestOffset,
        offsetSupported: schemaProps?.['offset'] !== undefined,
      });
      if (guarded.outcome !== 'ok') {
        log.warn({ tool: name, outcome: guarded.outcome }, 'tool result exceeded size budget');
      }
      recordHostedAudit({
        userId,
        network: telemetry.network,
        operation: telemetry.operation,
        outcome: guarded.outcome === 'result_too_large' ? 'error' : 'success',
      });
      return {
        ...(guarded.outcome === 'result_too_large' ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: guarded.text }],
      };
    } catch (err) {
      const envelope =
        err instanceof NetworkError
          ? err.envelope
          : isErrorEnvelope(err)
            ? err
            : toErrorEnvelope(err, { network: telemetry.network, operation: name });
      log.warn({ tool: name, envelope }, 'tool invocation failed');
      recordTelemetry(telemetry.network, telemetry.operation, telemetryOutcomeForThrown(err, envelope));
      recordHostedAudit({ userId, network: telemetry.network, operation: telemetry.operation, outcome: 'error' });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      return getPrompt(req.params.name, req.params.arguments ?? {});
    } catch (err) {
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}
