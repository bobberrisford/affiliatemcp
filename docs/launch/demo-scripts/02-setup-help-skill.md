# Demo 02 — the setup-help skill in conversation

**Target duration**: 60 seconds.
**Output**: a screen recording of an MCP-capable client (Claude Desktop
preferred; Claude Code is the fallback if Desktop is awkward to record
on the maintainer's host) walking a user through CJ Affiliate setup
using the `affiliate-network-setup-help` skill.

The point of this demo is to show that once the server is configured,
the publisher does not have to remember tool names — the skill loads
and walks the conversation.

## Setup before recording

- Claude Desktop with `affiliate-mcp` configured as an MCP server in
  `claude_desktop_config.json` (the worked example is at
  `examples/claude-desktop-config.json` in the repo).
- The maintainer's Awin credentials already configured (so
  `affiliate_list_networks` shows at least one network). The CJ
  credentials are NOT yet configured — that is the journey we are
  recording.
- Claude Desktop restarted so the MCP server is loaded.
- Window large enough that the conversation pane reads at distance.
  Hide the sidebar if it has personal data.
- A clean conversation (new chat). No system prompt overrides.

## Shot list

| # | T (s) | Action | On-screen content |
|---|------:|--------|-------------------|
| 1 | 0–4 | Title card: "affiliate-mcp + Claude Desktop — setup help". | (text card) |
| 2 | 4–8 | Cut to Claude Desktop. New chat. Show the bottom-bar MCP indicator with `affiliate-mcp` listed. | (UI) |
| 3 | 8–14 | Type a natural-language request. | "Help me set up CJ Affiliate. I have an account but no API access yet." |
| 4 | 14–24 | Send. **Cut to highlight**: the skill banner / tool-use indicator showing the `affiliate-network-setup-help` skill triggering. Zoom 1.4×. | (UI banner) |
| 5 | 24–38 | Claude reads `docs/networks/cj.md` (the tool call is visible in the side panel), then replies with the dashboard path: Account → Personal Access Tokens, click "Generate". Quote the doc, do not paraphrase. | (chat reply) |
| 6 | 38–46 | User asks the follow-up: "Where's the company ID?" | (chat) |
| 7 | 46–54 | Claude explains the company ID is read from the token's `me` query and the wizard derives it automatically — no separate lookup needed. **Cut to highlight**: the line "the setup wizard will derive `CJ_COMPANY_ID` from your token". | (chat reply) |
| 8 | 54–58 | Final reply: Claude offers to run `affiliate-mcp setup cj` for the user; user declines (this is a documentation demo, not a setup demo). | (chat) |
| 9 | 58–60 | End card: "Skill files under `src/skills/`. The user does not write any tool calls by hand." | (text card) |

## Voiceover (≈120 words)

> Once you have configured `affiliate-mcp` as an MCP server in Claude
> Desktop, you do not have to remember any tool names. A bundled
> skill called `affiliate-network-setup-help` triggers whenever the
> conversation mentions a network setup.
>
> Here the user types a natural-language request for help with CJ
> Affiliate. The skill loads. Claude reads the per-network setup doc
> from the repository — `docs/networks/cj.md` — and quotes the
> dashboard path verbatim. Account, Personal Access Tokens, Generate.
>
> The follow-up: where's the company ID? The skill knows the answer.
> The setup wizard derives `CJ_COMPANY_ID` from the token's `me`
> query. The user does not have to look it up.
>
> Five networks, four bundled skills. The skills walk the
> conversation; the user never sees a tool name.

## Cuts to highlight

- Frame 14–24: the skill-triggered banner. Different clients render
  this differently; whichever your client uses, hold the frame so the
  viewer can see "affiliate-network-setup-help" by name. This is the
  point of the demo.
- Frame 46–54: the "derived `CJ_COMPANY_ID`" line. This is the
  cross-credential derivation property — load-bearing for the
  wizard's ergonomics.

## Fallback if Claude Desktop is awkward to record

- Use Claude Code in the project's worktree instead. The skill is the
  same; the conversation surface looks slightly different.
- If using Claude Code, ensure `.claude/skills/contribute/` does NOT
  trigger first (the contribute skill loads automatically inside the
  repo). Open the chat in a non-repo directory, or pin the
  setup-help skill manually.

## What to NOT show

- The maintainer's real CJ token.
- Other Claude Desktop conversations or MCP servers in the sidebar.
- File-tree views containing other projects.

## Post-production notes

- No music. The keyboard typing sound is fine.
- Subtitles burn-in.
- End card mirrors demo 01: repository URL, "MIT licensed. No
  telemetry."
