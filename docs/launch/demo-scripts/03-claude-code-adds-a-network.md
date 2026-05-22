# Demo 03 — Claude Code adds a network (the LinkedIn beat)

**Target duration**: 3 minutes.
**Output**: a screen recording of Claude Code, opened in a fresh worktree of
`affiliate-mcp`, adding the eBay Partner Network adapter from a single
human prompt. This is the demo that surfaces the project's secondary
story — that a contribution-by-Claude workflow is a working part of the
repository, not a marketing line.

PRD §14.6 — this is the second LinkedIn beat. It runs after the launch
beat, no sooner than 48 hours later.

## Setup before recording

- A fresh checkout of `affiliate-mcp` on a clean branch (e.g.
  `git checkout -b demo/ebay-fresh`). The eBay adapter must NOT yet
  exist — for the recording, the maintainer reverts to a commit before
  `feature/network-ebay` was merged. (`git checkout 19d9bc3` against
  the orchestration branch reaches that state.)
- Claude Code installed, signed in, fresh session, no chat history
  visible.
- A terminal pane visible alongside the chat pane for the verification
  step.
- The repository's `.claude/skills/contribute/SKILL.md` and
  `AGENTS.md` already in place at that commit. (They are; this is the
  whole point of the demo.)
- No real eBay credentials. The demo runs against synthesised
  fixtures.

## Shot list

| # | T (s) | Action | On-screen content |
|---|------:|--------|-------------------|
|  1 |   0–5 | Title card: "Claude Code adds an affiliate-network adapter". Subtitle: "One prompt. No further human input." | (text card) |
|  2 |   5–12 | Cut to Claude Code, fresh session in the worktree. Show `git log --oneline -3` confirming eBay is not yet committed. | `19d9bc3 Structural build complete (chunks 1-12 merged); contribution test + launch prep next` |
|  3 |  12–22 | User prompt typed live: "Add eBay Partner Network to this project. No real creds; fixtures are fine. Use the same shape as Awin." | (chat input) |
|  4 |  22–35 | **Cut to highlight**: Claude opens `AGENTS.md` and `.claude/skills/contribute/SKILL.md`. Zoom 1.2× on the file-read tool calls in the side panel. | (tool-use feed) |
|  5 |  35–55 | Claude opens `src/networks/awin/adapter.ts` end-to-end as the reference. Show the scroll. This is the "read the reference implementation" step from the contribute skill, in action. | (file viewer) |
|  6 |  55–80 | Claude opens `templates/new-network/` and copies the scaffold to `src/networks/ebay/`. Show the `cp -r` (or equivalent tool call) in the side panel. | (tool-use feed) |
|  7 | 80–115 | **Cut to highlight**: Claude composing `src/networks/ebay/adapter.ts`. Speed up the typing 2× — but DO show the file taking shape. The viewer should see method signatures forming, the file-level comment header, the `mapTransactionStatus` helper, the registration call at the bottom. | (editor) |
|  8 | 115–135 | Claude writes `auth.ts`, `client.ts`, `setup.ts`, `network.json`. Quick montage; each file flashes for 2–3 seconds. | (editor) |
|  9 | 135–150 | Claude writes the unit tests + fixtures. The fixtures are synthesised from the documented EPN response shapes — Claude says so in the chat. | (editor) |
| 10 | 150–165 | Claude writes `docs/findings/ebay.md` and `docs/networks/ebay.md`. The findings doc is matter-of-fact, naming the "one advertiser" structural difference. | (editor) |
| 11 | 165–175 | Claude adds one line to `src/networks/index.ts`. **Cut to highlight**: the single-line diff (`+ import './ebay/adapter.js';`). Zoom 1.5×. | (diff view) |
| 12 | 175–185 | Cut to terminal. Run `npm run validate:network -- ebay`. **Cut to highlight**: the schema-pass + live-diagnostic outcome. | `✓ network.json schema valid` `✓ adapter registered` |
| 13 | 185–195 | Run `npm test`. Show the test count jump. The eBay test files run green. | `Tests  346 passed (346)` |
| 14 | 195–205 | Run `npm run typecheck && npm run lint`. Both clean. | (terminal output) |
| 15 | 205–215 | **Cut to highlight**: the chat pane. Claude's closing message: "Adapter added. Tests pass. Ready for live verification once real EPN credentials are available." | (chat) |
| 16 | 215–230 | Pull-out shot: the terminal next to the chat. The user has not typed anything since the original prompt at 12s. **No further human input**. Hold the frame. | (split-screen) |
| 17 | 230–240 | End card: "The repository's `AGENTS.md` and contribute skill turn one prompt into a working PR." | (text card) |

## Voiceover (≈360 words)

> `affiliate-mcp` is built to be contributed to. Adding a new
> affiliate network is a structured task: copy a template, mirror the
> reference implementation, run the validator, open a pull request.
> The whole thing is documented in `AGENTS.md` at the repository
> root and in a project-local Claude Code skill under
> `.claude/skills/contribute/`.
>
> Here is what that looks like when Claude Code is the contributor.
>
> A fresh worktree. No eBay adapter yet. One prompt: add eBay
> Partner Network to this project, fixtures are fine.
>
> Claude opens `AGENTS.md` first. It reads the editorial-tone note,
> the file layout, the conventions, the "what not to do" list. Then
> it loads the contribute skill — the project-local instructions for
> exactly this task.
>
> The skill points Claude at the Awin adapter. Claude reads Awin end
> to end. Awin is the canonical reference: the file-level comment
> names the cardinal rules, the helpers are named for what they do,
> the `_internals` export pattern is documented. Claude follows the
> pattern.
>
> Now the work. Claude copies the template, then composes the eBay
> adapter file by file. The auth module — eBay uses OAuth2 client
> credentials, a token-cache mirroring Rakuten's. The client — a
> single sanctioned `fetch` path through the shared resilience
> wrapper. The setup wizard — three steps, with verbatim dashboard
> labels. The network manifest. The unit tests, with synthesised
> fixtures that Claude flags openly: no real account; live
> verification is still required.
>
> One line is added to the network aggregator. That import is what
> registers the adapter at startup.
>
> The validator runs. The schema is valid. The live diagnostic
> reports `config_error` envelopes — expected, no real credentials.
>
> The test suite goes from 301 tests to 346. Forty-five new tests
> for the eBay adapter, all green. Typecheck clean. Lint clean.
>
> No further human input. The user typed one prompt and watched.
>
> `affiliate-mcp` is MIT-licensed and on GitHub. The contribute
> skill ships with it. Anyone — human or Claude — can add a network
> by following the same path.

## Cuts to highlight

- Frame 22–35: Claude reading `AGENTS.md` first. The viewer must
  understand that the project has instructions for AI agents and
  Claude is following them.
- Frame 35–55: Claude reading Awin. The "read the reference"
  step is visible. This is the structural integrity of the
  contribute workflow on camera.
- Frame 165–175: the single-line `index.ts` edit. The
  registration-by-import pattern. Five seconds is enough.
- Frame 195–205: the typecheck + lint clean. Quality bars are
  visibly green.
- Frame 215–230: the "no further human input" pull-out. The user's
  hands are off the keyboard. Hold for ten seconds. Optional caption:
  "From `Send` at 0:12 to `npm test` green at 3:13 — no further
  prompts."

## What to NOT show

- Real eBay credentials. The demo runs on synthesised fixtures.
- The maintainer's personal Claude Code chat history (start a new
  session).
- Other projects in the file tree sidebar.

## Post-production notes

- Speed-ups on the file-composition shots are fine (2×–3×); the
  validator + test-run shots must run at real time so the green
  ticks are visibly earned.
- Subtitles burn-in.
- End card: repository URL, "MIT licensed. Contribute via
  `AGENTS.md` and `.claude/skills/contribute/`."
- This is the LinkedIn post the maintainer publishes 48h after the
  launch beat. The launch beat itself does not need this demo.
