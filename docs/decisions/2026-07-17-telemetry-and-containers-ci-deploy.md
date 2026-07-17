# Telemetry + containers Workers: CI deploy (finish the pipeline)

- **Date:** 2026-07-17
- **Status:** Proposed (awaiting Rob)
- **Affects:** `.github/workflows/deploy-telemetry.yml` (new),
  `.github/workflows/deploy-containers.yml` (new), `containers/wrangler.toml`
  (injectable placeholders), `DEPLOY.md` and
  `docs/product/hosted-transport-deploy-runbook.md` (the manual steps become a
  one-time setup)
- **Relates to:** [`2026-07-16-hosted-worker-ci-deploy.md`](./2026-07-16-hosted-worker-ci-deploy.md)
  (the hosted Worker precedent this extends),
  [`2026-07-15-hosted-connector-oauth.md`](./2026-07-15-hosted-connector-oauth.md)

## Context

Three Cloudflare Workers back the product. Only one was in the pipeline:

| Worker | Deploy today |
| --- | --- |
| `affiliate-mcp-hosted` (connect/auth/billing/digest) | CI, on merge (`deploy-hosted.yml`) |
| `affiliate-mcp-telemetry` (opt-in usage counts + dashboard) | **manual `wrangler deploy`** |
| `affiliate-mcp-containers` (MCP transport + digest compose) | **manual `wrangler deploy`** |

The two manual ones went live from a maintainer's machine, which is easy to
forget after a merge and ties deploys to one login. This just bit a release:
telemetry schema v2 needed the telemetry Worker deployed by hand before the npm
bump, and the containers OAuth-discovery fix (PR #376) merged but did not ship
because it needs a manual containers deploy. Rob's call: the remaining Worker
deploys should be part of the regular pipeline, like the hosted Worker and the
site, so no one has to remember a manual step every time.

The containers deploy is the reason this was not already done. Its two real
obstacles both turn out to be **easier in CI than on a laptop**:

1. **The cached-OAuth-session scope trap.** Local `wrangler deploy` for a Worker
   with `[[containers]]` validates the scopes of the cached OAuth session
   (`~/Library/Preferences/.wrangler/config/default.toml`) even when
   `CLOUDFLARE_API_TOKEN` is set, and fails if that stale session lacks
   container scopes (`containers/wrangler.toml` deploy-gotchas). A fresh CI
   runner has **no cached session**, so wrangler authenticates with the token
   alone — the trap cannot occur.
2. **The image build.** GitHub-hosted `ubuntu-latest` runners ship Docker, and
   `wrangler deploy` builds + pushes the container image (repo-root
   `Dockerfile`) during deploy. No extra machinery is needed.

## Decision

Add two workflows mirroring `deploy-hosted.yml` (path-scoped, gated, config from
Actions variables, secrets pre-set on the Worker, auth via the repo secrets
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). No secret ever reaches CI.

### `deploy-telemetry.yml`

- **Runs on push to `main`** when `telemetry-cloudflare/**` (or the workflow)
  changes; also `workflow_dispatch` with a typed `confirm: deploy`.
- Gated on the telemetry package's `typecheck` and a `wrangler deploy --dry-run`
  (config/bindings resolve). Not gated on the root test suite: the telemetry
  Worker is aggregate, best-effort, non-billing, and its unit tests already run
  in `ci.yml` on the same commit.
- `telemetry-cloudflare/wrangler.jsonc` already holds real, non-secret config
  (custom domain, D1 id, vars), so nothing is injected. Deploy uploads code +
  vars + bindings; D1 migrations stay a separate deliberate `db:migrate`.

### `deploy-containers.yml`

Triggers, chosen so the deployed transport stays correct without recycling live
MCP sessions on every unrelated merge:

- **Push to `main`** touching `containers/**`, `Dockerfile`,
  `src/hosted-transport/**`, or `src/hosted-digest/**` — the transport/digest's
  own code and the image definition (Rob's "auto on push", scoped to what only
  the container ships).
- **After a published release** (`workflow_run` on `Publish` completing
  successfully on `main`). The container image bundles all of root `src/`
  (`Dockerfile`), so adapter and shared-code changes reach the hosted transport
  in lockstep with each npm release — the same "every client receives the same
  working set per release" contract `RELEASING.md` already states for tools and
  skills. This closes the gap where an adapter fix would otherwise never reach
  hosted users until some unrelated container change triggered a deploy.
- **`workflow_dispatch`** with a typed `confirm: deploy`.

A redeploy recycles the single pinned `max_instances = 1` transport instance,
briefly dropping the in-memory `sessions` map; clients reconnect automatically.
Tying full-image redeploys to releases + infra changes (not every merge) keeps
that disruption rare and predictable. Raising `max_instances` still needs the
session-affinity design in `containers/src/index.ts`; unchanged here.

Config split (as hosted): the two **public, deployment-specific** origins are
injected from Actions **variables** with `__…__` placeholders in the committed
`containers/wrangler.toml`, and the workflow fails fast if any placeholder
survives — a template config can never reach production and no account's domain
is hardcoded into the public repo:

- `TRANSPORT_PUBLIC_URL` → `__TRANSPORT_PUBLIC_URL__` (this Worker's own custom
  domain, e.g. `https://mcp.agenticaffiliate.ai`; gates OAuth discovery).
- `HOSTED_WORKER_ORIGIN` → `__HOSTED_WORKER_ORIGIN__` (the hosted Worker's
  origin the containers call).

The only container secret, `DIGEST_COMPOSE_SECRET`, is optional and set once via
`wrangler secret put`; a code deploy does not touch it.

### One-time setup (the only remaining manual work — never per-deploy)

Rob does this once; after it, every telemetry/containers deploy is automatic:

1. **Broaden the existing `CLOUDFLARE_API_TOKEN`** repo secret to add
   `Account → Containers → Edit` and `Account → Cloudchamber → Edit` (it already
   carries Workers + KV; both container scopes are required — Containers alone
   does not authorise the image push). One token for all three deploy
   workflows (chosen over a separate token for simplicity; the token already
   deploys the billing surface, so its blast radius is already high).
2. **Set repo Actions variables** (Settings → Secrets and variables → Actions →
   Variables): `TRANSPORT_PUBLIC_URL`, `HOSTED_WORKER_ORIGIN`.

## Rejected alternatives

- **Deploy containers on every push to `main`.** Correct (the image tracks all
  of `src/`) but recycles the live transport and Docker-builds on essentially
  every merge. Release-coupling gets the same correctness with rare, predictable
  disruption.
- **`containers/**`-only path filter.** Simplest, but leaves hosted users on
  stale adapters until an unrelated container change ships — a silent
  correctness gap.
- **A separate containers-only API token.** Tighter scope isolation, but two
  tokens to rotate; deferred, not precluded.
- **Committing the real origins inline.** They are public, but hardcoding one
  account's domains into a forkable public repo is what the injection pattern
  exists to avoid.

## Consequences

- After the one-time setup, PR #376's discovery fix and every future
  telemetry/containers change ship automatically; the release-ordering footgun
  (worker must precede the npm bump) is gone for telemetry.
- CI gains a Docker image build on containers deploys (minutes); acceptable and
  infrequent given the trigger scoping.
- Manual `wrangler deploy` remains available and documented as the break-glass
  path (`workflow_dispatch`, or local for an emergency).
