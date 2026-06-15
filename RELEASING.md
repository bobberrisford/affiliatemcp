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
- [ ] Bump the server release version in **all five** touch-points. A release
      needs every one of these; missing any will fail CI:
  - [ ] `package.json` (npm + `.mcpb` source of truth).
  - [ ] `.claude-plugin/plugin.json` (must equal `package.json`).
  - [ ] `package-lock.json` root `version`.
  - [ ] `package-lock.json` `packages[""].version`. Easiest by re-running
        `npm install` after bumping `package.json`, which rewrites both lockfile
        fields.
  - [ ] `src/shared/telemetry.ts` `PACKAGE_VERSION`. `tests/shared/telemetry.test.ts`
        pins this to `package.json`, so a stale value fails CI.
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
