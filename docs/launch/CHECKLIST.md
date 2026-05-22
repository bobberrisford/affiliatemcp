# Launch-readiness checklist — affiliate-mcp v0.1

This document is the maintainer's tick-list for launch day. Each section
maps to a kind of work that must be confirmed before the project is
publicly announced. Treat each box as a hard gate — if it cannot be
ticked, the launch should slip.

The chunked build is complete (Chunks 1–13 merged). The structural
quality bars from PRD §15 are covered by the handoffs under
`handoffs/feature-*.md`; this checklist links each bar to its covering
chunk so a launch reviewer can audit the trail.

UK English throughout. Matter-of-fact. No marketing language.

---

## 1. Code & build (PRD §15 quality bars)

The bars below are the structural acceptance criteria. They are covered
by the named chunk; the relevant handoff under `handoffs/` documents
how.

- [ ] **§15.1** — `npm test` green on a fresh checkout
  (`handoffs/feature-adapter-polish.md`)
- [ ] **§15.2** — Bad-key rehearsal: each network surfaces a
  `NetworkErrorEnvelope` with the verbatim 401 body
  (`handoffs/feature-adapter-polish.md`,
  `handoffs/feature-network-ebay.md`)
- [ ] **§15.3** — Diagnostic engine returns per-operation capability
  results with claim_status surfaced
  (`handoffs/feature-adapter-polish.md`)
- [ ] **§15.4** — Errors carry verbatim upstream bodies on
  `networkErrorBody` (`handoffs/feature-adapter-polish.md`)
- [ ] **§15.5** — Resilience wrapper is the only outbound HTTP path; no
  ad-hoc `fetch` outside `client.ts`
  (`handoffs/feature-foundations.md`)
- [ ] **§15.6** — Stdin/stdout reserved for MCP transport; all logging
  on stderr (`handoffs/feature-foundations.md`)
- [ ] **§15.7** — Adapter registry: importing
  `src/networks/index.ts` registers every adapter
  (`handoffs/feature-wire-registry.md`)
- [ ] **§15.8** — Tool generation: each adapter contributes 7 tools
  with consistent naming `affiliate_<network>_<op>`
  (`handoffs/feature-wire-registry.md`)
- [ ] **§15.9** — Unpaid-age affordance: `ageDays` anchored on
  validation-date then transaction-date across all networks
  (`handoffs/feature-network-awin.md`,
  `handoffs/feature-network-cj.md`,
  `handoffs/feature-network-impact.md`,
  `handoffs/feature-network-rakuten.md`,
  `handoffs/feature-network-ebay.md`)
- [ ] **§15.10** — Reversed-sale visibility: `reversalReason` surfaced
  per network where the network provides it
  (`handoffs/feature-network-awin.md` and peers)
- [ ] **§15.20** — README structural acceptance (sections, generated
  table block, no marketing tokens)
  (`handoffs/feature-governance-2.md`,
  `tests/governance/readme.test.ts`)
- [ ] **§15.30** — Awin canonical reference: file-level + inline
  "why" comments naming the cardinal rules
  (`handoffs/feature-network-awin.md`)
- [ ] **§15.31** — Contribution test: a fifth network can be added by
  following AGENTS.md + contribute skill alone
  (`handoffs/feature-network-ebay.md`)

CI must be green on `main` before announcement. Run `gh run list -L 1`
to confirm.

## 2. Manual verification

These cannot be automated against real accounts in CI; the maintainer
runs them by hand.

- [ ] `git clone … && npm install` succeeds on a fresh checkout in a
      clean directory (Node ≥ 20).
- [ ] `npm run build` produces a working `dist/` (run
      `node dist/index.js --help`).
- [ ] `affiliate-mcp setup` runs interactively against ALL five
      networks with real credentials:
  - [ ] Awin
  - [ ] CJ Affiliate
  - [ ] eBay Partner Network
  - [ ] Impact
  - [ ] Rakuten Advertising
- [ ] `affiliate-mcp test` reports green on all five configured
      networks (or reports specific known limitations cleanly — no
      generic errors).
- [ ] `affiliate-mcp doctor awin` (and the equivalent per other
      networks) produces issue-paste-ready JSON: env paths resolved,
      config file mode `0600` confirmed, no secret values leaked.

## 3. Live API exercise — claim_status promotion

Each adapter currently ships at `partial` or (for eBay) `experimental`.
Promotion happens only after the live test passes.

- [ ] Awin: live-exercise all 6 supported ops. Bump
      `src/networks/awin/network.json` `claim_status` from `partial` to
      `production`. Bump `last_verified`.
- [ ] CJ Affiliate: same; promote to `production`.
- [ ] eBay Partner Network: first live smoke test promotes from
      `experimental` to `partial`. A full live test promotes to
      `production`. Bump `last_verified` at each step.
- [ ] Impact: live-exercise; promote to `production`.
- [ ] Rakuten Advertising: live-exercise; promote to `production`. If
      `listClicks` remains paid-tier-gated, leave the
      `NotImplementedError` in place and document in
      `docs/findings/rakuten.md`.
- [ ] Regenerate `REPORT.md` (`npm run generate:report`) and
      `README.md`'s table block (`npm run generate:readme`) after the
      promotions.

## 4. Docs

- [ ] Per-network setup docs have real screenshots replacing the
      `[SCREENSHOT: …]` placeholders. Place files under
      `docs/networks/images/<slug>/`. Required slugs: `awin`, `cj`,
      `ebay`, `impact`, `rakuten`.
- [ ] Per-network setup docs render correctly on GitHub (relative
      image links resolve).
- [ ] `CONTRIBUTING.md` accurate against the current PR template +
      contribute skill.
- [ ] `AGENTS.md` mentions all five networks (currently four — update
      the opening paragraph if it has not been updated already).
- [ ] `src/skills/affiliate-network-setup-help/SKILL.md` references
      all five network slugs (currently four — Chunk 13 does not touch
      this file; it is a follow-up).

## 5. Demo recording

Record the three videos using the scripts under
`docs/launch/demo-scripts/`. Render at 1080p; H.264 MP4 is fine.

- [ ] **Demo 01** (`01-wizard-in-action.md`, ~90s) — the setup wizard
      configuring Awin end to end.
- [ ] **Demo 02** (`02-setup-help-skill.md`, ~60s) — the
      `affiliate-network-setup-help` skill walking a user through CJ
      setup inside an MCP client.
- [ ] **Demo 03** (`03-claude-code-adds-a-network.md`, ~3min) — Claude
      Code adding the eBay adapter from a single prompt. This is the
      LinkedIn beat (PRD §14.6) — publish 48h after the launch post.
- [ ] All three videos uploaded to a stable host (GitHub releases or
      a personal-domain CDN). Embed-friendly URLs captured for the
      LinkedIn and registry submissions.

## 6. Comparison table image

The PNG renders the summary block of `REPORT.md` via Playwright.
Source: `scripts/generate-report-image.ts`. Output:
`docs/images/report-table.png`.

**Chunk 13 outcome**: the PNG was not rendered in the launch-prep
chunk because the sandbox blocks the Playwright browser-binary
download (Chromium CDN host is not on the allowlist; the npm package
itself installs cleanly). The HTML composition function is
unit-testable and unaffected.

- [ ] Render the PNG locally on a machine with Internet access:
      ```
      npm install --save-dev playwright
      npx playwright install chromium
      npm run generate:report-image
      ```
- [ ] Commit `docs/images/report-table.png`.
- [ ] Embed the image in the LinkedIn launch post and (optionally) at
      the top of `REPORT.md`.

## 7. Registry submissions

Submission text is pre-drafted under `docs/launch/submissions/`.
Do NOT submit before steps 1–4 above are green.

- [ ] **MCP Registry** — submit using
      `docs/launch/submissions/mcp-registry.md`. Repo URL, contact
      email, screenshots filled in at submission time.
- [ ] **Smithery** — submit using
      `docs/launch/submissions/smithery.md`. Category tag:
      `publisher tools` (fallback `data`).
- [ ] **Glama** — submit using `docs/launch/submissions/glama.md`.

Hold each submission once made; the registries' moderation queues run
on different cadences.

## 8. GitHub

- [ ] File the 14 pre-drafted issues under `.github/seed-issues/`
      using `.github/seed-issues/seed.sh`. Requires `gh` authenticated
      against the public repository.
- [ ] Confirm CI is green on `main` (no flakes in the last three
      runs). `gh run list --limit 5`.
- [ ] Confirm the issue templates and the PR template render correctly
      in the GitHub UI by opening (and immediately closing) one test
      issue and one test draft PR.
- [ ] Confirm CODEOWNERS resolves: every line lists a real GitHub
      handle. `gh api repos/{owner}/{repo}/collaborators` to verify.

## 9. External contact

- [ ] `CODE_OF_CONDUCT.md` — the contact email placeholder
      (`conduct@<placeholder>`) replaced with a real address. Test it
      receives mail.
- [ ] CODEOWNERS — every handle is a real GitHub user with access to
      the repository.
- [ ] Maintainer's public profile points at the repository (GitHub
      pinned repo, personal homepage, or LinkedIn featured section).
- [ ] LinkedIn post drafted in a private document and sat on for at
      least 48 hours before publishing. PRD §14.6 calls this out
      explicitly — the second beat (the Claude-Code-contributed
      story, demo 03) goes out at least 48 hours after the first.
- [ ] Reply paths agreed: GitHub issues for product, the conduct
      email for conduct matters. No other public channels at v0.1.

---

## Going / no-going

The launch is GO when every box above is ticked. If any single box is
unticked, the answer is NO-GO regardless of the rest of the checklist.

Order of operations on launch day:
1. Confirm CI green.
2. Tag the release locally (`git tag v0.1.0 && git push --tags`).
3. Publish to npm (`npm publish`).
4. Submit to the three registries in parallel.
5. File the 14 GitHub issues via `seed.sh`.
6. Publish the LinkedIn launch beat (demo 01 attached).
7. Forty-eight hours later: publish the LinkedIn contribution beat
   (demo 03 attached).
