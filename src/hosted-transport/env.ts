/**
 * Hosted-transport configuration (workstream slice H4:
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Every value here is read from `process.env` at call time (not cached at
 * import time) so tests can set and reset them per case without module
 * reloads. See the file-header comment in `http-server.ts` for why this
 * transport is a Node service in the root workspace rather than code running
 * inside the `hosted/` Cloudflare Worker.
 */

const DEFAULT_PORT = 8787;
const DEFAULT_RATE_LIMIT_CAPACITY = 60; // tool calls
const DEFAULT_RATE_LIMIT_REFILL_PER_SECOND = 1; // tool calls/sec sustained

export interface HostedTransportConfig {
  /** Base URL of the hosted Worker's auth surface, e.g. `https://affiliate-mcp-hosted.example.workers.dev`. */
  authUrl: string;
  /** Base URL of the hosted Worker's vault surface. Same Worker as `authUrl` today; kept as a
   * separate config value because the vault and auth surfaces are allowed to diverge later
   * (e.g. a dedicated vault service) without a transport code change. */
  vaultUrl: string;
  /** TCP port the Node HTTP server listens on. */
  port: number;
  /** Token-bucket capacity: the maximum burst of tool calls a single user may make. Used for the
   * Pro tier, and as the Solo-tier default when no Solo-specific override is set (H6). */
  rateLimitCapacity: number;
  /** Token-bucket refill rate, in tool calls per second, per user. Same Pro/Solo-default split
   * as `rateLimitCapacity`. */
  rateLimitRefillPerSecond: number;
  /** Solo-tier token-bucket capacity override (H6: `docs/product/hosted-mvp-workstream.md`,
   * "Rate-limit tiers may differ by tier via env config"). Falls back to `rateLimitCapacity`
   * when unset — Solo and Pro share one limiter configuration until an operator deliberately
   * differentiates them. Optional so existing callers that construct this config directly
   * (tests, and any future caller) are not forced to set it. */
  rateLimitCapacitySolo?: number;
  /** Solo-tier refill-rate override. Falls back to `rateLimitRefillPerSecond` when unset. */
  rateLimitRefillPerSecondSolo?: number;
}

function readUrl(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `${name} is not configured. The hosted MCP transport needs the hosted Worker's base URL ` +
        `to verify sessions and read vault credentials — set it before starting ` +
        `\`affiliate-networks-mcp hosted-transport\`.`,
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid absolute URL: "${raw}"`);
  }
  return raw.replace(/\/+$/, '');
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number when set; got "${raw}".`);
  }
  return n;
}

/** Read and validate the hosted transport's configuration from `process.env`. */
export function loadHostedTransportConfig(): HostedTransportConfig {
  const rateLimitCapacity = readPositiveInt('HOSTED_RATE_LIMIT_CAPACITY', DEFAULT_RATE_LIMIT_CAPACITY);
  const rateLimitRefillPerSecond = readPositiveInt(
    'HOSTED_RATE_LIMIT_REFILL_PER_SECOND',
    DEFAULT_RATE_LIMIT_REFILL_PER_SECOND,
  );
  return {
    authUrl: readUrl('HOSTED_AUTH_URL'),
    vaultUrl: readUrl('HOSTED_VAULT_URL'),
    port: readPositiveInt('HOSTED_TRANSPORT_PORT', DEFAULT_PORT),
    rateLimitCapacity,
    rateLimitRefillPerSecond,
    // Solo-tier overrides fall back to the shared/Pro values when unset (H6).
    rateLimitCapacitySolo: readPositiveInt('HOSTED_RATE_LIMIT_CAPACITY_SOLO', rateLimitCapacity),
    rateLimitRefillPerSecondSolo: readPositiveInt(
      'HOSTED_RATE_LIMIT_REFILL_PER_SECOND_SOLO',
      rateLimitRefillPerSecond,
    ),
  };
}
