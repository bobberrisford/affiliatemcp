/**
 * Configuration for the digest-compose service (workstream slice H6,
 * redesigned per Rob's 2026-07-14 decision — see `hosted/README.md`,
 * "Digest orchestration and token scopes"). This service holds NO roster,
 * NO email addresses, and NO credential of its own: it composes one user's
 * digest text on request, authorised entirely by the short-lived,
 * digest-scoped, per-user session token the hosted Worker's scheduled
 * handler mints and presents as the bearer on each `POST /compose` call.
 *
 * `HOSTED_VAULT_URL` is the same env var the hosted MCP transport reads;
 * both point at the same hosted Worker's vault surface. There is no
 * `HOSTED_AUTH_URL` here: the compose service never verifies tokens itself
 * (the vault routes it calls do that), so it has no reason to reach the
 * auth surface.
 */

const DEFAULT_PORT = 8788; // one above the hosted MCP transport's default

function readUrl(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `${name} is not configured. The digest-compose service needs the hosted Worker's base URL ` +
        `for its vault reads. Set it before running \`affiliate-networks-mcp hosted-digest\`.`,
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

export interface HostedDigestConfig {
  /** Base URL of the hosted Worker's vault surface (list + reveal routes). */
  vaultUrl: string;
  /** TCP port the compose service listens on. `0` picks an ephemeral port (tests). */
  port: number;
  /**
   * Optional doorbell shared with the hosted Worker (`DIGEST_COMPOSE_SECRET`
   * on its side): when set, every `POST /compose` must carry it in the
   * `x-compose-auth` header. It only stops strangers from ringing the
   * endpoint. Leaking it grants NO data access, because every read this
   * service performs is authorised by the caller's per-user digest token,
   * never by this value. A doorbell, not a key.
   */
  composeSecret?: string;
}

/** Read and validate the compose service's configuration from `process.env`. */
export function loadHostedDigestConfig(): HostedDigestConfig {
  const composeSecret = process.env['DIGEST_COMPOSE_SECRET'];
  return {
    vaultUrl: readUrl('HOSTED_VAULT_URL'),
    port: readPositiveInt('DIGEST_SERVICE_PORT', DEFAULT_PORT),
    ...(composeSecret && composeSecret.trim().length > 0 ? { composeSecret } : {}),
  };
}
