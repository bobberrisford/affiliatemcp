/**
 * Public entrypoint for the digest-compose service (H6, redesigned per
 * Rob's 2026-07-14 decision — see `hosted/README.md`, "Digest orchestration
 * and token scopes"). Re-exports the pieces a caller needs:
 * `startHostedDigestServer` for both the CLI subcommand (`src/index.ts`,
 * `hosted-digest`) and the test suite (`tests/hosted-digest/`), and
 * `loadHostedDigestConfig` to read `process.env` the same way the CLI does.
 *
 * The service is long-running (`affiliate-networks-mcp hosted-digest`
 * starts it and blocks, like `hosted-transport`); the SCHEDULE lives in the
 * hosted Worker as a Cloudflare Cron Trigger (`hosted/wrangler.toml`,
 * `[triggers]`), which calls this service's `POST /compose` once per
 * subscriber per digest type and sends the email itself. There is no
 * roster, no scheduler, and no email address anywhere in this process.
 *
 * Deployment shape: run this service wherever the hosted MCP transport
 * runs (it has the same needs — the adapter registry and outbound network
 * access) and point the Worker's `DIGEST_SERVICE_URL` var at it. A systemd
 * unit is the recommended supervisor:
 *
 *   # affiliate-mcp-digest-compose.service
 *   [Service]
 *   EnvironmentFile=/etc/affiliate-mcp/digest-compose.env   # HOSTED_VAULT_URL, DIGEST_SERVICE_PORT, DIGEST_COMPOSE_SECRET
 *   ExecStart=/usr/bin/node /opt/affiliate-mcp/dist/index.js hosted-digest
 *   Restart=on-failure
 *   [Install]
 *   WantedBy=multi-user.target
 *
 * For a local or manual run (compose one digest by hand):
 *
 *   HOSTED_VAULT_URL=... npm run dev:hosted-digest
 *   curl -X POST localhost:8788/compose \
 *     -H "authorization: Bearer <a valid session token>" \
 *     -H "content-type: application/json" \
 *     -d '{"userId":"hosted_usr_...","digestType":"earnings"}'
 */

export { startHostedDigestServer, type HostedDigestServerHandle } from './server.js';
export { loadHostedDigestConfig, type HostedDigestConfig } from './env.js';
export { composeDigestForUser } from './run.js';
export {
  composeEarningsDigest,
  composeUnpaidCommissionsDigest,
  type ComposedDigest,
  type DigestType,
  type NetworkEarningsResult,
} from './compose.js';
