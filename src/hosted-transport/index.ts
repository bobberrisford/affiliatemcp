/**
 * Public entrypoint for the hosted MCP transport (H4). Re-exports the pieces
 * a caller needs: `startHostedHttpServer` for both the CLI subcommand
 * (`src/index.ts`, `hosted-transport`) and the end-to-end test suite
 * (`tests/hosted-transport/`), and `loadHostedTransportConfig` to read
 * `process.env` the same way the CLI does.
 */

export { startHostedHttpServer, type HostedHttpServerHandle } from './http-server.js';
export { loadHostedTransportConfig, type HostedTransportConfig } from './env.js';
export { buildHostedMcpServer, type HostedMcpServerDeps, type HostedTierRateLimiters } from './mcp-server.js';
export {
  fetchHostedEntitlement,
  HostedEntitlementUnavailableError,
  type HostedEntitlement,
  type HostedTier,
} from './entitlement-client.js';
export { checkNetworkCap, checkTierEntitlement, SOLO_NETWORK_CAP, type HostedTierRefusal } from './tier-gate.js';
export { listConnectedNetworks } from './vault-client.js';
