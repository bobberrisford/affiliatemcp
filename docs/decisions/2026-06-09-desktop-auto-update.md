# Desktop app auto-updates via electron-updater

- **Date:** 2026-06-09
- **Status:** Accepted
- **Affects:** `desktop/` (Electron app, build config, release process), `DEPLOY.md`
- **Depends on:** the free desktop app ([#152](https://github.com/bobberrisford/affiliatemcp/pull/152)) as its foundation

## Context

The desktop setup app ships free, signed, and notarised, distributed as a direct
`.dmg` on GitHub Releases (see the free-desktop-app decision,
[`2026-06-09-desktop-app-free.md`](./2026-06-09-desktop-app-free.md)).

It has no update mechanism. That is a first-release problem, not a later-release
problem: **a build with no update awareness can never tell its users that a newer
build exists.** If v0.1 ships without one, every early adopter is stranded on
manual re-download until they happen to install a future build that finally
includes the checker. So an update path — at minimum a check — must ship in the
first release.

The app's shape makes this easy. It is **launch-and-quit**: the user opens it
occasionally to add a network or reconfigure, then closes it. That is the ideal
shape for check-on-launch / install-on-quit.

We already meet the hard prerequisites for native auto-update:

- Developer ID code signing + notarisation, hardened runtime (`teamId` set);
- electron-builder as the build tool;
- GitHub Releases as the distribution channel.

The gaps are small and mechanical.

## Decision

Use **`electron-updater`** (Squirrel.Mac) with **GitHub Releases as the update
feed**. The app checks for updates on launch, downloads in the background while
the user does setup, and installs on quit.

**Graceful fallback.** If an update download or signature check fails, the app
shows a non-blocking "a new version is available → download" banner (a
lightweight GitHub Releases version check) rather than failing silently. So the
worst case degrades to manual update, never to "stuck and unaware".

**Sequencing.** This lands in its own focused PR, **not** folded into #152
(auto-update is a separable outcome and a distinct security domain; folding it in
re-opens the split concern already raised on #152). The only hard constraint is
that it must merge **before the v0.1 release tag** is cut.

## Security

Auto-update is a code-execution channel — the app downloads and runs new
binaries. Mitigations:

- only updates whose signature + notarisation Squirrel.Mac validates are
  installed (built-in on macOS for Developer-ID-signed apps);
- the feed is served over HTTPS from GitHub Releases; no custom or unsigned
  update sources;
- no silent downgrade — version comparison only moves forward.

This is a release/deployment + security change and is a risk-based review item.

## Rejected alternatives

- **Version-check banner only.** Simpler (~2 hrs), but leaves the user dragging
  the new app into `/Applications` by hand. Kept as the *fallback* path inside
  this decision, not the primary mechanism.
- **Homebrew Cask (`brew upgrade`).** Good for technical users, wrong audience
  for a non-technical v0.1. Deferred to Phase 2.
- **Defer / ship nothing.** Produces exactly the stranded-early-adopter failure
  that motivated this decision. Rejected.

## Consequences

- **Build config:** `mac.target` becomes `["dmg", "zip"]` (Squirrel.Mac updates
  from the zip), and a `publish` block (`github` provider) is added so
  electron-builder emits `latest-mac.yml`.
- **Release process:** each release must publish `latest-mac.yml` + the zip
  alongside the `.dmg`. `DEPLOY.md` gains a release-publish step (updated in the
  implementation PR).
- **Artifacts:** a `zip` target increases per-release artifact size.
- **Cleanup:** `desktop/package.json` still declares the `affiliate-mcp://`
  protocol left over from the removed licence deep-link; remove it in the same
  PR.
- **Windows:** an `electron-updater` + NSIS updater is Phase 2, out of scope here.

## Implementation follow-ups

A focused PR stacked on the desktop app:

1. add `electron-updater` dependency;
2. `mac.target: ["dmg", "zip"]` + `publish: { provider: "github" }` in
   `desktop/package.json`;
3. wire `autoUpdater` in `desktop/main.js` (check on launch, background download,
   install on quit, events surfaced to the renderer) with the version-check
   banner as the failure fallback;
4. a small renderer affordance ("downloading update…" / "restart to update");
5. remove the vestigial `affiliate-mcp://` protocol entry;
6. update `DEPLOY.md` with the publish step.

Keep the implementation PR draft until this decision merges; it must merge before
the v0.1 release tag.
