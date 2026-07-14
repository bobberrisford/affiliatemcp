/**
 * Hosted MCP `Server` wiring (H4).
 *
 * Deliberately structured to mirror `src/server.ts`'s `CallToolRequestSchema`
 * handler closely — same tool registry (`generateAllTools`), same entitlement
 * gate, same error-envelope and result-size-guard handling, same telemetry
 * classification — so a reviewer can diff the two side by side. `src/server.ts`
 * itself is untouched by this slice (the workstream brief requires the local
 * stdio path stay byte-identical); this is a parallel, additive module, not a
 * refactor of it. The only behavioural additions are hosted-only: resolving
 * the per-request identity and vault-credential overlay
 * (`getHostedCallInfo`/`resolveCredentialOverlay`), the per-user rate limit
 * (`checkRateLimit`), and the per-user audit line (`recordHostedAudit`).
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
import { PACKAGE_VERSION, recordTelemetry, telemetryOutcomeFromErrorType } from '../shared/telemetry.js';
import { runInRequestContext } from '../shared/request-context.js';
import { classifyToolForTelemetry } from '../server.js';

// Side-effect import: registers every network adapter with the shared registry.
// Idempotent (module evaluation is cached) and already happens transitively via
// `../server.js`; imported directly too so this module never silently depends
// on that import ordering.
import '../networks/index.js';

import { getHostedCallInfo } from './call-context.js';
import { checkRateLimit, resolveCredentialOverlay } from './dispatch.js';
import { recordHostedAudit } from './audit.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type { HostedTransportConfig } from './env.js';

const log = createLogger('hosted-transport');

const SERVER_INFO = {
  name: 'affiliate-mcp-hosted',
  version: PACKAGE_VERSION,
} as const;

export interface HostedMcpServerDeps {
  config: HostedTransportConfig;
  limiter: TokenBucketRateLimiter;
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

    // Per-user rate limit (H4): checked before any vault call or adapter
    // dispatch, so an over-limit user never even causes a vault round-trip.
    const rateLimitEnvelope = checkRateLimit(deps.limiter, userId, telemetry.network, telemetry.operation);
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
      recordTelemetry(telemetry.network, telemetry.operation, telemetryOutcomeFromErrorType(envelope.type));
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
