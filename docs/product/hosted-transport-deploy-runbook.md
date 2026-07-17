# Hosted MCP transport: go-live deploy runbook

> **Now CI-deployed.** The containers Worker (MCP transport + digest) deploys
> from `.github/workflows/deploy-containers.yml` on merge to `main` and after a
> release — see `docs/decisions/2026-07-17-telemetry-and-containers-ci-deploy.md`
> and DEPLOY.md §8. This runbook remains the reference for the **one-time**
> account setup (API-token scopes, custom domain, Actions variables) and as the
> break-glass manual path (`gh workflow run deploy-containers.yml -f
> confirm=deploy`, or a local `wrangler deploy`).

The ordered, copy-pasteable checklist to take the hosted MCP **transport**
(the always-on Node service MCP clients connect to) from nothing to a live,
reachable URL. This is the missing piece Tier B of
`docs/product/hosted-oauth-ship-runbook.md` depends on: the OAuth
authorization server (the hosted Worker) is deployed and complete, but the
transport it protects has never been deployed to a live origin, so no MCP
client can complete OAuth yet.

Deploys to any live environment are Rob-only: they need his Cloudflare
account, its API token, and the custom domain. This runbook is the checklist,
not an authorisation to deploy. Nothing here merges or deploys on its own.

## The transport holds no secrets

State this plainly because it changes what "deploy" means here. The transport
carries **no signing key and no master key**. It verifies every request's
session by calling the hosted Worker over HTTP (`HOSTED_AUTH_URL`), and it
reads vault credentials using the caller's own bearer token (`HOSTED_VAULT_URL`),
so the credentials it touches are only ever the ones the caller is already
entitled to. Its entire configuration is **URLs plus tuning numbers** — no
`wrangler secret put` step exists for the transport itself. The only optional
secret in the container workspace, `DIGEST_COMPOSE_SECRET`, belongs to the
separate digest-compose service, not the transport. Compromising the transport
process leaks no key, because there is none to leak.

## Two deploy shapes, pick one

The repo-root `Dockerfile` builds one image that runs either Node service; the
role is chosen at start by `CONTAINER_SERVICE` (`hosted-transport` by
default). That image runs unchanged on:

- **Cloudflare Containers** (`containers/` Worker workspace) — keeps the whole
  hosted stack in one Cloudflare account. This is the documented primary path
  below.
- **Any plain container host** (Fly.io, Railway, a VPS with Docker) — set the
  same environment variables as plain env vars and route a custom domain at
  the container's port `8787`. This is the fallback if the Cloudflare
  Containers streaming or session-affinity questions (below) do not resolve
  favourably. See `hosted/README.md`, "Fallback: any container host runs the
  same image".

Both shapes need the same env values and the same custom-domain decision, so
the variable and smoke sections below apply to either.

## Prerequisites

- The hosted Worker is already deployed and live (Tier A of
  `docs/product/hosted-oauth-ship-runbook.md`): `GET /health` and
  `GET /.well-known/oauth-authorization-server` return correctly against its
  public origin.
- `main` is green and checked out in the deploy environment.
- A working Docker CLI **and daemon** on the deploy machine (the Cloudflare
  Containers deploy builds and pushes the image as part of `wrangler deploy`).
- A Cloudflare API token with **both** `Account -> Containers -> Edit` and
  `Account -> Cloudchamber -> Edit` (the image push authorises against the
  Cloudchamber scope; Containers alone is not enough).
- A **custom domain** you can attach to the container Worker. A Worker cannot
  fetch another Worker's `workers.dev` origin in the same account, so the
  transport's public origin must be a custom domain, not a `workers.dev` URL.
  `mcp.agenticaffiliate.ai` is the domain earmarked for this.

## The three URLs that must agree

Get this right once and the rest follows. There are two distinct origins:

- **the hosted Worker origin** — where auth and vault live.
- **the transport public origin** — the custom domain on the container Worker,
  where MCP clients connect. The connector URL users add is this origin +
  `/mcp`.

| Variable | Where it is set | Value |
| --- | --- | --- |
| `HOSTED_AUTH_URL` | transport (container env) | the **hosted Worker origin** |
| `HOSTED_VAULT_URL` | transport (container env) | the **hosted Worker origin** (same Worker serves both today) |
| `HOSTED_TRANSPORT_PUBLIC_URL` | transport (container env) | the **transport public origin** |
| `PUBLIC_BASE_URL` | hosted Worker (`hosted/wrangler.toml`) | the **hosted Worker origin** |
| `HOSTED_CONNECTOR_URL` | hosted Worker (`hosted/wrangler.toml`) | the **transport public origin** + `/mcp` |

On the Cloudflare Containers path you do not set the three transport env vars
by hand: `containers/wrangler.toml` has `HOSTED_WORKER_ORIGIN` (the hosted
Worker origin, forwarded as both `HOSTED_AUTH_URL` and `HOSTED_VAULT_URL`) and
`TRANSPORT_PUBLIC_URL` (the transport public origin, forwarded as
`HOSTED_TRANSPORT_PUBLIC_URL`), and `containers/src/index.ts` assembles the
container env from them.

Concretely, with the earmarked domain:

- hosted Worker origin: `https://affiliate-mcp-hosted.<...>` (its live origin)
- transport public origin: `https://mcp.agenticaffiliate.ai`
- connector URL users add: `https://mcp.agenticaffiliate.ai/mcp`
- `HOSTED_CONNECTOR_URL`: `https://mcp.agenticaffiliate.ai/mcp`

## Ordered deploy steps (Cloudflare Containers path)

1. Confirm the hosted Worker is live (prerequisites above).
2. From the repo root, optionally build the image locally first as a smoke:
   `docker build -t affiliate-mcp-hosted-services .` — the base-image pull may
   be blocked by egress policy in some environments; if so, the equivalent
   `npm ci && npm run build` then `node dist/index.js hosted-transport` proves
   the build script and entrypoint (see "Local validation already done").
3. `cd containers && npm install`.
4. In `containers/wrangler.toml`, set `HOSTED_WORKER_ORIGIN` to the hosted
   Worker origin (same as the Worker's own `PUBLIC_BASE_URL`).
5. In `containers/wrangler.toml`, set `TRANSPORT_PUBLIC_URL` to the transport
   public origin (the custom domain, e.g. `https://mcp.agenticaffiliate.ai`).
   **Leaving the `REPLACE_WITH` placeholder keeps OAuth discovery off** and no
   MCP client can complete OAuth — this variable is what turns the go-live on.
   Do **not** set `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` anywhere yet: unset is
   the dual-accept window that keeps both OAuth access tokens and any legacy
   pasted bearers working. It is the Tier C cutover lever, set later and
   deliberately.
6. If the hosted Worker's `DIGEST_COMPOSE_SECRET` is set, mirror it into the
   container workspace: `npx wrangler secret put DIGEST_COMPOSE_SECRET` in
   `containers/`. This is for the digest-compose service only; the transport
   needs no secret.
7. If a stale wrangler OAuth session lacks container scopes, move it aside for
   the deploy so wrangler authenticates with the API token alone (macOS:
   `~/Library/Preferences/.wrangler/config/default.toml`).
8. `cd containers && npm run deploy` (`wrangler deploy`). This builds the image
   from the repo-root `Dockerfile` and pushes it to Cloudflare's container
   registry as part of the deploy.
9. Attach the custom domain (`mcp.agenticaffiliate.ai`) to the deployed
   container Worker (Cloudflare dashboard: Workers -> the container Worker ->
   Settings -> Domains & Routes -> add custom domain), so its public origin is
   the custom domain, not `workers.dev`.
10. On the hosted Worker, set `HOSTED_CONNECTOR_URL` in `hosted/wrangler.toml`
    to the transport public origin + `/mcp` (so the connect success page shows
    the real connector URL), and — if using the container digest path — set
    `DIGEST_SERVICE_URL` to `https://<transport-public-origin>/digest`. Redeploy
    the hosted Worker (`cd hosted && npm run deploy`).

## Post-deploy smoke (against the live transport public origin)

Run these against the custom domain once it resolves:

1. `curl -s -w '\n%{http_code}\n' https://mcp.agenticaffiliate.ai/health`
   -> `{"ok":true}` and `200`.
2. `curl -s https://mcp.agenticaffiliate.ai/.well-known/oauth-protected-resource`
   -> JSON whose `resource` is the transport public origin and whose
   `authorization_servers` is `[the hosted Worker origin]`. A `404` here means
   `HOSTED_TRANSPORT_PUBLIC_URL` did not reach the container (placeholder left
   in `TRANSPORT_PUBLIC_URL`, or the instance was not restarted after changing
   it — env is applied only at container start).
3. `curl -s -D - -o /dev/null https://mcp.agenticaffiliate.ai/mcp` -> `401`
   carrying `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
4. **Verify SSE streaming through the container binding** with a real
   `GET /mcp` round-trip before relying on it — Cloudflare's container binding
   is a documented HTTP/TCP proxy, but unbuffered streaming was not confirmed
   against a worked example. If it buffers, fall back to a plain container host
   (Fly.io/Railway) running the same image. See `containers/src/index.ts`'s
   header and `hosted/README.md`, "Streaming (SSE) through the container
   binding".
5. **Real MCP-client connect** (the acceptance proof): add affiliate-mcp as a
   custom connector in Claude using `https://mcp.agenticaffiliate.ai/mcp`,
   complete the browser OAuth + consent, and confirm a tool call runs under the
   caller's own identity. Confirm an existing `amcps_` pasted bearer still
   authenticates the transport (dual-accept holds while
   `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` is unset).

## Rollback

- **Transport (Cloudflare Containers):** `wrangler rollback` in `containers/`,
  or redeploy the previous build. OAuth discovery is additive and gated on
  `TRANSPORT_PUBLIC_URL`; clearing that var back to the placeholder and
  restarting the instance returns the transport to bare-401 behaviour without
  a redeploy.
- **Dual-accept:** if the Tier C lifetime cap has been set and something
  breaks, unset `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` to return to dual-accept
  instantly (accepts both OAuth access tokens and legacy bearers again).
- **Fallback host:** if Cloudflare Containers streaming or session affinity
  proves unworkable, deploy the same image to a plain container host and point
  the custom domain there; no code change is required.

## Decision points left for Rob (not guessed here)

- **Session affinity / horizontal scale.** `containers/wrangler.toml` pins
  `McpTransportContainer` to `max_instances = 1` and the router sends every
  `/mcp` request to one fixed Durable Object name, because the transport keeps
  per-session state in-process and the `mcp-session-id` does not exist until
  after `initialize`. This preserves today's single-process behaviour but gives
  no horizontal scale. Raising it needs a session-affinity design or moving
  session state out of process. See `containers/src/index.ts`'s header.
- **Cloudflare Containers vs a plain host.** The streaming and affinity
  questions above are the reason the fallback exists. Which shape to run in
  production is Rob's call.
- **Which custom domain.** `mcp.agenticaffiliate.ai` is earmarked and
  referenced throughout; confirm before attaching.

## Local validation already done (2026-07-16)

- `npm run build` (root) compiles the transport.
- Node boot smoke with `CONTAINER_SERVICE`-equivalent env
  (`HOSTED_AUTH_URL`/`HOSTED_VAULT_URL` dummies,
  `HOSTED_TRANSPORT_PUBLIC_URL=http://localhost:8799`): `GET /health` -> `200 {"ok":true}`;
  `GET /.well-known/oauth-protected-resource` -> `200` with correct metadata;
  `GET /mcp` (no auth) -> `401` with the `WWW-Authenticate` challenge.
- `containers/` typecheck and `wrangler deploy --dry-run` pass and register the
  `TRANSPORT_PUBLIC_URL` var and both container classes against the repo-root
  `Dockerfile`.
- Not validated locally (no Docker daemon in this environment): a full
  `docker build`, and SSE streaming through the live container binding — both
  are in the smoke above for the deploy machine.

## See also

- `docs/product/hosted-oauth-ship-runbook.md` — Tier B step 5 points here.
- `hosted/README.md`, "Deploy on Cloudflare (all-in-one)" — the container
  workspace design and the per-service env-var table.
