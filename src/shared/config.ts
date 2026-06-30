/**
 * Credential + config loader.
 *
 * Reads `~/.affiliate-mcp/.env` if present and overlays it onto `process.env`
 * (process.env wins so test harnesses can override). No `dotenv` dependency —
 * the file format is intentionally small: `KEY=value` lines, `#` comments,
 * blank lines ignored. Values may be wrapped in single or double quotes.
 *
 * Missing required credentials surface as `config_error` envelopes via
 * `requireCredential` — never silently substituted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildErrorEnvelope, NetworkError } from './errors.js';
import type { NetworkSlug } from './types.js';
import { createLogger } from './logging.js';
import { telemetrySurface, type TelemetrySurface } from './telemetry.js';

const log = createLogger('config');

export const CONFIG_DIR = path.join(homedir(), '.affiliate-mcp');
export const CONFIG_ENV_FILE = path.join(CONFIG_DIR, '.env');

/**
 * Polish (Chunk 10): resolve the active config directory, honouring the
 * `AFFILIATE_MCP_CONFIG_DIR` env override. The wizard already honoured this in
 * `src/cli/wizard/paths.ts`, but `isFirstRun()` and `loadConfig()` historically
 * read the hardcoded `~/.affiliate-mcp/.env` — meaning the first-run banner and
 * the auto-load would ignore the override. PRD §15.18: keep the config location
 * consistent across every surface.
 *
 * Read on every call rather than at module load — tests mutate the env var
 * between cases. Returns the effective `.env` path.
 */
export function resolveConfigEnvFile(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const dir = override && override.trim() !== '' ? override : CONFIG_DIR;
  return path.join(dir, '.env');
}

let loaded = false;

/**
 * Parse a `.env`-style file. Public for test ergonomics; main entrypoint is `loadConfig`.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load `~/.affiliate-mcp/.env` once per process. Subsequent calls are no-ops.
 * Returns whether a config file was found.
 *
 * Polish (Chunk 10): when no explicit `filePath` is passed we resolve via
 * `resolveConfigEnvFile()` so `AFFILIATE_MCP_CONFIG_DIR` is honoured.
 */
export function loadConfig(filePath: string = resolveConfigEnvFile()): boolean {
  if (loaded) return existsSync(filePath);
  loaded = true;
  if (!existsSync(filePath)) {
    log.debug({ filePath }, 'no config file found');
    return false;
  }
  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed = parseEnvFile(text);
    for (const [k, v] of Object.entries(parsed)) {
      // process.env wins — allow overrides from the shell / launcher.
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
      }
    }
    log.debug({ filePath, keys: Object.keys(parsed).length }, 'config loaded');
    return true;
  } catch (err) {
    log.warn({ err: (err as Error).message, filePath }, 'failed to read config file');
    return false;
  }
}

/** Test-only: reset the memoised load flag. */
export function _resetConfigForTests(): void {
  loaded = false;
}

/**
 * Patterns that mean "this looks like a credential value but is not a real one".
 *
 * Why this exists: the Claude Desktop bundle maps each credential to a host
 * placeholder, e.g. `AWIN_API_TOKEN=${user_config.awin_api_token}`
 * (`scripts/build-mcpb.ts`), on `required: false` fields. When a user leaves a
 * field blank, Claude Desktop passes the *literal, unsubstituted* placeholder
 * string through as the env value. Likewise, a user who copies
 * `examples/claude-desktop-config.json` without editing it ships `your-token-here`.
 * Both are non-empty strings, so the plain blank check below treats them as
 * configured and the adapter sends them upstream as a real token — producing a
 * confusing 401 instead of the helpful `config_error` setup path. We classify
 * them as missing so the unconfigured-network journey stays clear.
 */
const PLACEHOLDER_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Unresolved Claude Desktop bundle placeholder, e.g. `${user_config.awin_api_token}`.
  /^\$\{user_config\.[^}]*\}$/,
  // Unedited example sentinel from docs/examples, e.g. `your-token-here`, `your-id-here`.
  /^your-[\w-]*-here$/i,
];

/**
 * True when a value is a recognised unresolved placeholder or documented
 * example sentinel rather than a real credential. Exported for the
 * configuration-readiness surface (`affiliate_list_networks`) and tests.
 */
export function isPlaceholderCredential(value: string): boolean {
  const v = value.trim();
  return PLACEHOLDER_CREDENTIAL_PATTERNS.some((re) => re.test(v));
}

/**
 * Read an env variable. Returns `undefined` when unset, blank, or set to a
 * recognised unresolved placeholder / example sentinel (see
 * `isPlaceholderCredential`). Does NOT throw — see `requireCredential` for the
 * throw-on-missing variant.
 */
export function getCredential(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v.trim() === '') return undefined;
  if (isPlaceholderCredential(v)) return undefined;
  return v;
}

/**
 * Surface-aware "how to set this credential" guidance. Mirrors
 * `updateInstructionForSurface` (`src/shared/update-check.ts`): the same
 * `telemetrySurface()` signal that tailors the update notice tailors the setup
 * hint, so a user is always told where to enter the credential for the way they
 * installed — the extension settings for the Desktop bundle, the CLI wizard for
 * an npm install.
 */
export function setupInstructionForSurface(
  name: string,
  surface: TelemetrySurface = telemetrySurface(),
): string {
  switch (surface) {
    case 'mcpb':
    case 'desktop-bundle':
      return `Open Claude Desktop -> Settings -> Extensions -> Affiliate Networks and enter ${name} in the extension's configuration.`;
    case 'npm':
    case 'unknown':
    default:
      return `Run \`affiliate-networks-mcp setup\` to provide ${name}, or set it in ${CONFIG_ENV_FILE}.`;
  }
}

/**
 * Throw a `NetworkError` carrying a `config_error` envelope when the named
 * credential is missing or blank. Used by adapters at the start of every op.
 */
export function requireCredential(
  name: string,
  context: { network: NetworkSlug; operation: string; hint?: string },
): string {
  const v = getCredential(name);
  if (v === undefined) {
    const where = setupInstructionForSurface(name);
    // Keep any adapter-supplied guidance about *where to obtain* the credential
    // (e.g. "generate a token at the dashboard"), then always append the
    // surface-correct *where to enter it* step so the next action matches how
    // the user installed.
    const hint = context.hint ? `${context.hint} ${where}` : where;
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: context.network,
        operation: context.operation,
        message: `Missing required credential ${name}.`,
        hint,
      }),
    );
  }
  return v;
}

/**
 * True when the standard config file does not yet exist; used by the CLI
 * entry point to decide whether to print the first-run banner.
 *
 * Polish (Chunk 10): default to `resolveConfigEnvFile()` so the
 * `AFFILIATE_MCP_CONFIG_DIR` override is respected. PRD §15.18.
 */
export function isFirstRun(filePath: string = resolveConfigEnvFile()): boolean {
  return !existsSync(filePath);
}
