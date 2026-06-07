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

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { buildErrorEnvelope, NetworkError } from './errors.js';
import type { NetworkSlug } from './types.js';
import { createLogger } from './logging.js';

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
 * Read an env variable. Returns `undefined` when unset or blank. Does NOT
 * throw — see `requireCredential` for the throw-on-missing variant.
 */
export function getCredential(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v.trim() === '') return undefined;
  return v;
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
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: context.network,
        operation: context.operation,
        message: `Missing required credential ${name}.`,
        hint:
          context.hint ??
          `Run \`affiliate-networks-mcp setup\` to provide ${name}, or set it in ${CONFIG_ENV_FILE}.`,
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

// ───────────────────────────────────────────────────────────────────────────
// Licence verification (desktop-app-plan.md §2A — "The one core change").
//
// VERIFICATION ONLY. This code has no side effects at import time, makes no
// network calls, and is never invoked from the MCP server/CLI runtime path.
// The MCP engine runs with no licence: the gate/enforcement lives in the
// desktop app shell, not here. The server never checks a licence.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Ed25519 PUBLIC key (SPKI DER, base64) used to verify licence tokens.
 *
 * DEV KEY — generated by `scripts/generate-licence-keypair.ts`. For production
 * a human regenerates the pair, replaces this constant with the new public
 * key, and stores the matching private key as the Worker's `LICENCE_SIGNING_KEY`
 * secret. The private key is never committed (`/licence-keys/` is gitignored).
 */
export const LICENCE_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEAJGmqSI8zTKHXsqIBH0jpUfL9+FP+/WJxZpODnviRWAI=';

/** Token prefix — the licence string always starts with this. */
const LICENCE_TOKEN_PREFIX = 'amcp_';

/**
 * Encode bytes as base64url (RFC 4648 §5): `+`→`-`, `/`→`_`, no `=` padding.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a base64url string (RFC 4648 §5) back to bytes. Rejects input that is
 * not valid base64url by re-encoding and comparing — Node's base64 decoder is
 * lenient, so we verify the round-trip to catch malformed tokens.
 */
export function base64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('invalid base64url');
  }
  const buf = Buffer.from(input, 'base64url');
  if (base64urlEncode(buf) !== input) {
    throw new Error('invalid base64url');
  }
  return buf;
}

/** Successful licence verification result. */
export interface LicenceValid {
  valid: true;
  email: string;
  issued: string;
  lid: string;
}

/** Failed licence verification result with a human-readable reason. */
export interface LicenceInvalid {
  valid: false;
  reason: string;
}

export type LicenceResult = LicenceValid | LicenceInvalid;

/**
 * Verify a licence token offline against the embedded Ed25519 public key.
 *
 * Token format v1 (must match the Worker's signer byte-for-byte):
 *   payload = { lid, email, product: "desktop", issued: "YYYY-MM-DD", v: 1 }
 *   payloadBytes = UTF-8 of JSON.stringify(payload)
 *   sigBytes = raw Ed25519 signature (64 bytes) over payloadBytes
 *   token = "amcp_" + base64url(payloadBytes) + "." + base64url(sigBytes)
 *
 * Pure: no I/O, never throws — always returns the discriminated result.
 */
export function verifyLicenceToken(token: string): LicenceResult {
  if (typeof token !== 'string' || !token.startsWith(LICENCE_TOKEN_PREFIX)) {
    return { valid: false, reason: 'Not a valid licence key.' };
  }
  const body = token.slice(LICENCE_TOKEN_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { valid: false, reason: 'Licence key is malformed.' };
  }
  const [p, s] = parts as [string, string];

  let payloadBytes: Buffer;
  let sigBytes: Buffer;
  try {
    payloadBytes = base64urlDecode(p);
    sigBytes = base64urlDecode(s);
  } catch {
    return { valid: false, reason: 'Licence key is malformed.' };
  }

  let signatureOk: boolean;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(LICENCE_PUBLIC_KEY_SPKI_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    signatureOk = cryptoVerify(null, payloadBytes, publicKey, sigBytes);
  } catch {
    return { valid: false, reason: 'Licence signature could not be verified.' };
  }
  if (!signatureOk) {
    return { valid: false, reason: 'Licence signature is invalid.' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { valid: false, reason: 'Licence payload is not readable.' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, reason: 'Licence payload is not readable.' };
  }
  const { lid, email, product, issued, v } = payload as Record<string, unknown>;

  if (v !== 1) {
    return { valid: false, reason: 'Licence version is not supported.' };
  }
  if (product !== 'desktop') {
    return { valid: false, reason: 'Licence is not for this product.' };
  }
  if (typeof lid !== 'string' || typeof email !== 'string' || typeof issued !== 'string') {
    return { valid: false, reason: 'Licence payload is incomplete.' };
  }

  return { valid: true, email, issued, lid };
}

/**
 * Read and verify the licence file. Defaults to `<config-dir>/licence`, where
 * the config dir honours `AFFILIATE_MCP_CONFIG_DIR` the same way
 * `resolveConfigEnvFile()` does. The file stores the token string verbatim on a
 * single line; whitespace/newlines are trimmed on read.
 *
 * Returns `{ valid: false, reason: 'No licence found.' }` when absent. Never
 * throws.
 */
export function readLicence(filePath?: string): LicenceResult {
  let resolved = filePath;
  if (resolved === undefined) {
    const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    const dir = override && override.trim() !== '' ? override : CONFIG_DIR;
    resolved = path.join(dir, 'licence');
  }
  if (!existsSync(resolved)) {
    return { valid: false, reason: 'No licence found.' };
  }
  let contents: string;
  try {
    contents = readFileSync(resolved, 'utf8');
  } catch {
    return { valid: false, reason: 'Licence file could not be read.' };
  }
  return verifyLicenceToken(contents.trim());
}
