/**
 * Resolve the wizard's config directory + env file path.
 *
 * The shared loader (`src/shared/config.ts`) hardcodes `~/.affiliate-mcp/.env`.
 * The wizard, however, must honour `AFFILIATE_MCP_CONFIG_DIR` so users (and
 * the integration tests) can sandbox setup without touching their real home
 * directory. PRD §15.18.
 *
 * Read this every call rather than at module load — tests mutate the env var
 * between cases.
 */

import path from 'node:path';
import { homedir } from 'node:os';

export interface ConfigPaths {
  dir: string;
  envFile: string;
}

export function resolveConfigPaths(): ConfigPaths {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const dir = override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
  return { dir, envFile: path.join(dir, '.env') };
}
