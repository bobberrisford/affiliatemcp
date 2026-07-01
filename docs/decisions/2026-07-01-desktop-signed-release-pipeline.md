# Signed desktop release pipeline (CI-built, notarised, auto-update feed)

- **Date:** 2026-07-01
- **Status:** Proposed
- **Affects:** `.github/workflows/` (new desktop-release workflow), `desktop/package.json`
  (version + `build.publish`), `DEPLOY.md` (runbook shifts from local to CI),
  repository secrets, and release authority
- **Depends on:** the accepted desktop auto-update decision
  ([`2026-06-09-desktop-auto-update.md`](./2026-06-09-desktop-auto-update.md)) and
  the free desktop app; carries the auto-update "relaunch to update" pill
  ([#292](https://github.com/bobberrisford/affiliatemcp/pull/292), merged) to users

## Context

The desktop app auto-updates from GitHub Releases via `electron-updater`. Today a
release is cut **by hand on one Mac** (see `DEPLOY.md` §2–4): local
`electron-builder --mac` with signing + notarisation env set, then a manual staple
and publish of the `.dmg` + `-mac.zip` + `latest-mac.yml`.

That is a single-machine, single-person bottleneck:

- only the maintainer, on their Mac, can ship a desktop release;
- an agent cannot ship desktop work that is already merged to `main` — including
  the auto-update pill in #292;
- the flow drifts: `desktop/package.json` currently reads `0.1.1` while the latest
  published release is already `desktop-v0.1.2`. A hand build is one typo away from
  publishing a version `electron-updater` will refuse to serve (it never
  downgrades).

We want **repeatable, agent-triggerable releases** so merged desktop work reaches
users predictably, without weakening the signing/notarisation guarantees the
auto-update channel depends on.

The hard prerequisites already exist: Developer ID signing + notarisation are
wired through electron-builder's built-in `CSC_*` / `mac.notarize` path (verified
on electron-builder 26 + Electron 42, per `DEPLOY.md` §3), and the `desktop-v` tag
prefix already isolates the desktop channel from the npm server releases
(`build.publish` in `desktop/package.json`).

## Decision

Add a **GitHub Actions workflow on a GitHub-hosted macOS runner** that builds,
signs, notarises, staples, and publishes a desktop release end to end, using
electron-builder's built-in signing (`CSC_*`) and notarisation
(`mac.notarize` + `APPLE_*`), publishing to GitHub Releases under the existing
`desktop-v` tag prefix.

**Trigger — `workflow_dispatch` with a required `version` input.** The workflow:

1. bumps `desktop/package.json` (and its lockfile) to the input version;
2. commits that bump to `main` and tags `desktop-v<version>`;
3. builds, signs, notarises, and staples the `.dmg` + `-mac.zip`;
4. publishes those plus `latest-mac.yml` as assets on the `desktop-v<version>`
   release.

Rationale: explicit and agent-triggerable (`gh workflow run`), the version input
owns the forward-only bump so there is no split between "bump" and "build", and
there is no accidental-tag-push failure mode.

**Signing identity — personal Developer ID now, org identity before GA.** Use the
existing personal Developer ID certificate to unblock CI releases during beta.
Migrating to an org signing identity is a tracked pre-GA follow-up (a re-sign;
users see no difference at install time).

**Authority.** Cutting a release stays a maintainer-authorised action. The
workflow is the *mechanism*; the *authority* is unchanged — the agent may trigger
it only on explicit maintainer instruction for that specific release, consistent
with the merge policy in `AGENTS.md`. The workflow does not grant autonomous
release authority.

## Security

Auto-update is a code-execution channel, so the release path is a security
surface. Mitigations:

- **Secrets never touch the repo.** `CSC_LINK` (base64 of the Developer ID `.p12`),
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
  live only as GitHub Actions repository secrets. The cert is imported into a
  temporary keychain on the ephemeral runner and dies with the VM.
- **Only signed + notarised builds are published.** Squirrel.Mac validates the
  Developer ID signature + notarisation on the client before installing; there is
  no unsigned or custom feed.
- **Forward-only.** `electron-updater` never downgrades; the version input must
  exceed the latest published `desktop-v*`.
- **Least privilege.** The job runs only from `main`, only via explicit dispatch,
  and holds `contents: write` solely to create the tag/release — nothing broader.
- Personal-vs-org signing identity is an accepted interim risk with a pre-GA
  migration follow-up and a secret rotation at migration.

This is a release + deployment + security change and is a risk-based review item.

## Rejected alternatives

- **Keep manual local builds.** The status-quo bottleneck: blocks agent-cut
  releases and drifts versions. Retained only as a documented fallback, not the
  primary path.
- **Tag-push trigger only.** Simpler workflow, but splits the version bump from the
  build and lets a mistyped tag ship a release. Rejected in favour of dispatch,
  where the version input owns the bump.
- **Self-hosted macOS runner.** Unnecessary; GitHub-hosted macOS runners sign and
  notarise correctly with electron-builder's built-in path. Rejected as needless
  operational burden.
- **Wait for the org signing identity before any pipeline.** Blocks shipping during
  beta for provenance polish that is a later re-sign. Rejected; tracked as a
  follow-up instead.

## Consequences

- The maintainer provisions the five signing secrets **once**; after that a release
  is a single `workflow_dispatch`.
- `DEPLOY.md` §2–4 shift from "local runbook" to "dispatch the workflow"; the local
  build stays documented as a fallback.
- The **first pipeline release must be `desktop-v0.1.3`** (it must exceed the live
  `desktop-v0.1.2`) and it carries the auto-update pill from #292 to existing users.
- Windows build + updater remain Phase 2, out of scope here.
- Follow-up: migrate to the org signing identity before GA, then rotate the signing
  secrets.

## Implementation follow-ups

After this decision merges **and** the maintainer has added the five secrets, in a
focused implementation PR:

1. `.github/workflows/desktop-release.yml` — macOS runner; required `version`
   input; import the cert into a temporary keychain; `npm ci` (root + `desktop`);
   set the version from the input; `electron-builder --mac --publish always` with
   the built-in `GITHUB_TOKEN`; staple the `.dmg` (`notarytool submit --wait` →
   `stapler staple`); verify (`stapler validate` / `spctl`).
2. The version bump, commit, and `desktop-v<version>` tag are handled inside the
   workflow from the input.
3. Update `DEPLOY.md` to make dispatch the primary path and keep the local build as
   the documented fallback.
4. Cut `desktop-v0.1.3` as the first CI release — the pill ships.
