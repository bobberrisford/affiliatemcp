/**
 * Production stateless surface: the same hosted tool registry and gate
 * pipeline the legacy sessionful path runs (`pipeline.ts`), exposed through
 * the stateless handler's surface contract. A stateless `tools/call` runs the
 * identical sequence a legacy one does — bearer verification happened in
 * `http-server.ts`, then entitlement, tier gate, meter, rate limit, network
 * cap, vault overlay, adapter dispatch, audit — because both call
 * `executeHostedToolCall`. No production tool names a required client
 * capability and none carries an `x-mcp-header` annotation, so the handler's
 * -32021 and Mcp-Param machinery is inert on this surface.
 *
 * `HOSTED_CONFORMANCE_FIXTURES=1` (harness-only, `env.ts`) appends the
 * official conformance suite's diagnostic fixtures so
 * `npm run conformance:hosted` can exercise the protocol behaviours the
 * production tools never trigger. The flag is never set in production config.
 */

import { getPrompt, listPrompts } from '../prompts/generate.js';

import type { HostedTransportConfig } from './env.js';
import {
  buildHostedToolRegistry,
  executeHostedToolCall,
  SERVER_INFO,
  type HostedTierRateLimiters,
} from './pipeline.js';
import type { StatelessSurface, StatelessToolDefinition } from './stateless-handler.js';
import {
  buildConformanceFixtureCompletion,
  buildConformanceFixturePrompts,
  buildConformanceFixtureResources,
  buildConformanceFixtureTools,
} from './conformance-fixtures.js';

export interface StatelessSurfaceDeps {
  config: HostedTransportConfig;
  limiters: HostedTierRateLimiters;
}

/** Build the production stateless surface once per process (tool generation is
 * not per-request work). */
export function buildHostedStatelessSurface(deps: StatelessSurfaceDeps): StatelessSurface {
  const { toolMap } = buildHostedToolRegistry();

  const tools: StatelessToolDefinition[] = [...toolMap.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
    call: (args) => executeHostedToolCall(deps, toolMap, tool.name, args),
  }));

  const fixturePrompts = deps.config.conformanceFixtures ? buildConformanceFixturePrompts() : [];
  if (deps.config.conformanceFixtures) {
    tools.push(...buildConformanceFixtureTools());
  }

  return {
    serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
    tools,
    prompts: {
      list: () => [...listPrompts(), ...fixturePrompts.map((p) => p.definition)],
      get: (name, args) => {
        const fixture = fixturePrompts.find((p) => p.definition.name === name);
        if (fixture) return fixture.get(args);
        return getPrompt(name, args);
      },
    },
    // The production server has no resources and offers no argument
    // completion; the fixture surface provides both so the corresponding
    // scenarios exercise real handler paths.
    ...(deps.config.conformanceFixtures
      ? { resources: buildConformanceFixtureResources(), complete: buildConformanceFixtureCompletion() }
      : {}),
  };
}
