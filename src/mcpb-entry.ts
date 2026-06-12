/**
 * MCPB runtime entrypoint.
 *
 * Desktop-extension hosts already own installation and configuration, so this
 * path bypasses the CLI's first-run banner and starts the stdio server
 * directly. Host-managed user_config values arrive as environment variables;
 * loadConfig() then fills any remaining values from an existing local config.
 */

import { loadConfig } from './shared/config.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  loadConfig();
  await startServer();
  await new Promise<never>(() => {});
}

void main().catch((err: unknown) => {
  process.stderr.write(`affiliate-networks-mcp MCPB fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
