# affiliate-mcp hosted Node services, packaged for Cloudflare Containers.
#
# WHY THIS FILE EXISTS: the hosted product runs as a Cloudflare Worker
# (`hosted/`) plus two Node services that cannot run as Workers — see
# `hosted/README.md`, "H4: remote MCP transport lives in the root workspace,
# not here", for the full reasoning (86 network adapters, ~120k lines,
# Node-only dependencies such as `pino` and `node:fs`, well past a Workers
# script bundle limit). Rob asked for those two services to run on
# Cloudflare too, via Cloudflare Containers (Workers + a container instance
# behind a Durable Object binding), so his entire hosted stack lives in one
# Cloudflare account. This Dockerfile is the artefact Cloudflare Containers
# builds and runs; `containers/wrangler.toml` is the Worker-side wiring that
# references it. See `hosted/README.md`, "Deploy on Cloudflare (all-in-one)"
# for the full deploy story, and the file-header comment in
# `containers/src/index.ts` for the container-routing design and its one
# open question (MCP session affinity across replicas).
#
# ONE IMAGE, TWO ROLES: `src/hosted-transport/` (the streamable-HTTP MCP
# transport, H4) and `src/hosted-digest/` (the digest-compose service, H6)
# are two separate long-running Node processes, not two build outputs — both
# are already compiled by the same `npm run build` into the same `dist/`,
# and both are already started via the same CLI dispatcher
# (`affiliate-networks-mcp hosted-transport` / `hosted-digest`,
# `src/index.ts`). Building one image and selecting the role at container
# start (`CONTAINER_SERVICE` below) was chosen over two separate
# Dockerfiles/images because:
#   - the build stage (npm ci + tsc) is identical for both roles — a second
#     Dockerfile would duplicate it for no benefit;
#   - Cloudflare Containers' instance model scales per container CLASS, not
#     per image, so `containers/wrangler.toml` still defines two container
#     classes (one per role, independently scaled) even though they share
#     this one image — the image is a build artefact, not the unit of
#     Cloudflare's scaling decision;
#   - a single image is one thing to build, scan, and version, and keeps
#     this Dockerfile's only repo-root footprint to one file.
# The trade-off: a rebuild of one service's code always rebuilds this shared
# image, but since both services already ship from the same `npm run build`
# output today (unparameterised), that is not a new coupling this file
# introduces — it is the status quo the Node CLI already has.
#
# Both services run in ONE process each, not multiplexed together in a
# single container instance: Cloudflare Containers' instance model maps one
# container instance to one Durable Object-routed unit of scale, and the
# transport (many concurrent long-lived MCP sessions) and the digest-compose
# service (occasional, stateless, cron-triggered requests) have very
# different scaling shapes. Running them as two container CLASSES from this
# one image — rather than one container instance supervising both node
# processes — keeps each role's instance count, restart behaviour, and
# health check independent, at the cost of the digest-compose class idling
# most of the time. That idle cost is cheap relative to the alternative: a
# single container instance running both processes would need its own
# process supervisor (no docker-compose or systemd inside one instance) and
# would force both roles to scale together, which is wrong for how
# differently they are used.
#
# Node 22: matches the CI node-version used for the `hosted`, `issuer`, and
# `waitlist` Worker jobs in `.github/workflows/ci.yml`, and satisfies this
# repo's root `package.json` `engines.node` (">=20").

# ---- build stage --------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Only what `npm ci` and `npm run build` need — see .dockerignore for the
# repo-root exclusions (desktop/, docs/, site/, tests/, etc.) that keep the
# build context small regardless of what is COPYed here.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Both services' default ports (src/hosted-transport/env.ts,
# src/hosted-digest/env.ts). Cloudflare Containers routes to whichever port
# the active role's HTTP server actually listens on; EXPOSE here is
# documentation for `docker run -p`, not a behavioural switch.
EXPOSE 8787 8788

# CONTAINER_SERVICE selects the role: "hosted-transport" (default, H4) or
# "hosted-digest" (H6). Cloudflare Containers sets this per container CLASS
# via ContainerStartupOptions.env at start time (see
# `containers/src/index.ts`); a plain `docker run` can set it directly, or
# omit it to get the transport by default.
ENV CONTAINER_SERVICE=hosted-transport

# Every other required var (HOSTED_AUTH_URL, HOSTED_VAULT_URL,
# DIGEST_COMPOSE_SECRET, …) is supplied at container-start time by whichever
# platform runs this image — never baked into the image. See
# `hosted/README.md`, "Deploy on Cloudflare (all-in-one)" for the full list
# per service.
CMD ["sh", "-c", "node dist/index.js \"$CONTAINER_SERVICE\""]
