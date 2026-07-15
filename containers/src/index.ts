/**
 * Cloudflare Containers router Worker for affiliate-mcp's two hosted Node
 * services: the H4 remote MCP transport (`src/hosted-transport/`, root
 * workspace) and the H6 digest-compose service (`src/hosted-digest/`, root
 * workspace). See `hosted/README.md`, "H4: remote MCP transport lives in the
 * root workspace, not here", for why those two are Node services rather than
 * code inside the `hosted/` Worker, and this file's own directory's
 * `wrangler.toml` for why this is a SEPARATE Worker from `hosted/` rather
 * than config added there (in short: `hosted/`'s Worker already owns the
 * top-level `/health` path, and this PR was asked not to restructure
 * `hosted/`'s existing code).
 *
 * Both container classes below share ONE Docker image (the repo-root
 * `Dockerfile`), started with a different `CONTAINER_SERVICE` value per
 * class — see the Dockerfile's own header for why one image was chosen over
 * two, and why each role still gets its own container CLASS (independent
 * instance counts and restart behaviour) rather than one instance
 * supervising both Node processes.
 *
 * ROUTES:
 *   GET|POST|DELETE /mcp          -> McpTransportContainer, port 8787
 *   GET             /health       -> McpTransportContainer, port 8787
 *                                    (liveness for the transport, the
 *                                    consumer-facing role; the digest
 *                                    service's own liveness is at
 *                                    /digest/health, kept separate rather
 *                                    than overloading one path with two
 *                                    different containers' meaning)
 *   GET             /digest/health -> DigestComposeContainer /health
 *   POST            /digest/compose -> DigestComposeContainer /compose
 *
 * MCP SESSION AFFINITY — the one open question this PR flags rather than
 * guesses at. `src/hosted-transport/http-server.ts` keeps its MCP session
 * state (the `sessions` map, keyed by the `mcp-session-id` header) in the
 * one Node process handling it — nothing shared, nothing external. Web
 * search against Cloudflare's own container-routing documentation
 * (corroborated across "Lifecycle of a Container" and the container-class
 * FAQ; this sandboxed environment could not load developers.cloudflare.com
 * directly to read it first-hand) states plainly: "your Durable Object ID
 * strategy is your Container scaling strategy" — i.e. session-sticky
 * routing across MULTIPLE container replicas requires deriving the Durable
 * Object name from a stable per-session identifier on every request. That
 * is exactly what this router cannot do for the transport's first request:
 * the `mcp-session-id` does not exist until AFTER the `initialize`
 * round-trip that creates it (`isInitializeRequest` in
 * `src/hosted-transport/http-server.ts`), so there is no key to route the
 * very first request by, and every later request for that session would
 * need to land back on the SAME container instance that handled
 * `initialize` — not just the same Durable Object id computed the same way.
 * Rather than invent an unverified affinity scheme, this router routes
 * EVERY `/mcp` and `/health` request to one fixed Durable Object name
 * (`TRANSPORT_SINGLETON_NAME`), and `wrangler.toml` pins
 * `McpTransportContainer` to `max_instances = 1` to match — every request
 * for every session goes to the one running container instance, preserving
 * the transport's existing in-memory session-affinity assumption exactly as
 * it behaves on a single Fly.io/Railway instance today. This is not a
 * capability regression (a single Node process was already the deployment
 * shape being replaced), but it does mean this router does not yet give the
 * transport horizontal scale. Raising `max_instances` above 1 for this class
 * needs either a session-affinity design (routing keyed by
 * `mcp-session-id` once known, with a documented answer for the
 * pre-session-id `initialize` request) or moving the transport's session
 * state out of process (KV/DO-backed), whichever Rob prefers — VERIFY AND
 * DESIGN THIS BEFORE relying on more than one transport instance.
 *
 * STREAMING (SSE over streamable HTTP) — a related but SEPARATE question:
 * whether a response body streamed by the container (the transport's own
 * long-lived `GET /mcp` SSE connections, `StreamableHTTPServerTransport`)
 * passes through `container.getTcpPort(port).fetch(request)` without being
 * buffered. The container binding is documented as a plain HTTP/TCP proxy
 * (`Fetcher.fetch` over `getTcpPort`), which is consistent with streaming
 * passing through unbuffered, but this could not be confirmed against a
 * worked streaming example in the docs from this sandboxed environment (the
 * same 403-to-automated-fetch limitation noted in `wrangler.toml`). VERIFY
 * THIS FIRST at deploy, with a real `GET /mcp` SSE round-trip against a
 * staging deploy, before depending on it in production. Fallback if it does
 * not hold: route the transport's public traffic directly at a plain
 * container host (Fly.io, Railway — any host running this same Docker
 * image) instead of through this Worker's container binding, which is
 * exactly the deployment shape this PR's Dockerfile already supports
 * unchanged.
 *
 * The digest-compose service has neither of these two problems: it is one
 * stateless POST/response per compose call, so both routing key and
 * response shape (a soon plain JSON body) are unaffected either way.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  MCP_TRANSPORT_CONTAINER: DurableObjectNamespace<McpTransportContainer>;
  DIGEST_COMPOSE_CONTAINER: DurableObjectNamespace<DigestComposeContainer>;
  /** The deployed hosted Worker's own origin — see wrangler.toml's `[vars]` comment. */
  HOSTED_WORKER_ORIGIN: string;
  /** Optional doorbell shared with hosted/'s own `DIGEST_COMPOSE_SECRET` secret. */
  DIGEST_COMPOSE_SECRET?: string;
}

const TRANSPORT_PORT = 8787; // src/hosted-transport/env.ts DEFAULT_PORT
const DIGEST_PORT = 8788; // src/hosted-digest/env.ts DEFAULT_PORT

// Fixed Durable Object names — see the file-header note on MCP session
// affinity for why the transport uses exactly one name (matching
// `max_instances = 1`). The digest-compose name is fixed for the same
// simplicity even though it does not need to be: it has no session
// affinity requirement, so Cloudflare's own instance placement can still
// spin up a second instance under `max_instances = 2` if concurrent load
// during one scheduled run needs it — see "Lifecycle of a Container" in the
// Containers docs for that placement behaviour, restated in wrangler.toml.
const TRANSPORT_SINGLETON_NAME = 'mcp-transport-singleton';
const DIGEST_SINGLETON_NAME = 'digest-compose-singleton';

/**
 * The container port only accepts plain-HTTP request URLs — the runtime
 * rejects `https:` URLs with "Connecting to a container using HTTPS is not
 * currently supported" (observed at first deploy, 2026-07-15). The hop is
 * Worker-to-container inside Cloudflare's network, so TLS on this leg adds
 * nothing; rewrite the scheme before proxying.
 */
function toContainerRequest(request: Request): Request {
  const url = new URL(request.url);
  url.protocol = 'http:';
  return new Request(url, request);
}

/**
 * `container.start()` returns before the Node process inside is listening,
 * and `getTcpPort().fetch()` throws "The container is not listening in the
 * TCP address …" until it is (observed at first deploy, 2026-07-15: every
 * cold-start request failed, which broke the digest cron's single,
 * deliberately-unretried compose call). Retry only that startup error, with
 * a bounded deadline; every other error propagates immediately. The request
 * is cloned per attempt because a consumed body cannot be resent.
 */
async function fetchWhenListening(
  container: NonNullable<DurableObjectState['container']>,
  port: number,
  request: Request,
): Promise<Response> {
  const base = toContainerRequest(request);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      // Cast: Request's Cf generics don't unify with Fetcher's RequestInfo.
      return await container.getTcpPort(port).fetch(base.clone() as unknown as RequestInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not listening/i.test(message) || Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Starts the container's process if it is not already running, passing the
 * env vars that service's own `env.ts` reads from `process.env`
 * (`src/hosted-transport/env.ts` or `src/hosted-digest/env.ts`).
 * `enableInternet: true` is required by `ContainerStartupOptions` (not
 * optional in `@cloudflare/workers-types`) and both services genuinely need
 * outbound internet: the transport calls the hosted Worker and every
 * affiliate network API; the compose service calls the hosted Worker and,
 * through the adapters it composes from, affiliate network APIs too.
 */
function ensureRunning(container: Container, env: Record<string, string>): void {
  if (!container.running) {
    container.start({ enableInternet: true, env });
  }
}

/** Proxies the H4 remote MCP transport (`src/hosted-transport/`) — see the file header. */
export class McpTransportContainer extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) {
      return new Response('container runtime unavailable', { status: 503 });
    }
    ensureRunning(container, {
      CONTAINER_SERVICE: 'hosted-transport',
      HOSTED_AUTH_URL: this.env.HOSTED_WORKER_ORIGIN,
      HOSTED_VAULT_URL: this.env.HOSTED_WORKER_ORIGIN,
      HOSTED_TRANSPORT_PORT: String(TRANSPORT_PORT),
    });
    return fetchWhenListening(container, TRANSPORT_PORT, request);
  }
}

/** Proxies the H6 digest-compose service (`src/hosted-digest/`) — see the file header. */
export class DigestComposeContainer extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) {
      return new Response('container runtime unavailable', { status: 503 });
    }
    ensureRunning(container, {
      CONTAINER_SERVICE: 'hosted-digest',
      HOSTED_VAULT_URL: this.env.HOSTED_WORKER_ORIGIN,
      DIGEST_SERVICE_PORT: String(DIGEST_PORT),
      ...(this.env.DIGEST_COMPOSE_SECRET ? { DIGEST_COMPOSE_SECRET: this.env.DIGEST_COMPOSE_SECRET } : {}),
    });
    return fetchWhenListening(container, DIGEST_PORT, request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp' || url.pathname === '/health') {
      const stub = env.MCP_TRANSPORT_CONTAINER.getByName(TRANSPORT_SINGLETON_NAME);
      return stub.fetch(request);
    }

    if (url.pathname === '/digest/health') {
      const stub = env.DIGEST_COMPOSE_CONTAINER.getByName(DIGEST_SINGLETON_NAME);
      return stub.fetch(new Request(new URL('/health', request.url), request));
    }

    if (url.pathname === '/digest/compose' && request.method === 'POST') {
      const stub = env.DIGEST_COMPOSE_CONTAINER.getByName(DIGEST_SINGLETON_NAME);
      return stub.fetch(new Request(new URL('/compose', request.url), request));
    }

    return new Response('not found', { status: 404 });
  },
};
