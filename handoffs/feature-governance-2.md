# feature/governance-2 — handoff

## 1. What I did

Finished the remaining Chunk 12 items that the original `feature/governance`
branch could not land. The earlier branch had already shipped: `LICENCE`
rename, README polish, `CONTRIBUTING.md`, `CORRECTIONS.md`, `WANTED.md`,
`docs/network-claim-process.md`, and the `examples/claude-desktop-config.*`
pair. This branch adds everything else that PRD §16 (governance) calls for.

Files created:

- `CODE_OF_CONDUCT.md` — short, original prose. Adopts the Contributor
  Covenant v2.1 by reference (link only); reporting placeholder
  `conduct@<placeholder>` for the maintainer to fill in pre-launch;
  enforcement note covering consistent application.
- `.github/ISSUE_TEMPLATE/config.yml` — disables blank issues, links to
  Contributing guide and Discussions.
- `.github/ISSUE_TEMPLATE/new-network-request.yml`
- `.github/ISSUE_TEMPLATE/network-broken.yml`
- `.github/ISSUE_TEMPLATE/new-skill-idea.yml`
- `.github/ISSUE_TEMPLATE/bug.yml`
- `.github/ISSUE_TEMPLATE/network-api-changed.yml`
- `.github/ISSUE_TEMPLATE/setup-stuck.yml`
- `.github/ISSUE_TEMPLATE/correction.yml`
- `.github/PULL_REQUEST_TEMPLATE/new-network.md` — full closing checklist
  (typecheck, lint, tests, validate:network, no credentials, no `console.log`,
  no `@ts-ignore`/`as any`, §5.5 tool descriptions, §4.1 error envelopes, UK
  spelling, regenerate README/REPORT, update CODEOWNERS/WANTED.md, setup doc
  shipped, named live vs `NotImplementedError` ops).
- `.github/PULL_REQUEST_TEMPLATE/default.md` and
  `.github/pull_request_template.md` — short generic template, kept identical
  so GitHub picks it up with or without `?template=` query.
- `.github/CODEOWNERS` — maintainer-only ownership for shared infra and the
  four bundled adapters; ready for per-network owner edits once contributors
  take responsibility.
- `.github/workflows/ci.yml` — minimal Node 20 CI matrix
  (`npm ci`, typecheck, lint, test, build). No live network tests.
- `.github/seed-issues/` — 14 pre-drafted issue bodies (7 network requests,
  3 skill ideas, screenshot refresh, setup-stuck example, correction example,
  roadmap RFC) plus a `README.md` explaining the convention and a `seed.sh`
  driver that derives labels from filename prefixes and shells out to
  `gh issue create`. Nothing is filed automatically.
- `tests/governance/readme.test.ts` — PRD §15.20 acceptance. Asserts README
  exists, 50–400 lines, required sections (Quick-start, Networks, Per-network
  setup, Tool surface, Licence), links to REPORT.md, links to at least one
  per-network setup doc, contains the generated network-table marker block,
  no marketing tokens (best, leader, world-class, unmatched, revolutionary,
  cutting-edge). Best-effort US-spelling warning that does not fail.

Files modified:

- `package.json` — added `src/skills` to the `files` array so the published
  npm package ships the four publisher skills. Also corrected the stale
  `LICENSE` entry to `LICENCE` so the published tarball includes the
  actually-present file.

## 2. What's tested

- **§15.20 README acceptance** — `tests/governance/readme.test.ts` (8 cases).
- `npm run typecheck` — clean.
- `npm run lint` — only the four pre-existing non-null-assertion warnings
  inherited from earlier chunks. No new lint output.
- `npm run build` — clean.
- `npm test` — 29 files, **248 tests pass (was 240; +8 net)**, all from the
  new README acceptance file.

## 3. What's unfinished

- `CODE_OF_CONDUCT.md` reporting contact is a placeholder
  (`conduct@<placeholder>`). The maintainer must replace it with a real
  address before public launch. The file calls this out explicitly.
- `CONTRIBUTING.md` references `.claude/skills/contribute/SKILL.md` and
  `templates/new-network/`. The contribute skill is being shipped in parallel
  on `feature/contribute-infra`; `templates/new-network/` exists already
  (per `ls templates/`). Both references are left as-is — they resolve once
  the parallel branch merges. No change was needed here.
- `AGENTS.md` is referenced in the README "For developers" section but not
  yet present in this tree (Chunk 11 in flight). Not touched here; the
  reference becomes live when that chunk lands.
- The `.github/seed-issues/seed.sh` script requires `gh` to be authenticated
  before it can file. Per the chunk spec, no issues were filed; the script
  is shipped as a tool for the maintainer to run post-launch.

## 4. What surprised me

- The PRD wants both `?template=new-network.md` (typed link) and the
  unguided fallback to work. GitHub's resolution rule is: a directory at
  `.github/PULL_REQUEST_TEMPLATE/` enables the `?template=` query parameter,
  but the implicit default-on-PR-creation template still comes from
  `.github/pull_request_template.md` at the root of `.github/`. To get both,
  I shipped `pull_request_template.md` at the root (the implicit default) and
  `PULL_REQUEST_TEMPLATE/default.md` inside the directory (kept identical so
  the two paths converge). The `new-network.md` template is selectable via
  the query.
- The original chunk spec embedded a joke test (`colour-of-cargo`) inside
  the spelling assertion. I substituted the realistic set the spec then
  pointed to (`behavior`, `colorize`, `optimize`) and made it warn-only so
  it cannot block on quoted upstream field names like `Behavior` if a
  network ships one. Failing CI on a quoted identifier would be a bad trade.
- I had to correct a stale `LICENSE` entry in `package.json#files` while
  adding `src/skills`. The file at the repo root is `LICENCE` (the
  partial-governance branch did the UK-spelling rename); the published
  package was therefore not actually shipping the licence file. Now it is.

## 5. Recommended next steps

- Replace the `conduct@<placeholder>` address in `CODE_OF_CONDUCT.md` before
  the repo goes public.
- Once `feature/contribute-infra` merges, verify the
  `.claude/skills/contribute/SKILL.md` link in `CONTRIBUTING.md` resolves
  and that the closing-checklist text in
  `.github/PULL_REQUEST_TEMPLATE/new-network.md` still matches the SKILL's
  closing-checklist section verbatim. They should — both were drafted from
  the same PRD bullet — but a quick cross-check is cheap.
- Once `AGENTS.md` lands (Chunk 11), regenerate or revisit the
  "For developers" paragraph of `README.md` so it links correctly.
- After public launch, run `.github/seed-issues/seed.sh` to populate the
  tracker with the 14 pre-drafted issues. The script is idempotent (skips
  titles that already exist).
- Consider a follow-up to wire the `.github/workflows/ci.yml` matrix into a
  required status check on `main` once the repo is public.
