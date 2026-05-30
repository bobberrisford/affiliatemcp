# The doing layer: browser and non-API surfaces

This is the Phase 0 design for acting on network surfaces that have no public
API: the dashboard itself, emailed reports, and exported files. It is a
companion to `doing-layer.md`, which covers the consent and audit model that
this builds on. Nothing here is shipped behaviour yet.

It records the decisions taken so far:

1. **Browser automation is first-class, not forbidden.** The product boundary
   has been revised (see `AGENTS.md` and `manifesto.md`). Where a network
   exposes no API for a task, the doing layer drives the dashboard the user is
   already authorised to use.
2. **Local-first, human-supervised.** This runs on the user's machine, on
   demand. No always-on service, no hosted browser fleet, no scheduler. Sessions
   and credentials never leave the user's host.
3. **Two tiers, extension first.** Tier A uses the Claude in Chrome extension,
   driven by per-network browser skills. Tier B, a self-driven Playwright
   subsystem, is deferred until Tier A's limits actually bite.

## Tier A: Claude in Chrome (the path we build first)

The Claude in Chrome extension lets Claude read, click, and navigate pages in
the user's own browser. Claude Code connects to it (`claude --chrome` or
`/chrome`) and exposes the browser actions as an MCP server named
`claude-in-chrome`. References: [Claude Code + Chrome][cc-chrome],
[Get started with Claude in Chrome][cic-start],
[Piloting Claude in Chrome][cic-news].

Three properties of the extension shape the whole design.

- **It uses the user's existing login.** Claude opens tabs that share the
  browser's login state, so it can act on any site the user is already signed
  into. This removes the entire "store the login" problem: no session vault, no
  captured cookies, no encrypted credential store. The user is already
  authenticated as themselves.
- **Login and captcha are handed back to the human.** When the extension hits a
  login page or captcha, it pauses and asks the user to handle it. Assisted
  re-auth is native, not something we build.
- **Permissions and evidence are built in.** Site-level permissions are managed
  in the extension settings, a per-site gate. The extension can record an
  interaction as a GIF, which feeds the audit trail directly.

### How our server and the extension relate

`affiliate-mcp` is an MCP server. `claude-in-chrome` is a separate MCP server
that the same Claude client loads. Claude orchestrates both at once: our tools
read data through the network APIs, and `claude-in-chrome` drives the dashboard
for the actions that have no API. Our server never calls the extension. Claude
sits above both. This means most of the "browser subsystem" does not live in our
codebase at all; it lives in the extension, and we supply the per-network
know-how as skills.

### Network browser skills are the unit of work

Skills are already this repo's unit of workflow, so the per-network dashboard
flows are skills, not a code subsystem. A skill encodes, for one network and one
action class, how to do the thing through the `claude-in-chrome` tools:

- where to navigate, what to click, what to type;
- what the success state looks like, and how to read it back to confirm;
- the known failure and ambiguity cases for that dashboard;
- the consent and audit steps from `doing-layer.md`.

"Consistency" in Tier A comes from well-written skills plus the agent's ability
to adapt to small layout changes, not from externalised CSS selectors. That is
both the strength (resilient to minor DOM drift) and the weakness (less
deterministic than codified selectors) of this tier.

### Verification still rules: never invent success

Principle 4.1 is harder in a browser and matters more. A click that silently
does nothing must never be reported as done. Every browser skill ends by
instructing Claude to re-read the page and confirm the state actually changed,
and to capture evidence (a screenshot or the extension's GIF recording). A skill
that cannot confirm its effect reports that plainly; it never assumes success.
This is a weaker guarantee than a code assertion, which is acceptable because
Tier A is human-supervised.

### Honest limits of Tier A

- **Less deterministic, harder to test.** Agentic, skill-driven browsing cannot
  be fixture-tested the way codified flows can. We test the skill text and the
  read-back verification logic, not pixel-exact interactions.
- **Not built for unattended scale.** The extension is a visible, single browser
  and its service worker idles on long sessions, dropping the connection. It
  suits on-demand batches, which is the local-first model we chose, not a
  scheduled fleet.
- **Claude-client-only.** It works when the client is Claude or Claude Code, not
  on other MCP clients the project supports (ChatGPT, Cursor, and others). Our
  API tools stay portable; the browser-doing path is Claude-specific.
- **Beta and plan-gated.** Chrome and Edge only, no WSL, and a direct Anthropic
  paid plan (Pro, Max, Team, or Enterprise). Document this as a prerequisite of
  the browser skills.

## Tier B: a Playwright subsystem (deferred)

Build this only when Tier A's limits actually constrain real use: when you need
unattended or scheduled flows, deterministic and fixture-tested interactions, or
a browser-doing path that works on non-Claude MCP clients.

Tier B is the self-driven model from the earlier draft of this doc:

- A `BrowserAdapter` per network, registered like `NetworkAdapter`, with a
  shared `login` / `isLoggedIn` / named-flow interface.
- Playwright as the driver, with externalised resilient selectors and a drift
  canary that asserts known anchors before a batch.
- An encrypted local session store (cookies and local storage, OS-keychain
  master key) with assisted re-auth, because Tier B does not piggyback on a live
  human browser the way Tier A does.

Tier B reintroduces the heavy Playwright dependency and the credential-handling
burden that Tier A avoids. That cost is the reason it is deferred, not adopted
up front. `AGENTS.md` guards dependency additions, so Tier B needs an explicit
decision and an issue before any code.

## Emails and reports

Independent of tier, do not drive a browser when a cheaper path exists.

- **Reports by email.** Where a network emails scheduled reports, fetch and
  parse them through an email integration. Most stable; no session to maintain.
- **Reports only in-dashboard.** In Tier A, a browser skill triggers the export
  and saves the file; in Tier B, the adapter does. Either way the file is
  normalised into the existing typed contracts (`Transaction`,
  `ProgrammePerformanceRow`). The browser is transport, not a parallel data
  model.
- **Email as an action surface.** Acting on a link in a network notification is
  possible, but treat email content as untrusted input and route any resulting
  action through the consent, verify, and audit gates.

## How this maps to the consent layer

Everything in `doing-layer.md` applies, with the risk dial turned up:

- **Action classes** are the same across transports. `publisher.approve` might
  be an API write on one network and a browser skill on another; the class, the
  consent check, and the audit entry are identical.
- **Plan and apply.** A browser skill can navigate and preview without
  submitting (`plan`), then submit and verify (`apply`).
- **Standing consent** can let a supervised run skip prompts within bounds, but
  bounds matter more here. The audit record gains screenshots or the extension's
  GIF recording as evidence.
- **Permissions from a client.** With Tier A this means the operator runs a
  supervised browser session under their own login on the client's behalf; the
  client must understand that automation, not a person, is acting. Tier B, with
  a stored session, raises that bar further.

## Phasing

- **Phase 0 (this note and the boundary revision).** Decide and document.
- **Phase 1.** One network browser skill via Tier A, end to end: connect the
  extension, perform one verified action on one dashboard with read-back
  confirmation, capture evidence, and apply the consent and audit gates. Treated
  as `experimental` until proven against a real account.
- **Phase 2.** A second network and a second action class, proving the
  skill-and-verification model generalises before any broad abstraction.
- **Phase 3.** Revisit Tier B only if Phase 1 and 2 expose a real need for
  unattended scale, determinism, or non-Claude portability.

## Open questions

- How a browser skill cleanly surfaces the extension's "please log in" handoff
  to the user mid-flow.
- Per-network Terms of Service notes: where they live and how the user
  acknowledges the automated-access risk before running a browser skill.
- Screenshot and GIF evidence: retention and redaction in the audit log.
- Whether any high-frequency action justifies an early Tier B exception rather
  than waiting for Phase 3.

[cc-chrome]: https://code.claude.com/docs/en/chrome
[cic-start]: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
[cic-news]: https://www.anthropic.com/news/claude-for-chrome
