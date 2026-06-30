/**
 * MCP server entry — stdio transport.
 *
 * Boots a `Server` from `@modelcontextprotocol/sdk`, registers every tool
 * produced by `tools/generate.ts`, and routes incoming `tools/call` requests
 * to the corresponding adapter method.
 *
 * Failure routing (PRD principle 4.1):
 *   - Adapter throws → response content is a `NetworkErrorEnvelope` (JSON in a
 *     text content block), with `isError: true` on the CallToolResult. We do
 *     NOT raise transport-level errors for adapter failures — the user must be
 *     able to see what failed.
 *   - Unknown tool name → text content explaining the miss; never an opaque
 *     "an error occurred".
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { generateAllTools, type ToolDefinition } from './tools/generate.js';
import { getPrompt, listPrompts } from './prompts/generate.js';
import { isErrorEnvelope, NetworkError, toErrorEnvelope } from './shared/errors.js';
import { createLogger } from './shared/logging.js';
import {
  flushTelemetry,
  PACKAGE_VERSION,
  recordTelemetry,
  telemetryOutcomeFromErrorType,
} from './shared/telemetry.js';
import { runStartupUpdateCheck } from './shared/update-check.js';

// Side-effect import: registers every network adapter with the shared registry.
// Must precede any code path that calls `getAdapters()` / `getAdapter()`.
import './networks/index.js';

const log = createLogger('server');

const SERVER_INFO = {
  name: 'affiliate-mcp',
  // Single source of truth, kept in sync with package.json by the release
  // process and a version-sync test. Previously hardcoded to a stale '0.1.0',
  // which both misreported to clients and would mislead the update check.
  version: PACKAGE_VERSION,
} as const;

export interface TelemetryToolClassification {
  network: string;
  operation: string;
}

const META_TOOL_OPERATIONS = new Map<string, string>([
  ['affiliate_list_networks', 'list_networks'],
  ['affiliate_run_diagnostic', 'run_diagnostic'],
  ['affiliate_resolve_brand', 'resolve_brand'],
  ['affiliate_get_client_strategy', 'get_client_strategy'],
  ['affiliate_set_client_strategy', 'set_client_strategy'],
  ['affiliate_list_client_strategies', 'list_client_strategies'],
  ['affiliate_list_actions', 'list_actions'],
]);

export async function startServer(): Promise<void> {
  void flushTelemetry();
  void runStartupUpdateCheck();
  recordTelemetry('lifecycle', 'server_start', 'success');
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
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn({ tool: name }, 'unknown tool requested');
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

    try {
      const result = await tool.handle(args);
      const telemetry = classifyToolForTelemetry(name);
      recordTelemetry(telemetry.network, telemetry.operation, 'success');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const telemetry = classifyToolForTelemetry(name);
      const envelope =
        err instanceof NetworkError
          ? err.envelope
          : isErrorEnvelope(err)
            ? err
            : toErrorEnvelope(err, { network: telemetry.network, operation: name });
      log.warn({ tool: name, envelope }, 'tool invocation failed');
      recordTelemetry(
        telemetry.network,
        telemetry.operation,
        telemetryOutcomeFromErrorType(envelope.type),
      );
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(envelope, null, 2),
          },
        ],
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
      throw new McpError(
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ tools: tools.length }, 'affiliate-mcp server started on stdio');
}

export function classifyToolForTelemetry(toolName: string): TelemetryToolClassification {
  const metaOperation = META_TOOL_OPERATIONS.get(toolName);
  if (metaOperation) return { network: 'meta', operation: metaOperation };
  return { network: extractNetwork(toolName), operation: extractOperation(toolName) };
}

/** Best-effort: pull the network slug out of a tool name `affiliate_<slug>_<op>`. */
function extractNetwork(toolName: string): string {
  const parts = toolName.split('_');
  if (parts.length >= 3 && parts[0] === 'affiliate') return parts[1] ?? 'unknown';
  return 'meta';
}

function extractOperation(toolName: string): string {
  const parts = toolName.split('_');
  if (parts.length < 3 || parts[0] !== 'affiliate') return 'unknown';
  return parts.slice(2).join('_') || 'unknown';
}
