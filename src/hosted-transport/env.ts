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
  /**
   * Maximum permitted session-token lifetime in seconds, for the staged OAuth
   * bearer migration (`docs/decisions/2026-07-15-hosted-connector-oauth.md`).
   *
   * UNSET (the default) is the dual-accept window: no cap is applied, so the
   * transport accepts BOTH short-lived OAuth access tokens and the legacy
   * long-lived pasted `amcps_` bearers. Setting it drops long-lived bearer
   * acceptance: any session whose lifetime (`exp - iss`) exceeds this is
   * rejected, so a value comfortably above the one-hour OAuth access-token TTL
   * and far below the 30-day bearer (recommended ~7200) keeps OAuth access
   * tokens working while rejecting every pasted bearer. Flipping it on is thus
   * both the cutover and the documented revocation path for all outstanding
   * bearers at once. Optional so callers that construct this config directly
   * (tests) are not forced to set it. */
  maxTokenLifetimeSeconds?: number;
  /**
   * The transport's OWN public origin — the URL a user adds as an MCP custom
   * connector (`HOSTED_TRANSPORT_PUBLIC_URL`, `env.ts`). It gates OAuth
   * discovery (slice 2b, `docs/decisions/2026-07-15-hosted-connector-oauth.md`):
   *
   * UNSET (the default) — discovery is disabled and the transport keeps its
   * current bare-401 behaviour: no `WWW-Authenticate` header, and
   * `GET /.well-known/oauth-protected-resource` returns 404. Backward-compatible
   * with every pre-2b deploy.
   *
   * SET — the transport advertises the authorization server for client OAuth
   * discovery per the MCP authorization framework + RFC 9728: its `401`s carry a
   * `WWW-Authenticate: Bearer resource_metadata="…"` challenge pointing at its
   * own protected-resource metadata document, whose `authorization_servers`
   * names `authUrl` (the Worker's OAuth issuer). This is what lets a client
   * pointed only at the transport find the Worker, which is a different origin.
   *
   * Always the ORIGIN: `HOSTED_TRANSPORT_PUBLIC_URL` is normalised to its
   * scheme+host+port (`readOptionalOrigin`), so setting it to a path-bearing
   * value such as the `…/mcp` endpoint still yields a working metadata URL
   * rather than a 404. Optional so callers that construct this config directly
   * (tests) are not forced to set it. */
  resourceUrl?: string;
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

/** Like `readUrl` but with no requirement: returns `undefined` when the env var
 * is unset or empty, and applies the same absolute-URL validation and
 * trailing-slash strip to a set value. Used for the optional transport
 * public-URL that gates OAuth discovery (slice 2b), whose absence is a
 * meaningful state (discovery disabled, bare-401 behaviour preserved), not a
 * value to substitute or a reason to throw. */
/** Read an optional absolute URL and return its ORIGIN (scheme + host + port),
 * discarding any path/query/fragment. Returns `undefined` when unset/empty;
 * throws only on a set-but-invalid value. Normalising to the origin means a
 * deployer who sets a path-bearing value (for example the `…/mcp` endpoint
 * rather than the bare origin) still gets a working
 * `/.well-known/oauth-protected-resource` URL, rather than a silent 404 on the
 * advertised metadata path. */
function readOptionalOrigin(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`${name} is not a valid absolute URL: "${raw}"`);
  }
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

/** Like `readPositiveInt` but with no default: returns `undefined` when the
 * env var is unset or empty, and throws on a set-but-invalid value (same
 * validation tone). Used for the optional token-lifetime cap, whose absence is
 * a meaningful state (the dual-accept window), not a value to substitute. */
function readOptionalPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return undefined;
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
    // Unset = dual-accept window (accept both legacy bearers and OAuth access
    // tokens); set it to drop long-lived bearer acceptance (staged migration).
    maxTokenLifetimeSeconds: readOptionalPositiveInt('HOSTED_MAX_TOKEN_LIFETIME_SECONDS'),
    // Unset = OAuth discovery disabled (bare-401, no protected-resource
    // metadata); set it to the transport's own public origin to advertise the
    // auth server for client OAuth discovery (slice 2b).
    resourceUrl: readOptionalOrigin('HOSTED_TRANSPORT_PUBLIC_URL'),
  };
}
