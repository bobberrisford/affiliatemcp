/**
 * Shared MCP tool definition shape.
 *
 * Kept outside `generate.ts` so network-specific tool packs can register
 * additional tools without creating an import cycle back into the generator.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Bound handler. Resolves to the result the MCP server should return as content. */
  handle: (args: unknown) => Promise<unknown>;
}
