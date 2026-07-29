/**
 * Run the official MCP conformance suite against the hosted transport
 * (`npm run conformance:hosted`), per the accepted early-adoption decision
 * (`docs/decisions/2026-07-29-mcp-2026-07-28-early-adoption.md`) and the
 * readiness plan (`docs/product/mcp-2026-07-28-hosted-readiness.md`).
 *
 * What it boots, all in this one process plus one child:
 *
 * 1. A FAKE hosted Worker (`node:http`, ephemeral port): the same seam the
 *    transport unit tests use — `/auth/session/verify`, `/billing/entitlement`
 *    (`pro`, so no meter/cap round trips), `/billing/meter`, and the vault
 *    routes (empty vault). No network access, no credentials, no live tenant.
 * 2. The REAL hosted transport (`startHostedHttpServer`) with
 *    `HOSTED_STATELESS_2026=1` and `HOSTED_CONFORMANCE_FIXTURES=1`.
 * 3. A bearer-injecting proxy: the conformance CLI sends no Authorization
 *    header, and the transport (correctly) 401s without one. The proxy adds
 *    `Authorization: Bearer <fixed token>` and forwards, so the CLI exercises
 *    the transport's full request path INCLUDING per-request verification
 *    against the fake Worker.
 * 4. The conformance CLI (`@modelcontextprotocol/conformance`) as a child
 *    process. The default run is the full proof the early-adoption claim
 *    rests on: the ACTIVE server suite at `--spec-version 2026-07-28`, plus
 *    the named 2026-07-28 scenarios that still sit on the suite's draft
 *    track (the stateless core itself among them). Everything must pass;
 *    there is no expected-failures baseline because there are no expected
 *    failures.
 *
 * Flags:
 *   --scenario <name>   run exactly one scenario instead of the full proof
 *
 * Exit code: 0 only when every run passes.
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BEARER = 'conformance-fixed-token';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The fake hosted Worker: exactly the endpoints the transport's clients call. */
function startFakeWorker(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/auth/session/verify' && req.method === 'POST') {
      const now = Math.floor(Date.now() / 1000);
      sendJson(res, 200, { userId: 'conformance-user', exp: now + 3600, iss: now });
      return;
    }
    if (url.pathname === '/billing/entitlement' && req.method === 'GET') {
      sendJson(res, 200, { tier: 'pro', status: 'active' });
      return;
    }
    if (url.pathname === '/billing/meter' && req.method === 'POST') {
      sendJson(res, 200, { allowed: true, remaining: 100, resetAt: null });
      return;
    }
    if (url.pathname === '/vault/credentials' && req.method === 'GET') {
      sendJson(res, 200, { networks: [] });
      return;
    }
    if (/^\/vault\/credentials\/[^/]+\/reveal$/.test(url.pathname) && req.method === 'GET') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r, j) => {
            server.closeAllConnections();
            server.close((err) => (err ? j(err) : r()));
          }),
      });
    });
  });
}

/** Bearer-injecting forward proxy in front of the transport. */
function startAuthProxy(targetPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, authorization: `Bearer ${BEARER}`, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamRes: IncomingMessage) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: 'proxy_upstream_error' });
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r, j) => {
            server.closeAllConnections();
            server.close((err) => (err ? j(err) : r()));
          }),
      });
    });
  });
}

/** 2026-07-28 scenarios still on the suite's draft track (not part of the
 * active suite run), each of which the transport must pass individually.
 * `server-stateless` is the SEP-2575 stateless core — the heart of the claim. */
const DRAFT_2026_SCENARIOS = [
  'server-stateless',
  'caching',
  'http-header-validation',
  'http-custom-header-server-validation',
  'sep-2164-resource-not-found',
  'json-schema-2020-12',
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioIndex = args.indexOf('--scenario');
  const scenario = scenarioIndex !== -1 ? args[scenarioIndex + 1] : undefined;

  const worker = await startFakeWorker();

  const { startHostedHttpServer } = await import('../src/hosted-transport/http-server.js');
  // Constructed directly (the same way the transport unit tests do) so the
  // harness can use an ephemeral port; `loadHostedTransportConfig` requires a
  // fixed positive port. Generous rate-limit budget: the suite fires scenario
  // probes in quick bursts and a rate-limit refusal would read as a protocol
  // failure, which it is not.
  const transport = await startHostedHttpServer({
    authUrl: `http://127.0.0.1:${worker.port}`,
    vaultUrl: `http://127.0.0.1:${worker.port}`,
    port: 0,
    rateLimitCapacity: 10000,
    rateLimitRefillPerSecond: 1000,
    statelessEnabled: true,
    conformanceFixtures: true,
  });
  const proxy = await startAuthProxy(transport.port);

  const cli = path.join(repoRoot, 'node_modules', '@modelcontextprotocol', 'conformance', 'dist', 'index.js');
  const baseArgs = ['server', '--url', `http://127.0.0.1:${proxy.port}/mcp`, '--spec-version', '2026-07-28'];
  process.stderr.write(`conformance:hosted — transport :${transport.port}, proxy :${proxy.port}, worker :${worker.port}\n`);

  const runCli = (extra: string[]): Promise<number> =>
    new Promise((resolve) => {
      process.stderr.write(`conformance:hosted — node ${cli} ${[...baseArgs, ...extra].join(' ')}\n`);
      const child = spawn(process.execPath, [cli, ...baseArgs, ...extra], { stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? 1));
    });

  let exitCode = 0;
  if (scenario) {
    exitCode = await runCli(['--scenario', scenario]);
  } else {
    exitCode = await runCli([]);
    for (const draftScenario of DRAFT_2026_SCENARIOS) {
      const code = await runCli(['--scenario', draftScenario]);
      if (code !== 0) exitCode = code;
    }
  }

  await proxy.close();
  await transport.close();
  await worker.close();
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`conformance:hosted failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
