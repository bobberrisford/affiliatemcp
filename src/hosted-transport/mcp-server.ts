/**
 * Hosted MCP `Server` wiring (H4, extended by H6) for the LEGACY sessionful
 * Streamable HTTP path.
 *
 * Deliberately structured to mirror `src/server.ts`'s `CallToolRequestSchema`
 * handler closely — same tool registry (`generateAllTools`), same entitlement
 * gate, same error-envelope and result-size-guard handling, same telemetry
 * classification — so a reviewer can diff the two side by side. Since the
 * MCP 2026-07-28 early-adoption work
 * (`docs/decisions/2026-07-29-mcp-2026-07-28-early-adoption.md`) the actual
 * tools/call gate sequence lives in `pipeline.ts` (`executeHostedToolCall`),
 * shared verbatim with the stateless path; this module only owns the SDK
 * `Server` wrapper for legacy sessions. See `pipeline.ts` for the gate
 * ordering rationale.
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

import { getPrompt, listPrompts } from '../prompts/generate.js';

import {
  buildHostedToolRegistry,
  executeHostedToolCall,
  SERVER_INFO,
  type HostedTierRateLimiters,
} from './pipeline.js';
import type { HostedTransportConfig } from './env.js';

export type { HostedTierRateLimiters } from './pipeline.js';

export interface HostedMcpServerDeps {
  config: HostedTransportConfig;
  limiters: HostedTierRateLimiters;
}

/** Builds one hosted `Server` instance with every tool/prompt handler wired. A fresh instance is
 * created per MCP session (see `http-server.ts`), matching the SDK's own streamable-HTTP example. */
export function buildHostedMcpServer(deps: HostedMcpServerDeps): Server {
  const { tools, toolMap } = buildHostedToolRegistry();

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

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    executeHostedToolCall(deps, toolMap, req.params.name, req.params.arguments),
  );

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
