/**
 * Tier 1 — live unauthenticated contract smoke for the hosted service.
 *
 * Hits the REAL deployed endpoints. No auth, no POST of credentials, no account
 * creation — only the discovery/challenge surface any MCP client sees before it
 * authenticates. It catches a broken deploy, DNS, cert, or OAuth-discovery
 * regression that in-process tests cannot.
 *
 * Opt-in: set `HOSTED_LIVE_SMOKE=1` to run. Ordinary `npm test` / CI skip it so
 * the offline suite stays deterministic and green.
 *
 *   HOSTED_LIVE_SMOKE=1 npm test -- tests/hosted-personas/live-smoke.test.ts
 *
 * These assert the contract the accepted OAuth decision
 * (docs/decisions/2026-07-15-hosted-connector-oauth.md) and RFC 9728 require.
 */

import { describe, expect, it } from 'vitest';

const LIVE = process.env['HOSTED_LIVE_SMOKE'] === '1';
const suite = LIVE ? describe : describe.skip;

const CONNECTOR = 'https://mcp.agenticaffiliate.ai';
const SITE = 'https://agenticaffiliate.ai';
const TIMEOUT = 20_000;

async function getJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

suite('hosted live contract smoke', () => {
  it(
    'connector /mcp challenges unauthenticated requests with RFC 9728 metadata',
    async () => {
      const res = await fetch(`${CONNECTOR}/mcp`, { method: 'GET' });
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('Bearer');
      expect(challenge).toContain('resource_metadata=');
      expect(challenge).toContain('/.well-known/oauth-protected-resource');
    },
    TIMEOUT,
  );

  it(
    'protected-resource metadata points at the hosted authorization server',
    async () => {
      const { status, json } = await getJson(`${CONNECTOR}/.well-known/oauth-protected-resource`);
      expect(status).toBe(200);
      expect(json['resource']).toBe(CONNECTOR);
      expect(json['authorization_servers']).toContain('https://hosted.agenticaffiliate.ai');
      expect(json['scopes_supported']).toContain('mcp');
    },
    TIMEOUT,
  );

  it(
    'authorization-server metadata advertises OAuth 2.1 + PKCE S256',
    async () => {
      // Discover the AS from the protected-resource doc so the chain is proven,
      // not assumed.
      const { json: resource } = await getJson(`${CONNECTOR}/.well-known/oauth-protected-resource`);
      const [authServer] = resource['authorization_servers'] as string[];
      expect(authServer, 'protected-resource metadata must name an authorization server').toBeTruthy();
      const { status, json } = await getJson(`${authServer}/.well-known/oauth-authorization-server`);
      expect(status).toBe(200);
      expect(json['issuer']).toBe(authServer);
      expect(typeof json['authorization_endpoint']).toBe('string');
      expect(typeof json['token_endpoint']).toBe('string');
      expect(json['code_challenge_methods_supported']).toContain('S256');
      expect(json['grant_types_supported']).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
    },
    TIMEOUT,
  );

  it(
    'the pricing and hosted marketing pages are served',
    async () => {
      for (const page of ['/hosted.html', '/pricing.html']) {
        const res = await fetch(`${SITE}${page}`);
        expect(res.status, `${page} should be 200`).toBe(200);
      }
    },
    TIMEOUT,
  );
});
