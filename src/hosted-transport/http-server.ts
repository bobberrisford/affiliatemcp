/**
 * Streamable HTTP MCP transport (H4): the plain `node:http` listener, session
 * routing, and per-request bearer auth. `mcp-server.ts` builds the actual MCP
 * `Server` instance this wires up; this file is the HTTP surface around it.
 *
 * ARCHITECTURE — why this is a Node service in the ROOT workspace, not code
 * added to the `hosted/` Cloudflare Worker: see the "H4: remote MCP
 * transport" section of `hosted/README.md` for the full write-up. In short —
 * `src/networks/**` (86 adapters, ~120k lines) and the tool/prompt generators
 * pull in `pino` (`src/shared/logging.ts`) and `node:fs`-based config,
 * caching, and telemetry (`src/shared/config.ts`, `cache.ts`, `telemetry.ts`,
 * `update-check.ts`, `cli/doctor.ts`, `cli/setup.ts`). None of that is
 * Workers-portable the way H2/H3's WebCrypto-only, `fetch`-only code
 * deliberately is, and the code volume alone is well past what a Workers
 * script bundle can carry. Reversing this choice (moving the transport back
 * into the Worker) would mean rewriting or replacing every one of those
 * Node-only primitives across the whole adapter surface — an open-ended
 * project, not a slice. Running it as a Node service costs exactly what H2's
 * README already named as the price of NOT using Workers: standing up
 * hosting and TLS/deploy tooling for this one process — everything else
 * (H1's request-context seam, the vault's HTTP surface, the adapters
 * themselves) is reused unmodified.
 *
 * SDK note: `StreamableHTTPServerTransport` (from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`) already accepts plain
 * Node `IncomingMessage`/`ServerResponse` objects — no Express dependency is
 * needed to use it; this file reads and JSON-parses the request body itself
 * (the SDK example uses Express's body-parser to do the same thing) and
 * otherwise follows the SDK's own reference streamable-HTTP server example
 * (`@modelcontextprotocol/sdk/examples/server/simpleStreamableHttp`): one
 * `Server`/transport pair per MCP session, keyed by the `mcp-session-id`
 * header, created on an `initialize` request and torn down on `onclose`.
 *
 * Auth layering: the hosted bearer-token check below runs BEFORE any MCP
 * protocol handling, on every request regardless of JSON-RPC method — it is
 * unrelated to the MCP session concept above (an `mcp-session-id` groups one
 * client connection's resumability state; the bearer token identifies the
 * hosted account making the call, and is re-verified on every single request,
 * including within an existing MCP session). Per-user rate limiting, the
 * vault-credential overlay, and the audit log are finer-grained than this —
 * they run inside `mcp-server.ts`'s `tools/call` handler, because that is the
 * first point the target network is known.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { createLogger } from '../shared/logging.js';
import type { HostedTransportConfig } from './env.js';
import { HostedAuthUnavailableError, verifySessionRemote } from './session-auth.js';
import { runWithHostedCallInfo } from './call-context.js';
import { buildHostedMcpServer } from './mcp-server.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const log = createLogger('hosted-transport');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface McpSessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

export interface HostedHttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts the hosted MCP transport's HTTP listener on `config.port` (`0` picks
 * an ephemeral port — what the test suite uses). Every `/mcp` request must
 * carry `Authorization: Bearer <amcps_… session token>`, verified against
 * `config.authUrl` on every single request (see the file header for why this
 * is remote, not a local key check). `GET /health` is unauthenticated
 * liveness, matching every other Worker in this repo.
 */
export async function startHostedHttpServer(config: HostedTransportConfig): Promise<HostedHttpServerHandle> {
  // Two independent buckets (H6): Solo and Pro traffic can never exhaust each
  // other's limit. Solo falls back to the shared/Pro values when no
  // Solo-specific override is configured (`env.ts`).
  const limiters = {
    pro: new TokenBucketRateLimiter({
      capacity: config.rateLimitCapacity,
      refillPerSecond: config.rateLimitRefillPerSecond,
    }),
    solo: new TokenBucketRateLimiter({
      capacity: config.rateLimitCapacitySolo ?? config.rateLimitCapacity,
      refillPerSecond: config.rateLimitRefillPerSecondSolo ?? config.rateLimitRefillPerSecond,
    }),
  };

  const sessions = new Map<string, McpSessionEntry>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: 'missing_session' });
      return;
    }

    let verified;
    try {
      verified = await verifySessionRemote(token, config.authUrl, {
        maxLifetimeSeconds: config.maxTokenLifetimeSeconds,
      });
    } catch (err) {
      if (err instanceof HostedAuthUnavailableError) {
        log.error({ message: err.message }, 'hosted auth verify unavailable');
        sendJson(res, 502, { error: 'auth_unavailable' });
        return;
      }
      throw err;
    }
    if (!verified) {
      sendJson(res, 401, { error: 'invalid_session' });
      return;
    }
    const { userId } = verified;

    await runWithHostedCallInfo({ userId, bearerToken: token }, async () => {
      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

      if (req.method === 'POST') {
        const raw = await readRequestBody(req);
        let parsedBody: unknown;
        try {
          parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null,
          });
          return;
        }

        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.transport.handleRequest(req, res, parsedBody);
          return;
        }
        if (!sessionId && isInitializeRequest(parsedBody)) {
          const server = buildHostedMcpServer({ config, limiters });
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) sessions.delete(id);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (!existing) {
          sendJson(res, 400, { error: 'invalid_or_missing_session' });
          return;
        }
        await existing.transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
    });
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/mcp') {
      handleMcp(req, res).catch((err) => {
        log.error({ message: (err as Error).message }, 'unhandled hosted-transport request error');
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log.info({ port }, 'hosted MCP transport listening');

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Streamable HTTP sessions can hold an open SSE (GET) connection
        // open indefinitely; `httpServer.close()` alone waits for every
        // in-flight connection to end first, which would hang shutdown on
        // any client that has not explicitly terminated its session.
        // Closing every socket outright is the correct behaviour for a
        // process shutdown (and for tests tearing down between cases).
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
