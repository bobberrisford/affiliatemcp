# Handoff — `feature/setup-docs`

**Chunk**: 8 — per-network setup documentation, tone fixes, report regeneration
**Branch**: `feature/setup-docs`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

### Per-network setup docs (`docs/networks/`)

Wrote one doc per bundled network, each following the PRD §8 / §15.16
quality bar:

- **`docs/networks/awin.md`** — 5–8 minute estimate (matches `network.json`'s
  `setup_time_estimate_minutes: 5`). No approval required. Six numbered
  steps from sign-in through wizard run, screenshot placeholders on every
  step, plus an explicit "What success looks like" paragraph and three
  common failures (missing tab on advertiser logins, 401 on token, wrong
  derived publisher ID).
- **`docs/networks/cj.md`** — 8–10 minute estimate (matches
  `setup_time_estimate_minutes: 8`). No approval required. Same shape as
  Awin. Three common failures cover advertiser-account confusion, 401 on
  the PAT, and GraphQL errors from the auto-derived `CJ_COMPANY_ID`.
- **`docs/networks/impact.md`** — 5–8 minute estimate (matches
  `setup_time_estimate_minutes: 6`). No approval required. Documents that
  both credentials sit on the same Settings → API screen. Three common
  failures cover 401, transient 5xx (explicitly noting the chunked-retry
  behaviour), and brand-vs-Mediapartner account confusion.
- **`docs/networks/rakuten.md`** — 10–15 minute estimate plus approval
  wait (matches `setup_time_estimate_minutes: 12` with the
  `setup_requires_approval: true` / `setup_approval_days_typical: 5`
  fields). Three credentials (`RAKUTEN_CLIENT_ID`,
  `RAKUTEN_CLIENT_SECRET`, `RAKUTEN_SID`), explicit step covering the
  Publisher-Solutions approval requirement, and a step covering the
  `RAKUTEN_TOKEN_URL` host override. Three common failures cover the
  missing *API Credentials* tab (approval pending), 404 on token
  exchange (wrong host), and 401 (credential typo / regenerated secret).

Each doc references exact UI labels where the orchestrator's notes and
the adapter `setup.ts` descriptions document them, and explicitly says
"label exact to TBD by a human reviewer" rather than guessing where
the label varies between tenants or where the orchestrator's notes are
silent. No fake screenshot images were generated; placeholders use the
`[SCREENSHOT: docs/networks/images/<slug>/<n>-<short>.png]` pattern.

### Image-directory scaffolding

Created `docs/networks/images/<slug>/` for each of the four networks
with a single `.gitkeep` file so the screenshot-placeholder paths
referenced in the docs have a real directory waiting for them.

### Tone fix in `docs/findings/rakuten.md`

Rewrote the meta-line at the top of the file. The previous version
quoted the anti-pattern verbatim ("describe what is true, not 'Rakuten
is bad'"), which then bled into the rendered REPORT.md. Replaced with
a positively-framed equivalent: "Notes describe access friction
matter-of-factly: what happened, what worked, what didn't." No
substantive findings were touched.

Files touched for tone:

- `docs/findings/rakuten.md` — single line replaced at the top of the
  document (the lead-in paragraph above the *Summary* section).
- `docs/findings/awin.md` — no changes; skimmed and found no
  tone-violation patterns.
- `docs/findings/cj.md` — no changes; skimmed and found no
  tone-violation patterns.
- `docs/findings/impact.md` — no changes; skimmed and found no
  tone-violation patterns.

After the fix, `grep -i "rakuten is bad"` returns zero hits across
both `docs/findings/` and the regenerated `REPORT.md`.

### REPORT.md regeneration

Ran `npm run generate:report` after the tone fix. The script wrote
`REPORT.md` (40,147 bytes, one byte more than the previous version
because the replacement sentence is one character longer). Verified by
grep that the "Rakuten is bad" phrase no longer appears anywhere in
the rendered output and that the new sentence is present in the
embedded findings block.

### Tests (`tests/docs/setup-docs.test.ts`) — +24 tests

Added one new test file with six structural assertions per network
(four networks × six checks = 24 new tests):

1. File exists at `docs/networks/<slug>.md` and is non-empty.
2. H1 includes "minutes" (time estimate present at the top).
3. A "## Prerequisites" section header exists.
4. At least one `[SCREENSHOT: …]` placeholder OR markdown image link
   pointing into `docs/networks/images/` is present.
5. A "## Common failures" (or "## Troubleshooting") section exists.
6. A "## What success looks like" (or equivalent — "Verifying",
   "Confirming", "Success") section exists.

These are deliberately structural rather than prose-level. The
editorial tone bar (UK spelling, matter-of-fact, no marketing) is
enforced at review time, not by these tests.

### README touch-up

The README previously said "Per-network setup notes live in
`docs/networks/<slug>.md` (added by a later chunk)." Since this is
that later chunk, replaced the parenthetical with an actual bulleted
list of clickable relative links to the four new docs. No other
README changes.

## Files added / changed

```
docs/networks/awin.md                  (new)
docs/networks/cj.md                    (new)
docs/networks/impact.md                (new)
docs/networks/rakuten.md               (new)
docs/networks/images/awin/.gitkeep     (new)
docs/networks/images/cj/.gitkeep       (new)
docs/networks/images/impact/.gitkeep   (new)
docs/networks/images/rakuten/.gitkeep  (new)
docs/findings/rakuten.md               (1-line tone fix)
tests/docs/setup-docs.test.ts          (new, 24 tests)
README.md                              (replaced placeholder paragraph
                                        with bulleted list of doc links)
REPORT.md                              (regenerated; 40,147 bytes)
handoffs/feature-setup-docs.md         (this file)
```

## What's tested

- `npm test` — **205 / 205 passing** (181 baseline + 24 new in
  `tests/docs/setup-docs.test.ts`).
- `npm run typecheck` — clean.
- `npm run lint` — clean (two pre-existing
  `no-non-null-assertion` warnings in `tests/cli/{doctor,setup}.test.ts`
  remain untouched; this chunk did not introduce them).
- `npm run build` — clean.
- `npm run generate:report` — ran end-to-end, wrote `REPORT.md`.

## Acceptance against §15.16

Every bundled network has a doc at `docs/networks/<slug>.md` that:

- opens with a title + time estimate aligned with `network.json`'s
  `setup_time_estimate_minutes` (and `setup_approval_days_typical` for
  Rakuten);
- declares prerequisites including approval expectations;
- lists numbered, single-action steps with screenshot placeholders;
- spells out what success looks like;
- documents the top three common failures with diagnoses and fixes.

The structural acceptance is encoded as automated tests; the editorial
acceptance (UK spelling, matter-of-fact prose, exact UI labels with
fallback wording for label drift) is in the prose itself and ready for
a human reviewer.

## What I did NOT do

- Did not touch `src/**`, `scripts/**`, or any other handoff.
- Did not push.
- Did not generate any real screenshot images. All `[SCREENSHOT: …]`
  references are placeholders pointing into `docs/networks/images/<slug>/`
  directories that exist (with `.gitkeep`) but contain no images.
- Did not change the substantive content of any findings doc.
- Did not add or remove any dependencies.

## Notes for the polish chunk

- **`setup.ts` description alignment.** The descriptions in
  `src/networks/<slug>/setup.ts` are broadly aligned with the new docs.
  The only minor divergence worth a polish-chunk look:

  - **Awin** — the `setup.ts` description points users to
    `Account → API credentials` via the "user menu (top-right) →
    Account". The doc walks the same path and uses the same labels.
    No drift.
  - **CJ** — the `setup.ts` description references
    `https://members.cj.com/`, the *Account* menu, and the *Personal
    Access Tokens* tab. The doc matches step for step.
  - **Impact** — the `setup.ts` description references
    `https://app.impact.com/`, *Settings (gear icon) → API*, and the
    *Account SID and Auth Token* page. The doc matches; I added a
    note that on the current UI the gear is in the bottom-left
    sidebar (vs. the older UI's top-right user-avatar menu). If a
    reviewer can confirm the current location, the `setup.ts`
    description could be tightened in the polish chunk to match.
  - **Rakuten** — the `setup.ts` description mentions Publisher
    Solutions approval and a 3–7-day turnaround; the doc mirrors
    that. The doc additionally documents the `RAKUTEN_TOKEN_URL`
    override (see step 6); the `setup.ts` description does not yet
    mention this. A polish-chunk improvement would be to surface the
    override in the wizard's failure path rather than in the doc
    only — though that arguably belongs to the wizard rather than
    to the per-step description.

  None of these are misleading; they are candidates for tightening,
  not corrections.

- **Screenshot capture is out of scope for this chunk.** The
  `docs/networks/images/<slug>/` directories are seeded with
  `.gitkeep` so the placeholder paths are not broken in CI checks
  that look for image link integrity, but no images exist yet.
  Capturing them requires a human signed in to each network's
  publisher dashboard. The placeholder pattern documents the
  filename each screenshot should use when it is added.

- **Tone-fix scope.** Only the one anti-pattern line in
  `docs/findings/rakuten.md` was rewritten. I read the other three
  findings docs in full and the other Rakuten paragraphs in full;
  none contained snark, marketing tone, opinionated absolutes, or
  exclamation marks that warranted editing. If a future review
  surfaces additional language to soften, this chunk's diff is the
  precedent: a single-sentence positive reframing rather than a
  rewrite.
