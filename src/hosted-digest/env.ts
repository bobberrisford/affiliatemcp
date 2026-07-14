/**
 * Configuration for the hosted-digest job (workstream slice H6:
 * `docs/product/hosted-mvp-workstream.md`). Reuses the hosted MCP
 * transport's `HOSTED_AUTH_URL`/`HOSTED_VAULT_URL` env vars — both point at
 * the same hosted Worker this job also talks to — plus its own
 * `HOSTED_SERVICE_SECRET`, the shared secret that authorises the
 * service-only routes (`GET /admin/subscribers`, `POST /admin/session`,
 * `POST /digest/send`). See `hosted/src/routes/admin.ts`'s file-header
 * comment for the threat-model trade-off that secret represents.
 */

function readUrl(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `${name} is not configured. The hosted-digest job needs the hosted Worker's base URL — ` +
        `set it before running \`affiliate-networks-mcp hosted-digest\`.`,
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

function readSecret(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    throw new Error(`${name} is not configured. The hosted-digest job cannot authenticate without it.`);
  }
  return raw;
}

export interface HostedDigestConfig {
  /** Base URL of the hosted Worker's auth/admin surface. Same var the hosted MCP transport reads. */
  authUrl: string;
  /** Base URL of the hosted Worker's vault surface. Same var the hosted MCP transport reads. */
  vaultUrl: string;
  /** The shared secret authorising this job's calls to the hosted Worker's service-only routes. */
  serviceSecret: string;
}

/** Read and validate the hosted-digest job's configuration from `process.env`. */
export function loadHostedDigestConfig(): HostedDigestConfig {
  return {
    authUrl: readUrl('HOSTED_AUTH_URL'),
    vaultUrl: readUrl('HOSTED_VAULT_URL'),
    serviceSecret: readSecret('HOSTED_SERVICE_SECRET'),
  };
}
