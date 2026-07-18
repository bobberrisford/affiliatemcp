/**
 * Tier 3 (automated subset) — live AUTHENTICATED smoke, option A.
 *
 * Given a short-lived access token for the dedicated seeded test tenant
 * (`docs/decisions/2026-07-18-hosted-seeded-test-tenant.md`), this walks the
 * live authenticated path an ordinary MCP client takes once signed in:
 * connect to the real connector with the bearer, list tools, and make an
 * entitled tool call. It proves the whole live chain — session verify →
 * entitlement (`active`) → transport dispatch — that no other tier covers.
 *
 * The token is minted and rotated by the `hosted-live-auth` workflow, which
 * exchanges the seeded refresh token and passes only the resulting access token
 * in as `HOSTED_TEST_ACCESS_TOKEN`. This test never sees or handles the refresh
 * token. It is opt-in: without `HOSTED_TEST_ACCESS_TOKEN` it skips, so ordinary
 * `npm test` / CI stay green and deterministic.
 *
 * Optional: set `HOSTED_TEST_NETWORK` (e.g. `cj`) to a network the tenant has
 * connected in its vault to additionally prove the vault-reveal → adapter leg.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ACCESS_TOKEN = process.env['HOSTED_TEST_ACCESS_TOKEN'];
const CONNECTOR = process.env['HOSTED_CONNECTOR_URL'] ?? 'https://mcp.agenticaffiliate.ai/mcp';
const VAULT_NETWORK = process.env['HOSTED_TEST_NETWORK'];
const TIMEOUT = 30_000;

const suite = ACCESS_TOKEN ? describe : describe.skip;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'hosted-live-auth-smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(CONNECTOR), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

suite('hosted live authenticated smoke', () => {
  it(
    'an entitled session connects, lists tools, and runs an entitled meta call',
    async () => {
      const token = ACCESS_TOKEN as string;
      const client = await connect(token);
      try {
        const { tools } = await client.listTools();
        expect(tools.length, 'the connector should advertise tools to an entitled session').toBeGreaterThan(0);

        // A meta read needs no per-network credential, so it isolates the
        // session + entitlement + transport legs from any vault/adapter issue.
        const result = await client.callTool({ name: 'affiliate_list_networks', arguments: {} });
        expect(
          result.isError,
          'affiliate_list_networks should succeed for an entitled session (not an entitlement refusal)',
        ).toBeFalsy();
      } finally {
        await client.close();
      }
    },
    TIMEOUT,
  );

  (VAULT_NETWORK ? it : it.skip)(
    'a vault-backed read for a connected network succeeds (vault reveal → adapter)',
    async () => {
      const token = ACCESS_TOKEN as string;
      const network = VAULT_NETWORK as string;
      const client = await connect(token);
      try {
        const to = new Date().toISOString().slice(0, 10);
        const result = await client.callTool({
          name: `affiliate_${network}_get_earnings_summary`,
          arguments: { from: '2024-01-01', to },
        });
        expect(
          result.isError,
          `an entitled, connected read on ${network} should succeed, not refuse or invent`,
        ).toBeFalsy();
      } finally {
        await client.close();
      }
    },
    TIMEOUT,
  );
});
