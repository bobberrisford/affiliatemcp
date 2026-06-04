# LinkedIn posts — weeks 1–2

Eight ready-to-post drafts, grounded in what's actually open on the repo
right now (PRs and issues as of June 2026, against v0.5.0). They follow
[`linkedin-content-plan.md`](./linkedin-content-plan.md): links go in the
**first comment** (not the body), every post ends with a real question,
videos are captioned, and the maintainer's personal profile is the
primary channel.

Cadence: 4 posts/week, Tue–Fri, posted mid-morning UK time. Reply to
comments within the first 90 minutes.

Each draft lists: **day · pillar · format · audience**, the post body,
the first-comment link, and a visual suggestion. Copy is UK English.
Numbers (test counts etc.) are pulled from the live PRs — re-check before
posting in case they've moved.

---

## Week 1

### Post 1 — Tue · Point of view · text · publishers + network staff

> Source: PR #5 (API-gap + browser-handoff primitive)

**Body:**

Most tools lie to you when they hit a wall.

You ask an affiliate integration to apply to a programme, and it returns
"not supported" — so the AI on top of it tells you the network is broken.
It isn't. The network's *API* just doesn't expose that action. It only
lives in the dashboard.

We decided affiliate-mcp should say exactly that, in plain English, and
then offer a hand instead of a wall:

"Impact's API doesn't support applying to programmes — that flow only
exists in their publisher portal. I can try to drive it with a browser
agent in your own logged-in session instead. I'll show you what's about
to be submitted before anything is clicked. Want me to try?"

Three things we made non-negotiable in how that message reads:

→ Name the limit factually. "X's API doesn't do Y" — never "this isn't
supported" (sounds like our bug) and never "X won't let you" (sounds like
blame).

→ It's the user's own authenticated browser. We never store credentials,
never automate a login, never touch a captcha.

→ It always ends in a question. You opt in, every time.

Honesty about what a network can't do turns out to be a feature, not an
apology. It's the difference between a tool you trust with your data and
one you quietly stop believing.

Where's the line for you — would you let an AI agent drive your own
browser session if it showed you every action first?

**First comment:** The design RFC for this (the "API gap" primitive) is
open on GitHub — repo link + the six phrasing rules here: [repo URL]

**Visual:** single clean image of the verbatim user-facing message in a
chat bubble, monospace, high contrast.

---

### Post 2 — Wed · Build in public · text (dev-leaning) · MCP/dev + contributors

> Source: PR #50 (`call` CLI command)

**Body:**

Shipping a small thing this week that I think is quietly the most useful
developer feature we've added.

affiliate-mcp is a Model Context Protocol server — Claude, Codex and now
Copilot talk to it to query affiliate networks. But until now, the only
way to *run* a single network operation was through an AI client. Great
for users, slow for debugging an adapter.

So: a `call` command that runs any operation straight from the terminal.

    affiliate-networks-mcp call awin list_transactions from=2026-01-01 limit=50
    affiliate-networks-mcp call cj generate_tracking_link programmeId=12345 ...

The part I'm happy with: it's a thin shell over the *same* tool registry
that backs the MCP server. One code path. No per-network CLI code — every
one of the 17 adapters is covered automatically, and so is the next one
anyone adds.

A real bug fell out of building it. Blindly JSON-parsing `key=value` args
turned a string merchant id ("12345") into a number and failed schema
validation. The fix: coerce each value to the type the tool's own schema
declares — numbers convert, numeric-looking ids stay strings, arrays
accept a comma list. The downstream validator stays the source of truth.

13 new tests, full suite green (1,147 passing).

If you build MCP servers: are you giving yourself a non-AI way to exercise
your tools? It caught things an AI client would have papered over.

**First comment:** PR is open for review — code + examples here: [repo URL]

**Visual:** 20–30s screen capture (captioned) of running two `call`
commands and getting JSON back instantly.

---

### Post 3 — Thu · Build in public · text · MCP/dev + publishers

> Source: PR #49 (GitHub Copilot / VS Code install target)

**Body:**

affiliate-mcp now installs into GitHub Copilot in VS Code.

    npx affiliate-networks-mcp install --copilot

That makes four clients it speaks to: Claude Desktop, Claude Code, Codex,
and now Copilot's agent mode. Same local server, same bring-your-own-keys
stance — your credentials never leave your machine, whichever client you
point at it.

One implementation note for anyone wiring MCP into multiple editors,
because it wasn't obvious. Our Claude Code installer uses the `claude mcp`
CLI. The natural move was to use `code --add-mcp` for VS Code the same
way. But that command only *adds* — there's no remove, no dry-run, no
idempotency. Our contract requires every install target to support
symmetric uninstall, `--dry-run`, backups and conflict detection. A
CLI-only path can't back any of that.

So Copilot support edits `mcp.json` directly — timestamped backup,
atomic write, conflict prompt, malformed-file guard — exactly like the
Claude Desktop module. Boring, uniform, fully testable without launching
the editor. 1,167 tests green.

The lesson I keep relearning: "use the official CLI" is only the right
call when the CLI covers the whole lifecycle. Half a lifecycle is worse
than none.

Which client should we support next — Cursor? Zed? Something else?

**First comment:** PR + the install docs for all four clients here: [repo URL]

**Visual:** carousel, 4 slides — one per supported client logo +
one-line install command.

---

### Post 4 — Fri · Point of view · text · affiliate-network staff

> Source: issues #37–#47 (adopt-this-network campaign)

**Body:**

If you work at an affiliate network, there's a piece of code with your
network's name on it that you've never seen.

affiliate-mcp ships adapters for Awin, CJ, Impact, Rakuten, eBay,
Partnerize, Tradedoubler, Everflow, Skimlinks, Sovrn and mrge. Every one
was built by reading your public docs and making careful guesses. Some
are solid. Some have honest `TODO(verify)` markers in the source where
your docs were ambiguous — CJ's `actionStatus` values, Impact's async
report endpoints, whether Sovrn ever returns a transaction status field
at all.

Here's the thing: operators are already asking Claude, Codex and ChatGPT
about your network's data. The adapter is the answer they get. Right now
that answer is a community best-guess.

You can own it instead. Adoption is small — seven canonical operations,
two scrubbed fixtures each, a setup doc, your name in CODEOWNERS.
Roughly one to two engineer-days. In return, the canonical way AI tools
read your API is written by the people who built the API.

There's an open "adopt-this-network" issue for each network. They're
addressed to you.

Networks: would you rather the AI-readable version of your API was
written by you, or guessed by someone else?

**First comment:** The adopt-this-network issues (one per network) are
here: [repo URL]/issues?q=label:adopt-this-network

**Visual:** single image — the network table from the README with a
"community best-guess → adopted by the network" arrow.

---

## Week 2

### Post 5 — Tue · Teach the workflow · carousel · publishers + brands

> Source: PR #52 (cross-network normalisation fields)

**Body (carousel caption):**

"Is the merchant I'm promoting on Awin the *same* merchant I see on CJ?"

Sounds trivial. It's one of the hardest questions in cross-network
affiliate reporting — because every network names the same brand
differently ("Acme" vs "Acme Inc."), and the moment you normalise their
data you usually throw away the detail that would let you tell.

This week's foundation work in affiliate-mcp is about *not* throwing it
away. Swipe through 👉

Where do you lose the most time today — reconciling merchant names across
networks, or reconciling statuses?

**Slides:**

1. **"Is Acme on Awin the same Acme on CJ?"** The cross-network identity
   problem, one line.
2. **The trap:** normalising 5 networks into one clean schema usually
   means deleting what made them distinguishable.
3. **Fix 1 — keep the raw status.** Impact's `LOCKED` (approved and
   irreversible) used to collapse into a generic "other". Now we keep the
   verbatim upstream token alongside the canonical one. Nothing is lost.
4. **Fix 2 — a stable merchant key.** A cross-network identity so "Acme"
   and "Acme Inc." resolve to the same brand — and we record *how* we
   matched it (resolver, domain, name, or not at all). Honest provenance.
5. **Fix 3 — timezone metadata.** "Awin reports in London time" is now a
   property of the network, not a guess baked into every report.
6. **Why it matters:** these are what let one question ("how's this brand
   doing across every network?") actually fan out correctly.
7. **The discipline:** every field is additive and optional. No breaking
   change for anyone already building on it. Foundations first, features
   next.
8. **affiliate-mcp · open source · local-first · MIT** — link in comments.

**First comment:** The schema PR (and why each field is shaped the way it
is) here: [repo URL]

**Visual:** clean 8-slide carousel, one idea per slide, monospace for
field names.

---

### Post 6 — Wed · Point of view · text · brands/agencies + all

> Source: PR #23 (the doing layer — consent, audit, guarded actions)

**Body:**

The scariest sentence in AI tooling is "and then it acts on your behalf."

affiliate-mcp has been read-only on purpose. It answers questions about
your affiliate data; a human does anything that changes something. That's
been the right default and it stays the default.

But the question keeps coming: can it *do* the next step too — apply to a
programme, follow up with a publisher? So I've been designing the "doing
layer", and the interesting part isn't the actions. It's the brakes.

What it looks like, all of it default-off:

→ **Consent, not vibes.** An action with no standing permission stops and
asks — with a single-use, short-lived token bound to that exact action.
You confirm the specific thing, not a vague "allow AI to act".

→ **Bounded standing grants.** If you do want it to skip the prompt, the
grant is scoped: this brand, this action class, expires on a date, capped
per day, capped by magnitude. "Deny" always wins over "allow".

→ **An append-only audit trail.** Every action: proposed → applied →
succeeded/failed, or denied. Written to a log you own, locally. If you
can't explain after the fact what an agent did and why it was allowed,
it shouldn't have done it.

→ **Fails closed.** Can't read the consent file? It prompts. Never the
other way round.

I'd rather ship the guardrails before the gun. The actions are easy; the
question of how an automated system *earns* the right to act, and proves
it afterwards, is the whole job.

If you manage affiliate programmes: what's the first action you'd
actually trust an AI to take — and what would it have to show you first?

**First comment:** The full design (consent model, audit trail,
graduated trust) is an open RFC here: [repo URL]

**Visual:** single image — the consent flow as 4 boxes: action → no grant
→ confirm token → audited. Or "deny wins" highlighted.

---

### Post 7 — Thu · Build in public + community · text · contributors

> Source: issues #35, #36 (good-first-PR) + PR #6 (caching)

**Body:**

Two ways to make your first open-source contribution this week, both
under an evening's work.

affiliate-mcp is MIT, local-first, and built so a first PR shouldn't take
longer than one sitting. `npm run verify` runs the whole pre-PR check —
typecheck, lint, tests, build — in a few seconds. If it's green locally,
CI is green.

Two issues waiting that don't even need a network account:

→ **Fail fast on old Node.** We declare Node 20+ but npm only warns, so
people on Node 18 hit a cryptic crash mid-install. The fix is a ~40-line
preinstall check with one clear message. Labelled good-first-pr.

→ **Resolve the CJ status mapping.** Six `TODO(verify)` markers about how
CJ's `actionStatus` values map to our canonical statuses. CJ's docs use
"CLOSED" in more than one sense. This one is pure research + a small
surgical edit — read the public docs, confirm or correct the mapping,
cite your sources. High signal for anyone evaluating the code.

And under the hood this week, a contributor-friendly performance change
landed for review: an on-disk cache so a repeat query for a closed past
window returns instantly instead of hitting the network again — wrapped
at a single dispatcher seam so it covers all 17 adapters at once, no
per-adapter code. The kind of change one good seam makes trivial.

If you've been meaning to make a first OSS contribution: what's stopped
you so far — finding a scoped issue, or the setup friction? We tried hard
to remove both.

**First comment:** Both issues + the contributing guide here: [repo
URL]/issues?q=label:good-first-pr

**Visual:** carousel, 3 slides — "Issue 1: Node check", "Issue 2: CJ
status mapping", "Run `npm run verify`, open a PR".

---

### Post 8 — Fri · Roadmap / point of view · text · brands/agencies

> Source: issue #25 (ChatGPT support) + PR #19 (recording client strategy)

**Body:**

Two things on the affiliate-mcp roadmap that point at the same idea: the
tool should meet you where your work already is.

**1. ChatGPT support.** Today affiliate-mcp runs in Claude, Codex and
Copilot. The plan for ChatGPT keeps the local-first stance intact —
your machine runs the server, your credentials never leave it, and only
the tool-call JSON transits an encrypted tunnel. No hosted account, no
data handed over. The honest catch (written into the plan, not hidden):
quick-tunnel URLs rotate on reboot, so you'd repaste a URL once after a
restart until the v2 stable-tunnel option lands. Shipping the rough-but-
real version beats shipping nothing.

**2. Client strategy that the reports can read.** Right now anomaly scans
flag generic deltas — "revenue down 12% week on week". Useful, but it
doesn't know that for *this* client, a 12% dip in January is expected and
the thing to escalate is reversal rate. The proposal: each client gets a
plain-markdown `Strategy.md` and `KPI.md` you maintain just by chatting,
stored locally, keyed to the brand. Then the reports judge actuals
against that client's actual intent — not a one-size delta.

The thread connecting both: affiliate operators shouldn't have to learn a
new dashboard or hand their data to a SaaS to get AI-native reporting.
The data and the intent stay yours and local; the AI client is just the
surface you already use.

Agency folks — when a report flags "down 12%", how much of your job is
knowing whether that 12% actually matters for *that* client? That
context is what I want to make legible.

**First comment:** The ChatGPT execution plan and the client-strategy
design note are both open on GitHub here: [repo URL]

**Visual:** single image — two columns, "Where you work (Claude · Codex ·
Copilot · ChatGPT)" and "What stays yours (keys · data · client intent,
all local)".

---

## Posting checklist (per post)

- [ ] Replace `[repo URL]` with the canonical GitHub link in the **first
      comment**, not the body.
- [ ] Re-check any test counts / version numbers against the live PR.
- [ ] First line is the hook — confirm it stands alone before "see more".
- [ ] Caption any video; design carousels one idea per slide.
- [ ] Post Tue–Fri mid-morning UK; reply to comments in the first 90 min.
- [ ] Log it in the tracking sheet (date, pillar, format, saves, comments,
      link clicks).

## Pillar / audience spread (sanity check)

| # | Day | Pillar | Audience | Source |
|---|-----|--------|----------|--------|
| 1 | W1 Tue | POV | Publishers + networks | PR #5 |
| 2 | W1 Wed | Build in public | Dev / contributors | PR #50 |
| 3 | W1 Thu | Build in public | Dev + publishers | PR #49 |
| 4 | W1 Fri | POV | Network staff | Issues #37–47 |
| 5 | W2 Tue | Teach | Publishers + brands | PR #52 |
| 6 | W2 Wed | POV | Brands/agencies + all | PR #23 |
| 7 | W2 Thu | Build in public + community | Contributors | Issues #35/#36, PR #6 |
| 8 | W2 Fri | Roadmap / POV | Brands/agencies | Issue #25, PR #19 |

All five pillars represented, every audience hit at least once, no two
consecutive posts aimed at the same group.
