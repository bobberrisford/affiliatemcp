/**
 * Public entrypoint for the hosted MCP transport (H4). Re-exports the pieces
 * a caller needs: `startHostedHttpServer` for both the CLI subcommand
 * (`src/index.ts`, `hosted-transport`) and the end-to-end test suite
 * (`tests/hosted-transport/`), and `loadHostedTransportConfig` to read
 * `process.env` the same way the CLI does.
 */

export { startHostedHttpServer, type HostedHttpServerHandle } from './http-server.js';
export { loadHostedTransportConfig, type HostedTransportConfig } from './env.js';
export { buildHostedMcpServer } from './mcp-server.js';
