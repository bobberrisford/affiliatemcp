# Distribution and listings plan

> Status: proposed. Owner: Rob. Written 2026-07-28.
>
> Goal: get `affiliate-mcp` listed in every credible place an MCP-capable
> client, operator, or agency looks for servers, in the order that produces the
> most reach per hour spent.

## 1. What already exists

Verified on 2026-07-28 against `origin/main` and the live services.

| Asset | State |
| --- | --- |
| npm `affiliate-networks-mcp` | Published at 0.19.0. `mcpName` is set to `ai.agenticaffiliate/affiliate-networks-mcp`, which is the official registry's npm ownership marker. |
| `server.json` | Present at repo root on `main`. Schema `2025-12-11`, version 0.19.0, declares the npm stdio package and the `streamable-http` remote. |
| Hosted remote | `https://mcp.agenticaffiliate.ai/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=...`, and `/.well-known/oauth-protected-resource` returns 200. This is the shape remote directories expect. |
| Claude Code plugin | `.claude-plugin/plugin.json` and `marketplace.json` exist. |
| Desktop bundle | `mcpb/` builds a `.mcpb` for Claude Desktop and the org Desktop Extensions allowlist. |
| Marketing site | `agenticaffiliate.ai` live on Pages, with `hosted.html`, `download.html`, `skills.html`. |

Most of this landed in #426 ("MCP Registry listing, and the 0.19.0 release it
needs") on 2026-07-28. That PR added `server.json`, pinned `mcpName` to the
listing name, pulled both `server.json` version fields into the CI-enforced
version touch-point set (five to seven), and wrote the operator runbook into
`RELEASING.md`. It deliberately stopped short of two things: CI does not run the
registry step, and the first publish still needs a DNS TXT record. This plan
picks up from there and widens the scope from one registry to the whole
distribution surface.

Two gaps block everything downstream:

1. **No apex DNS TXT record** on `agenticaffiliate.ai`. `dig +short TXT
   agenticaffiliate.ai` returns nothing. Because `server.json` and the npm
   `mcpName` both commit to the `ai.agenticaffiliate/*` namespace, DNS
   authentication is the only way to publish under that name. Switching to
   `io.github.bobberrisford/*` would mean republishing npm with a changed
   `mcpName`, so adding the TXT record is the cheaper path.
2. **The server has never been published to the official registry.** The
   metadata is written and the npm precondition is satisfied (0.19.0 carries
   `mcpName`; 0.18.0 predated it), but `mcp-publisher publish` was never run.

### Where this sits among existing docs

Three documents now touch distribution. They do not overlap, and each should
stay in its lane:

- `RELEASING.md` — the operator runbook for the MCP Registry listing. Steps.
- `docs/product/directory-listing-submissions.md` — the Claude and ChatGPT
  connector-directory submissions. Copy, claims discipline, and who submits.
- **This document** — everything else, and the ordering across all of it.

## 2. Why the official registry comes first

The official registry at `registry.modelcontextprotocol.io` is not one listing
among many. It exposes an unauthenticated read-only REST API
(`GET /v0.1/servers`) that aggregators are expected to scrape roughly hourly,
and it supports subregistries that re-serve its OpenAPI spec with their own
metadata layered on. Smithery, Glama, QVeris and the VS Code gallery all
consume it.

One publish therefore propagates to most of the long tail without any further
submissions. Everything in Tier 2 below is either fed by it automatically or
made much easier by it.

## 3. Gating quality checks

Do these before submitting anywhere. Directory reviewers read the description,
open the repo, and in Anthropic's case exercise the tools.

- **Keep the network count consistent.** Resolved on 2026-07-28: the live site
  and `README.md` agree at 72 network families and 86 adapters. The unmerged
  `site/refresh-wip` redesign had regressed the homepage counter to 64; that is
  fixed on the branch. Before each submission, confirm `server.json`,
  `package.json`, `plugin.json`, the site and the submission text still agree,
  because listings copy whatever text they are given and the mismatch is visible
  to any reviewer who clicks through.
- **Keep the honesty line in the short description.** "Most adapters
  experimental" is already in `server.json`. It should survive into every
  listing. It is also a differentiator: almost no directory entry admits this.
- **Decide the tool-surface story.** This is the single biggest risk in the
  plan, and it is larger than first estimated. Measured against `origin/main` on
  2026-07-29:

  | Metric | Value |
  | --- | --- |
  | Tools returned by `tools/list` | **682** |
  | Payload size | **442.2 KiB** |
  | Rough token cost | **~113,000** |
  | Distinct network prefixes | 87, median 7 tools each |

  Both transports return the identical unfiltered set. `src/server.ts` and
  `src/hosted-transport/mcp-server.ts` each answer `ListToolsRequestSchema` with
  every tool from `generateAllTools()`, and `src/networks/index.js` registers
  every adapter unconditionally. There is no filtering by configured
  credentials, connected vault networks, or environment, and no mechanism exists
  to add one today.

  Two consequences, and the first is the more important:

  1. **This is a live problem for existing users, not a submission problem.** A
     user who has configured one network still pays ~113k tokens of tool
     definitions before asking anything. That is most of a context window spent
     on 86 adapters they do not use.
  2. Anthropic's connector review checks that a connector "behaves well when
     every tool is called". 682 tools is a plausible hard fail.

  Changing what `tools/list` returns is a public MCP contract change, so it
  needs a decision record before implementation, per `AGENTS.md`. Sketch of the
  options, not a recommendation to implement yet: filter to connected networks
  (the hosted transport already knows these from the vault, and the local path
  could read configured credentials); ship a curated default with an opt-in to
  the full set; or keep a small always-on core and move per-network operations
  behind a discovery tool. Note `affiliate_list_networks` and
  `affiliate_run_diagnostic` already exist as the discovery entry points, which
  makes the third option less disruptive than it sounds.

  Resolve this before the Anthropic submission, not before the registry publish.
- **Confirm `PRIVACY.md` answers the standard directory questions**: what data
  leaves the machine, who processes it, retention. Local-first is a strong
  answer; make sure it is stated in one paragraph a reviewer can quote.

## 4. Tier 0: the official MCP Registry

Effort: one afternoon, most of it DNS propagation. Impact: highest.

The operator runbook already exists in `RELEASING.md` ("MCP Registry: one-time
setup"). Do not duplicate it here. What follows is only the state of each step
and the decisions behind them.

1. Generate the Ed25519 keypair and derive the TXT record. **Done
   2026-07-28.** The key is at `~/.affiliate-mcp/mcp-registry-key.pem` (mode
   600) with the hex seed `mcp-publisher` needs alongside it at
   `mcp-registry-key.hex`. Both are outside the repo. The documented macOS
   LibreSSL problem (`Algorithm Ed25519 not found` in `genpkey`) did not apply:
   this machine has OpenSSL 3.6.2 as the system `openssl`. On a machine that
   does ship LibreSSL, use `brew install openssl@3` and call
   `/opt/homebrew/opt/openssl@3/bin/openssl` explicitly, or take the ECDSA P-384
   codepath.
2. Add the TXT record at the **apex** of `agenticaffiliate.ai` in Cloudflare
   DNS, in the form `v=MCPv1; k=ed25519; p=<base64>`. Not under a selector such
   as `_mcp-auth`; the registry follows SPF-style apex placement and a selector
   record fails with a generic signature error. **Rob's action**: this changes
   DNS on the production domain.
3. `mcp-publisher login dns --domain agenticaffiliate.ai --algorithm ed25519
   --private-key "$(cat ~/.affiliate-mcp/mcp-registry-key.hex)"`
4. Confirm `server.json` version equals the published npm version, then
   `mcp-publisher publish`. This is the first public listing, so it needs an
   explicit go-ahead.
5. Verify:
   `curl https://registry.modelcontextprotocol.io/v0.1/servers/ai.agenticaffiliate%2Faffiliate-networks-mcp/versions/latest`
6. **Automate it.** `RELEASING.md` currently lists `mcp-publisher publish` as a
   manual post-release step and notes that skipping it "leaves the registry
   advertising the previous version". That is a silent failure by design, and
   manual release steps get skipped. Wire it into
   `.github/workflows/publish.yml` so npm and the registry publish in one pass.
   Note this does **not** need a version-sync step: #426 pinned both
   `server.json` version fields with assertions in
   `tests/shared/telemetry.test.ts`, so a stale listing version fails CI before
   it can reach the registry. Automating the publish is the only missing piece.

**Namespace and auth decision.** The registry offers `mcp-publisher login
github-oidc`, which needs no stored secret but only grants the
`io.github.bobberrisford/*` namespace. `server.json` and the published npm
`mcpName` both commit to `ai.agenticaffiliate/*`, which requires DNS auth and
therefore one stored key. Keep the DNS namespace: the brand name is worth more
than avoiding a secret, switching means republishing npm with a changed
`mcpName`, and `RELEASING.md` already records that renaming after publication
creates a second listing rather than moving the first. The blast radius of the
key is narrow, and recovery is rotating the TXT record.

Store the private key in 1Password, and in CI as a secret scoped to a protected
Environment restricted to `main` rather than a plain repo secret. The registry
docs call this out specifically: a plain repo secret is readable by any workflow
the repo runs.

## 5. Tier 1: first-party client surfaces

These are the surfaces where the audience actually is. They are not fed by the
registry and each needs its own submission.

### 5a. Claude and ChatGPT connector directories

**`docs/product/directory-listing-submissions.md` owns both of these.** It holds
the shared fact table, the claims discipline, the draft Claude copy, and the
category and auth guidance. Do not restate any of it here; that doc exists so
the two listings cannot drift apart. This section records only what this plan
adds.

Two rules from that brief that govern the whole plan, worth repeating once
because they change who does what:

- **An agent prepares; Rob submits.** Nothing is submitted, published, or posted
  by an agent.
- **Do not hand-maintain a tool count** in listing copy. Adapters register their
  tools automatically.

What this plan adds:

- The directory accepts remote HTTPS connectors only, so the **hosted** service
  is the eligible artefact. The local stdio server surfaces as
  `ant.dir.ant.<hash>.affiliate-networks-mcp: No server configuration found`;
  `DEPLOY.md` §7 records it.
- The hosted remote is technically ready: `/mcp` answers 401 with a
  `WWW-Authenticate` challenge and `/.well-known/oauth-protected-resource`
  returns 200, which is the shape the directory expects.
- Review covers tool design, authentication, privacy, allowed external links,
  documentation, support, and whole-tool-surface behaviour. **§3's 682-tool
  finding is the blocker here**, and it is the reason to resolve that before
  submitting rather than after a rejection.
- Aim for the community tier first; verified review is deeper and slower.

**The ChatGPT blocker recorded in that brief is now stale.** It says to fix
`site/faq.html` first, because the FAQ claimed a remote HTTPS path was "planned
but not shipped". The live FAQ now reads: "ChatGPT cannot run the local server,
so it needs the hosted connector, which is live". That correction has landed, so
the ChatGPT submission is unblocked on that count. The remaining honest caveat
belongs in the listing itself: a ChatGPT user cannot use the free local path.

Claude remains the highest-value single listing, because it reaches Claude.ai,
Desktop, Mobile, Claude Code and Cowork in one entry.

### 5b. Claude Code plugin marketplace

`.claude-plugin/marketplace.json` already exists, so the repo is installable as
a marketplace today via its GitHub URL. The work here is discovery, not
mechanics: get the marketplace listed in the community plugin indexes and
referenced from the site's get-started page, and confirm the plugin's
`mcpServers` block still matches the current CLI entry point.

### 5c. Claude Desktop Extensions

The `.mcpb` bundle covers both the individual install path and the org admin
allowlist path documented in `DEPLOY.md` §7. No public directory exists for
these, so the distribution channel is the site's download page plus the GitHub
release. Confirm the release "Latest" pointer behaviour still holds: npm `v*`
and `desktop-v*` share one pointer, and desktop stealing it 404s the site's
`.mcpb` link.

## 6. Tier 2: aggregators and catalogues

Most of these ingest the official registry. Do Tier 0 first, wait a week, then
check which ones picked the server up automatically and only hand-submit to the
ones that did not.

| Directory | How to get listed | Notes |
| --- | --- | --- |
| Smithery | `smithery mcp publish "https://mcp.agenticaffiliate.ai/mcp" -n agenticaffiliate/affiliate-networks-mcp`, or let it ingest from the registry | Publishing the remote makes it one-click installable from the Smithery CLI. Claim the listing either way. |
| Glama | Crawls GitHub and the registry automatically; claim ownership once it appears | Also renders the repo README, so README quality is the listing quality. |
| PulseMCP | Submission form; also crawls | Tracks estimated weekly visitors per server, which is a free usage signal worth having. |
| mcp.so | Submit button on the site, or a GitHub issue | Low effort, decent SEO. |
| Docker MCP Catalog | PR to `docker/mcp-registry` adding `servers/<name>/server.yaml`, plus `tools.json` and `readme.md` | Docker builds, signs, and publishes the image. Worth doing only if a containerised path fits the local-first model; the `Dockerfile` on `main` suggests it might. Treat as optional. |
| QVeris and other subregistries | Automatic from the registry | No action. |

## 7. Tier 3: other MCP clients

Each of these reads MCP servers but has its own install surface or directory.
The unit of work is a short install snippet on the site plus a directory entry
where one exists: Cursor, Windsurf, Cline, Continue, Goose, LibreChat, Zed,
Raycast, and the VS Code MCP gallery (which reads the official registry, so it
is covered by Tier 0).

Do not fan out here until Tiers 0 and 1 are live and the tool-surface question
is settled. A server that behaves badly in five clients is worse than a server
present in one.

## 8. Tier 4: non-MCP discovery

The MCP directories reach developers. The target cohorts in `AGENTS.md` are
mostly affiliate operators, who do not browse MCP directories.

- `punkpeye/awesome-mcp-servers`: PR in alphabetical order within the category.
  High-traffic, low effort.
- Product Hunt and Hacker News: one-shot, and worth saving until the hosted
  free tier and the registry listing are both live so the traffic lands
  somewhere useful.
- Affiliate-industry surfaces: this is the underexploited channel. Affiliate
  network partner directories, agency tool round-ups, and the existing LinkedIn
  motion reach the actual buyers. Route these through the
  `affiliate-mcp-marketing` skill rather than treating them as listings.
- npm keywords and README SEO: `package.json` keywords currently name thirteen
  networks. Operators search for their own network by name, so this is cheap
  long-tail reach.

## 9. What can and cannot be automated

Worth separating honestly, because "submit everywhere" sounds like a scripting
problem and mostly is not.

**Automatable, in CI, per release:**

- The official registry, via `mcp-publisher login dns` plus `publish` in
  `publish.yml`. Needs the `MCP_REGISTRY_KEY` secret. This is the one that
  matters, because it is also the one that silently goes stale.
- Smithery, via `smithery mcp publish`. Add only after the hosted tool surface
  is settled.
- npm metadata, the `.mcpb` asset and the GitHub release: already automated.

**Automatable as a watchdog, not a submission.** The higher-value automation is
not publishing, it is noticing rot. Nothing currently detects a listing that has
fallen behind. A weekly scheduled workflow should compare npm's latest version
against the live registry entry, confirm `https://mcp.agenticaffiliate.ai/mcp`
still answers 401 with its `WWW-Authenticate` header, and confirm
`releases/latest/download/affiliate-networks-mcp.mcpb` still returns 200. That
last check catches the known `v*` versus `desktop-v*` Latest-pointer collision
that 404s the site's download link, which nothing detects today. Open an issue
on mismatch rather than failing silently.

**Not automatable, and should not be faked:** the Anthropic Connectors
Directory (form plus human review), `awesome-mcp-servers` (PR, human review),
Glama and PulseMCP ownership claims, mcp.so. These are one-off, and the correct
tooling for them is a checklist with dates, not a script. Track them in the
tracking issue for this plan.

## 10. Suggested order

1. ~~Fix the network-count inconsistency across all metadata files.~~ Done; the
   only offender was the unmerged redesign branch.
2. ~~Add the apex TXT record, publish to the official registry, verify.~~ Done
   2026-07-29: live at 0.19.0, status `active`, and first result for
   `?search=affiliate`.
3. Automate registry publish in `publish.yml`. (Small CI PR; blocked only on the
   `MCP_REGISTRY_KEY` secret.)
4. Resolve the 682-tool surface. **Decision record required** before any
   implementation, because it changes what `tools/list` returns and that is a
   public MCP contract. This is now the critical path for everything in Tier 1.
5. Prepare the Claude connector-directory submission per
   `directory-listing-submissions.md`, for Rob to submit. Then ChatGPT, whose
   FAQ blocker has cleared.
6. Wait a week, audit which aggregators ingested automatically, hand-submit the
   rest and claim every listing.
7. `awesome-mcp-servers` PR, npm keyword expansion, client-specific snippets.
8. Product Hunt and Hacker News, once the funnel behind them is proven.

## 11. Stop conditions

- Do not submit anywhere while the network count disagrees between the site and
  `REPORT.md`. In particular, do not submit off the back of the
  `site/refresh-wip` copy until that branch has merged and been re-checked.
- Do not submit the local stdio server to any remote-only directory. That failure
  mode is already documented.
- Do not submit to either connector directory before the 682-tool surface is
  answered. A rejected submission is slower to fix than a delayed one.
- No agent submits anything. Agents prepare copy and assets; Rob submits. This
  is `directory-listing-submissions.md`'s rule and it applies to every surface
  in this plan, not just the two it covers.
- Registry metadata must never be published by hand twice. If step 3 is not
  done, step 2 must be repeated manually on every release, and it will not be.
