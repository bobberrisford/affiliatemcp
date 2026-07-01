# Signed desktop release pipeline (CI-published auto-update feed)

- **Date:** 2026-07-01
- **Status:** Accepted (merged 2026-07-01, PR #294)
- **Affects:** `.github/workflows/` (new `desktop-release.yml`; `desktop-dmg.yml`
  kept as-is for test builds), `desktop/package.json` (version + `build.mac.target`
  + `build.publish`), `DEPLOY.md` (runbook shifts from local to CI dispatch), and
  release authority
- **Depends on:** the accepted desktop auto-update decision
  ([`2026-06-09-desktop-auto-update.md`](./2026-06-09-desktop-auto-update.md));
  carries the "relaunch to update" pill
  ([#292](https://github.com/bobberrisford/affiliatemcp/pull/292), merged) to users

## Context

Signing and notarisation are **already live in CI**. The `desktop-dmg.yml`
workflow builds a signed, notarised, stapled **universal `.dmg`** on a
GitHub-hosted `macos-14` runner, and all five signing secrets are set on the repo
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`). The first signed release, `desktop-v0.1.2`, was cut this way and
verifies as `Notarized Developer ID`.

But that workflow is a **test-build tool, not a release pipeline**:

- it runs `electron-builder --mac dmg --universal --publish never`, so it uploads
  the `.dmg` only as a CI **artifact** — it does not create a GitHub Release;
- it builds the `dmg` target only, so it never emits the **`-mac.zip` +
  `latest-mac.yml` (+ blockmap)** that `electron-updater` reads as its feed;
- its trigger defaults to an old branch `ref` and it holds `contents: read`.

Consequence: **`desktop-v0.1.2` carries no auto-update assets, so in-app
auto-update is not actually wired for users yet.** The pill merged in #292 will do
nothing until a release publishes the feed. Closing that gap is the point of this
decision.

## Decision

Add a **`desktop-release.yml`** workflow on a `macos-14` runner that builds, signs,
notarises, staples, and **publishes the full mac auto-update feed** — `.dmg` +
`-mac.zip` + `latest-mac.yml` (+ blockmaps) — to a GitHub Release under the
existing `desktop-v` tag prefix. It reuses the exact signing path and secrets
`desktop-dmg.yml` already uses.

**Trigger — `workflow_dispatch` with a required `version` input.** The workflow:

1. checks out `main`, sets `desktop/package.json` to the input version, commits the
   bump, and tags `desktop-v<version>` (forward-only);
2. builds signed + notarised `dmg` **and** `zip` targets, staples the `.dmg`;
3. publishes the `.dmg`, `-mac.zip`, and `latest-mac.yml` as assets on the
   `desktop-v<version>` release (`electron-builder --publish always` with the
   built-in `GITHUB_TOKEN`).

Rationale: explicit and agent-triggerable (`gh workflow run … -f version=…`); the
version input owns the forward-only bump so there is no split between "bump" and
"build"; no accidental-tag-push failure mode.

**`desktop-dmg.yml` stays** as the throwaway test-build (artifact-only) path;
`desktop-release.yml` owns publishing.

**Signing identity — personal Developer ID now, org identity before GA.** Unchanged
from the current live setup; migrating to an org Developer ID is a tracked pre-GA
re-sign (users see no install-time difference).

**Authority.** Cutting a release stays a maintainer-authorised action. The workflow
is the *mechanism*; the agent may trigger it only on explicit maintainer
instruction for that specific release, consistent with the merge policy in
`AGENTS.md`. This does not grant autonomous release authority.

## Security

Auto-update is a code-execution channel, so the release path is a security
surface. Mitigations:

- **Secrets stay in GitHub Actions** (already provisioned), imported to a temporary
  keychain on the ephemeral runner by electron-builder's built-in `CSC_*` path;
  never in the repo.
- **Only signed + notarised builds are published.** Squirrel.Mac validates the
  Developer ID signature + notarisation on the client before installing; no
  unsigned or custom feed.
- **Forward-only.** `electron-updater` never downgrades; the `version` input must
  exceed the latest published `desktop-v*` (currently `0.1.2`).
- **Scoped elevation.** `desktop-release.yml` needs `contents: write` (to push the
  bump commit + tag and create the release); `desktop-dmg.yml` keeps
  `contents: read`. The release job runs only from `main` and only via explicit
  dispatch.
- Personal-vs-org signing identity is an accepted interim risk with a pre-GA
  migration + secret rotation follow-up. (The app-specific password was entered
  interactively once during setup; rotate it as part of that pass.)

This is a release + deployment + security change and is a risk-based review item.

## Rejected alternatives

- **Extend `desktop-dmg.yml` in place.** Overloads a test-build tool with publish
  semantics and `contents: write`. Keeping build-only and publish workflows
  separate is clearer and safer. Rejected.
- **Tag-push trigger only.** Splits the version bump from the build and lets a
  mistyped tag ship a release. Rejected in favour of the version-input dispatch.
- **Keep manual local publish** (`DEPLOY.md` §4 as primary). The bottleneck that
  left `desktop-v0.1.2` without an update feed. Retained only as a fallback.
- **Wait for the org signing identity.** Blocks shipping during beta for provenance
  polish that is a later re-sign. Rejected; tracked as a follow-up.

## Consequences

- No new secret provisioning — the five secrets already exist. Implementation is
  unblocked once this decision merges.
- `DEPLOY.md` §2–4 shift from "local runbook" to "dispatch `desktop-release.yml`";
  the local build stays documented as a fallback.
- The **first pipeline release is `desktop-v0.1.3`** (main is `0.1.2`). It both
  ships the auto-update pill (#292) and, crucially, publishes the **first working
  auto-update feed** — so this is the release that actually turns on in-app updates
  for users.
- Windows build + updater remain Phase 2, out of scope.
- Follow-up: migrate to the org signing identity before GA, then rotate the signing
  secrets.

## Implementation follow-ups

After this decision merges, in a focused implementation PR:

1. `.github/workflows/desktop-release.yml` — `macos-14`; required `version` input;
   `contents: write`; set version + commit + tag `desktop-v<version>`; `npm ci`
   (root + `desktop`) + bundle; build signed + notarised `dmg` **and** `zip`;
   staple the `.dmg`; `electron-builder --publish always` with `GITHUB_TOKEN`;
   verify (`stapler validate` / `spctl`).
2. Confirm `desktop/package.json` `build.mac.target` includes both `dmg` and `zip`
   (per the auto-update decision) so `latest-mac.yml` is emitted.
3. Update `DEPLOY.md` to make dispatch the primary path; keep the local build as
   the documented fallback.
4. Cut `desktop-v0.1.3` as the first CI release — ships the pill and the first
   working update feed.
