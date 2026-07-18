/**
 * Capture a refresh token + client_id for the hosted seeded test tenant.
 *
 * Maintainer tool for step 3 of the provisioning runbook in
 * docs/decisions/2026-07-18-hosted-seeded-test-tenant.md. It runs the OAuth 2.1
 * authorization-code + PKCE flow (with dynamic client registration) against the
 * live hosted authorization server, opens the browser for you to sign in and
 * approve, catches the redirect on a loopback port, exchanges the code, and
 * prints the `client_id` and `refresh_token` plus the exact `gh secret set`
 * commands.
 *
 * You run this against the tenant you have already signed into and subscribed
 * (steps 1 to 2). Nothing is stored: the tokens print to your terminal only.
 *
 *   npm run hosted:capture-token
 *   HOSTED_AUTH_URL=https://hosted.agenticaffiliate.ai npm run hosted:capture-token
 *
 * Prerequisite: the tenant exists and has an active subscription. This only
 * mints credentials; it does not create the account or enter any keys.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const AUTH_URL = (process.env['HOSTED_AUTH_URL'] ?? 'https://hosted.agenticaffiliate.ai').replace(/\/$/, '');
const PORT = Number(process.env['HOSTED_CAPTURE_PORT'] ?? 8976);
const SCOPE = 'mcp';
const TIMEOUT_MS = 300_000;

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

async function discover(): Promise<AsMetadata> {
  const res = await fetch(`${AUTH_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`authorization-server metadata ${res.status} at ${AUTH_URL}`);
  const json = (await res.json()) as Partial<AsMetadata>;
  if (!json.authorization_endpoint || !json.token_endpoint || !json.registration_endpoint) {
    throw new Error('authorization-server metadata is missing endpoints');
  }
  return json as AsMetadata;
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'affiliate-mcp hosted test-tenant token capture',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const json = (await res.json()) as { client_id?: string; error?: string };
  if (!res.ok || !json.client_id) {
    throw new Error(`dynamic client registration failed (${res.status}): ${json.error ?? 'no client_id'}`);
  }
  return json.client_id;
}

/** Open a URL in the default browser, best effort. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* printing the URL is the fallback */
  }
}

/** Serve the redirect endpoint, resolve with the authorization code. */
function waitForCode(redirectPath: string, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      if (url.pathname !== redirectPath) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      if (oauthError) {
        res.end(`<p>Authorization failed: ${oauthError}. You can close this tab.</p>`);
        server.close();
        reject(new Error(`authorization returned error=${oauthError}`));
        return;
      }
      if (!code || state !== expectedState) {
        res.end('<p>Unexpected callback (state mismatch). You can close this tab.</p>');
        server.close();
        reject(new Error('missing code or state mismatch on callback'));
        return;
      }
      res.end('<p>Captured. You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      if (actual !== PORT) {
        server.close();
        reject(new Error(`could not bind loopback port ${PORT}`));
      }
    });
    setTimeout(() => {
      server.close();
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s waiting for the browser redirect`));
    }, TIMEOUT_MS).unref();
  });
}

async function exchange(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  clientId: string,
  codeVerifier: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${json.error ?? 'no access_token'}`);
  }
  return { access_token: json.access_token, ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}) };
}

async function main(): Promise<void> {
  const redirectPath = '/callback';
  const redirectUri = `http://127.0.0.1:${PORT}${redirectPath}`;

  out(`Hosted token capture against ${AUTH_URL}`);
  out('Make sure you are already signed into the test tenant and it has an active subscription.\n');

  const meta = await discover();
  const clientId = await registerClient(meta.registration_endpoint, redirectUri);

  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(16));

  const authorizeUrl =
    `${meta.authorization_endpoint}?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  out('Open this URL, sign in, and approve (attempting to open it now):');
  out(`  ${authorizeUrl}\n`);
  openBrowser(authorizeUrl);

  const code = await waitForCode(redirectPath, state);
  const tokens = await exchange(meta.token_endpoint, code, redirectUri, clientId, codeVerifier);

  out('\n=== captured (keep these secret) ===');
  out(`client_id:     ${clientId}`);
  out(`refresh_token: ${tokens.refresh_token ?? '(none returned — the tenant may not have offline access)'}`);
  out('\nSet the CI secrets (run these yourself; mind your shell history):');
  out(`  gh secret set HOSTED_TEST_CLIENT_ID --body '${clientId}'`);
  if (tokens.refresh_token) {
    out(`  printf '%s' '<paste refresh_token>' | gh secret set HOSTED_TEST_REFRESH_TOKEN`);
  }
  out('\nThen create a fine-grained PAT (this repo, Secrets: read and write) and:');
  out('  gh secret set HOSTED_TEST_SECRETS_PAT   # paste the PAT');
}

main().catch((e) => {
  err(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
