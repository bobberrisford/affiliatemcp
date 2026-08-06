# Releasing affiliate-mcp

Maintainer checklist for cutting a release. The goal is that every user, on
every client, receives the same working set of tools **and** skills. Skills and
tools travel through two different channels, so both have to be checked.

## How users receive a release

| Channel | Carries | Install path |
| --- | --- | --- |
| npm (`affiliate-networks-mcp`) | the MCP **server** (tools only) | `npx … setup`, `claude mcp add`, `codex mcp add` |
| Plugin marketplace (this repo) | **skills + the server registration** | `claude plugin install`, `cowork-mirror` |
| MCP Bundle (`.mcpb` on the GitHub release) | self-contained local server + Claude Desktop setup fields | Claude Desktop Settings → Extensions |

Skills do not ship over npm. A user who only adds the bare MCP server gets
tools but no skills. Anything that depends on a skill must go through the
plugin path.

## Pre-release

- [ ] `npm test` is green. This includes the skill-set guard in
      `tests/skills/skills-exist.test.ts`, which fails if `skills/` drifts from
      the validated set, and the manifest checks in
      `tests/governance/plugin.test.ts`.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] `npm run verify:mcpb` builds and validates the Claude Desktop bundle.
- [ ] If a skill was added or renamed, it is registered in
      `tests/skills/skills-exist.test.ts` (SKILLS or AGENCY_SKILLS). The guard
      will have failed already if not.
- [ ] Regenerate derived docs if network data changed:
      `npm run generate:readme` and `npm run generate:report`.
- [ ] Bump the server release version in **all seven** touch-points. A release
      needs every one of these; missing any will fail CI:
  - [ ] `package.json` (npm + `.mcpb` source of truth).
  - [ ] `.claude-plugin/plugin.json` (must equal `package.json`).
  - [ ] `package-lock.json` root `version`.
  - [ ] `package-lock.json` `packages[""].version`. Easiest by re-running
        `npm install` after bumping `package.json`, which rewrites both lockfile
        fields.
  - [ ] `src/shared/telemetry.ts` `PACKAGE_VERSION`. `tests/shared/telemetry.test.ts`
        pins this to `package.json`, so a stale value fails CI.
  - [ ] `server.json` top-level `version` (MCP Registry listing).
  - [ ] `server.json` `packages[0].version`. The registry validates the listing
        against the live npm package, and both fields describe that same release,
        so `tests/shared/telemetry.test.ts` pins both.
- [ ] Confirm `desktop/package.json` is left alone. It is **not** bumped for a
      server release; the desktop app ships on its own `desktop-v*` version
      stream.
- [ ] Because `PACKAGE_VERSION` lives under `src/shared/`, the `check:change`
      guardrail (`scripts/check-change.ts`, run by the CI `build` job) blocks the
      change unless the same diff also touches a test under `tests/shared/` or
      `tests/integration/`. Bump `PACKAGE_VERSION` alongside a real edit to
      `tests/shared/telemetry.test.ts`, keeping the existing version-sync
      assertions meaningful, as releases 0.7.0 and 0.7.1 did.

## Verify the artifact, not the working tree

The tests read `skills/` off disk. Before publishing, confirm a clean checkout
actually contains the skills users will receive:

```
git archive --format=tar HEAD | tar -t | grep '^skills/.*/SKILL.md'
```

You should see one `SKILL.md` per shipped skill. A skill that is only an
untracked local folder (for example contributor-only skills under
`.claude/skills/`) will not appear here, which is correct: those are not part
of the user release.

## Publish

- [ ] `npm publish` (the server channel).
- [ ] Tag and push the release so the plugin marketplace source is current.
- [ ] Confirm the publish workflow attached
      `affiliate-networks-mcp-<version>.mcpb` to the GitHub release.
- [ ] Confirm the `registry` job in the publish workflow republished the MCP
      Registry listing. It runs automatically after a successful `npm publish`,
      because the registry verifies the version against the live npm package and
      so cannot run first. It fails loudly if the registry does not end up
      serving this version, which is deliberate: the previous manual step could
      be skipped without breaking the release, leaving the registry advertising
      an older version indefinitely.
      First release only: do the one-time setup below, which the job depends on.

## After publishing: refresh Cowork mirrors

Cowork org marketplaces sync from a **private** GitHub mirror, created per user
by `cowork-mirror`. That mirror is a point-in-time copy, so Cowork users keep
the previous release until they re-sync. The maintainer cannot sync someone
else's mirror, so this has to be communicated on every release:

- [ ] Note in the release notes that Cowork users must refresh their mirror:
      `npx affiliate-networks-mcp cowork-mirror --sync`
- [ ] If you maintain your own Cowork org mirror, run that command yourself.

This is the most common "worked once, then went stale" failure for Cowork, so
keep the reminder in every release, not just major ones.

## MCP Registry: one-time setup

`server.json` at the repository root is the MCP Registry listing. It advertises
both delivery paths: the free local npm package over stdio, and the hosted
connector at `https://mcp.agenticaffiliate.ai/mcp` over streamable HTTP.

The listing name is `ai.agenticaffiliate/affiliate-networks-mcp`, a
DNS-verified namespace, so the first publish needs the domain proved once:

- [ ] **Publish a release to npm that carries `mcpName` first.** The registry
      validates the listing by reading `mcpName` from the **published** package,
      not from this working tree, so the first `mcp-publisher publish` fails until
      a version containing it is live. Check with
      `npm view affiliate-networks-mcp mcpName`: empty means publish the npm
      release before going further. `0.18.0` predates the field.
- [ ] Install the publisher CLI (`mcp-publisher`; Homebrew, curl, or PowerShell
      per the registry docs).
- [ ] Add the DNS TXT record the registry asks for on the **apex** of
      `agenticaffiliate.ai`, not under a selector such as `_mcp-auth`. MCP DNS
      auth follows SPF-style apex placement, and a record under a selector fails
      with a generic signature error that does not point at the cause.
- [ ] `mcp-publisher login dns --domain agenticaffiliate.ai --algorithm ed25519
      --private-key "<hex seed>"`, then `mcp-publisher publish` from the
      repository root. Do the first publish by hand so the DNS proof is
      confirmed working before CI depends on it.
- [ ] Give CI the same key so every later release republishes automatically: add
      the hex seed as `MCP_REGISTRY_KEY`, in a protected Environment named
      `mcp-registry-publish` restricted to `main`. A plain repository secret is
      readable by any workflow the repository runs; the registry docs recommend
      the Environment for exactly this reason.
- [ ] Keep a copy of the private key in 1Password. Losing it means losing control
      of the `ai.agenticaffiliate` namespace until the TXT record is rotated.

Two constraints worth knowing before editing `server.json`:

- `description` is capped at **100 characters** by the schema, so it cannot
  restate the README. Keep it honest about maturity: most adapters carry
  `claim_status: experimental`, so check `REPORT.md` before implying breadth of
  support.
- `name` must equal `mcpName` in `package.json`. That pair is how the registry
  proves ownership, and `tests/shared/telemetry.test.ts` pins it.

To move to a GitHub-verified namespace instead, change both `server.json`'s
`name` and `package.json`'s `mcpName` to
`io.github.bobberrisford/affiliate-networks-mcp` and use
`mcp-publisher login github`. Renaming after the first publish creates a second
listing rather than moving the first, so decide before publishing.
