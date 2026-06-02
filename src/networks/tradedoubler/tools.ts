/**
 * Tradedoubler-specific MCP tools.
 *
 * Supplements the standard publisher operations (listProgrammes, etc.) with
 * Tradedoubler-specific endpoints that don't map to the shared canonical
 * operation set.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../../tools/types.js';
import { toJsonSchema } from '../../tools/schema.js';
import { tradedoublerAdapter } from './adapter.js';

const EmptySchema = z.object({}).strict();

export function generateTradedoublerTools(): ToolDefinition[] {
  return [
    tool(
      'affiliate_tradedoubler_list_publisher_sources',
      'List the publisher sources (registered websites/sites) for the Tradedoubler account. ' +
        'Use this to discover available source/site IDs — the `id` of each source is the site ID used as the `a=` parameter in tracking links, and can be used as a filter in programme and transaction endpoints. ' +
        'Returns an array of sources with id, name, url, type, and status; pair with list_programmes to scope results to a specific site.',
      EmptySchema,
      () => tradedoublerAdapter.listPublisherSources(),
    ),
  ];
}

function tool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  handle: (args: unknown) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: toJsonSchema(schema),
    handle,
  };
}
