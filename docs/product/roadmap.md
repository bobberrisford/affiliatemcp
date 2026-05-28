# Roadmap

> A list of things `affiliate-mcp` does not yet do, in the order we
> think they matter. UK English throughout. Dates are intent, not
> commitment — we'll publish what ships when it ships.

The shape of the roadmap is two questions:

1. **Can someone get this running in five minutes without help?**
2. **Once it's running, does it cover what an affiliate manager
   actually does on a Monday morning?**

Everything below sits under one of those headings. Where we have
already shipped something, we say so and point at the existing
skill or doc. Where we have not, we describe the gap honestly.

The state of the underlying network adapters lives in
[`REPORT.md`](../../REPORT.md). The architectural rationale and the
network-by-network priorities live in
[`ai-native-affiliate-data.md`](./ai-native-affiliate-data.md). This
file is the product view across both.

## Where we are today (v0.1, late May 2026)

Five networks ship as publisher adapters; three of them also ship as
brand-side (advertiser) adapters. Eight skills cover the
highest-frequency workflows — earnings reports, link audits,
programme performance, portfolio rollups, anomaly watch. Setup is a
single `npx affiliate-networks-mcp setup` command followed by a
Claude Desktop config edit. Credentials live in
`~/.affiliate-mcp/.env`, locked to the user account, never leave the
machine.

All publisher adapters ship at `claim_status: partial` (implemented
and unit-tested, not yet exercised against a live account). All
brand-side adapters ship at `experimental`. Promoting any of them
to `production` is a 2026-Q3 goal contingent on live acceptance
tests against real accounts.

## Onboarding: get someone running in five minutes, no help required

### The friction we know about

A first-time user today has to:

1. Install Node 20+ if they don't have it.
2. Open a terminal, paste an `npx` command.
3. Find their API token in each network dashboard.
4. Find Claude Desktop's config file on their operating system, open
   it in a text editor, paste a JSON block, restart Claude.
5. Type "list my affiliate networks" to confirm the wiring.

Of those, the only step that is genuinely network-specific (and
therefore unavoidable) is step 3. Steps 2, 4, and 5 are friction we
control. A non-technical affiliate manager — the persona we built
this for — should not need to know what Node is, what a terminal is,
or what JSON looks like.

### Now (next 6 weeks)

- **`affiliate-networks-mcp install`** — a single command that writes the
  Claude Desktop config in place rather than asking the user to.
  Detects which IDEs/desktop clients are installed (Claude Desktop,
  Claude Code, Cursor, Codex, VS Code with MCP), offers to wire each
  one up, and prints the exact line to type into Claude as the
  confirmation step. The wizard currently leaves step 4 to the user;
  this folds it in.
- **`doctor` self-fix**. When the diagnostic finds a fixable problem
  (trailing whitespace in a token, an expired bearer, a missing
  `EBAY_MARKETPLACE_ID` override on a US account), it offers to fix
  it inline instead of describing the fix and exiting. The
  diagnostic engine already knows the shape of every failure; the
  remaining work is the prompt-and-rewrite path.
- **Per-network "did you mean…" credential hints.** The most common
  setup failure is pasting the wrong field from the network
  dashboard — the Account SID into the Auth Token slot on Impact,
  the username instead of the company ID on CJ. The wizard already
  validates against the live network; the next step is to recognise
  the *shape* of each common mispaste and say so ("that looks like
  an Impact Account SID, not the Auth Token — try the field
  immediately below it").

### Next (6–12 weeks)

- **MCPB / `.dxt` bundle.** The Node-install step is the single
  biggest non-affiliate barrier. Packaging the server as an MCP
  bundle (per the MCP project's deployment guidance) collapses
  install to a double-click. The bundle still writes to
  `~/.affiliate-mcp/.env` for credential storage; no behavioural
  change beyond install.
- **OAuth flows where the network supports them.** Three of the five
  networks (Awin, Impact, eBay) require a token paste today even
  though their dashboards support an OAuth handshake. Adding the
  OAuth path means a user clicks "Connect Awin", lands on the Awin
  login page in their browser, approves the scope, and lands back in
  the wizard with the token already saved. CJ and Rakuten do not
  expose OAuth for the public publisher API; they stay paste-only.
  Brand-side Awin already uses OAuth — that's the reference for
  this work.
- **Brand auto-discovery during setup.** On the brand side, the
  wizard already calls `listBrands` on each advertiser network and
  offers the discovered set for nicknaming. The next iteration
  pre-fills sensible nicknames (the brand's display name, lowercased
  and slugified) and lets the user keep / rename / skip in one
  pass. Empty for the publisher-only path.

### Later (Q3 2026 and beyond)

- **Cloud / mobile path for the truly non-technical user.** A
  managed Streamable-HTTP MCP endpoint, OAuth in, no local install.
  Local-first stays the default and the privacy-preserving baseline;
  this is the path for an agency operator who wants to ask
  questions from their phone between meetings. The trade-off
  (credentials on a hosted service vs. on the user's machine) is
  explicit at signup and reversible by deleting the account.
- **Embedded setup inside Claude Desktop itself.** When MCP gains a
  first-class "add a server" UI, we want the affiliate-mcp listing
  to be the first one a user can install without leaving the chat
  window. This depends on Anthropic's roadmap, not ours.

## Daily questions: cover the long tail of what an affiliate manager actually does

We started with the questions we were sure mattered (earnings, link
audit, portfolio rollup). The next step is to cover the long tail —
the questions that an affiliate manager asks every Monday but that
the network dashboards make awkward.

### Publisher side — what we don't yet cover well

A working list, in rough order of how often the question comes up:

- **"Where are my payments?"** Each network publishes a payment
  schedule (Awin: 1st and 15th, Net-30 on validated commissions;
  CJ: 20th of the month, Net-20; Impact: bi-weekly; Rakuten:
  monthly; eBay: monthly). Today you have to know each. We want
  *"when am I getting paid next, by who, for how much?"* to answer
  in a single response across every network — pull the approved-
  but-unpaid pool per network, apply the network's payout policy,
  surface the date and amount. This is the **`upcoming-payouts`**
  skill, scheduled for Q3.
- **"Why was this transaction reversed?"** Reversal reasons live
  in `rawNetworkData` today; the earnings report flags them but
  doesn't drill in. A **`reversal-investigator`** skill takes a
  transaction ID, fetches the full record, explains the reason in
  English, and (where the network exposes it) compares against the
  publisher's historical reversal rate for that programme.
- **"Generate me a tracking link"** is technically possible via
  raw tool calls today, but there's no skill for it. **`build-link`**
  takes a destination URL + optional subid and picks the right
  network + programme to generate from, honouring the user's
  registered networks. Bulk variant: paste a list of URLs, get
  links back in a table.
- **"Find me programmes I'm not on but should be."** Most networks
  expose a `/programmes?status=available` filter. A
  **`programme-discovery`** skill scans the available pool, ranks
  by EPC (where the network publishes it) or commission rate, and
  filters by category if the user names one. Application itself
  stays manual on most networks — we surface the apply URL.
- **"Compare networks for the same brand."** Several big brands run
  programmes on multiple networks at different rates (Nike on CJ
  vs Awin; ASOS on Awin vs Impact). **`compare-networks-for-brand`**
  pulls the live commission rate, EPC, and cookie window from each
  and tells the user which programme is better today.
- **"Export this for my accountant."** Today the user has to ask
  Claude to format the response as a CSV; **`tax-export`** does the
  filtering (paid transactions in a given financial year, per
  currency, per network) and emits a CSV with the columns
  accountants want (date, network, brand, gross sale, commission,
  currency, status).

### Brand side — what we don't yet cover well

- **"Approve / decline this batch of pending transactions."** The
  brand-side adapters are read-only at v0.1. The write path is on
  the roadmap behind a hard consent gate (user types the action and
  confirms before any non-GET HTTP method leaves the machine). The
  highest-value write op is transaction validation — today an
  in-house brand manager logs in to each network to approve
  pending sales individually. A **`validate-transactions`** skill
  with a single "approve this list?" confirmation per network is
  the target. Read-only stays the default for the network; write
  is opt-in per credential.
- **"Onboard a new publisher."** Publisher application triage
  today happens in each network's dashboard. The data is
  available via API on most networks (applications since date X,
  publisher metadata, traffic source). A
  **`new-publisher-triage`** skill surfaces the pending pool
  weekly with a recommendation per applicant. Approval itself
  stays a network-dashboard action until the write path lands.
- **"Why is my tracking broken?"** A **`tracking-diagnostic`**
  skill takes a test order ID or click ID and walks it through
  the network's reporting — was the click received, did the
  conversion attribute, did the commission compute. Today the
  brand manager has to know which network log to check.
- **"Coupon code leak watch."** Brands give exclusive codes to
  specific publishers. Codes leak. A **`coupon-leak-watch`**
  skill correlates code usage by publisher against the publisher
  who was supposed to own it and flags mismatches. Most networks
  expose the coupon-used field on transactions; the work is
  in the correlation, not the data fetch.
- **"Brief my publishers about the Black Friday promo."** A
  **`publisher-brief-drafter`** skill takes a brief in English
  and drafts a per-publisher email (or a single newsletter)
  tailored to each publisher's traffic profile and historical
  conversion rate. Send-out itself stays in the user's email
  client; we draft, we don't send.

### Agency side — make the weekly client report disappear

The portfolio rollup skill exists ([`agency-portfolio-rollup`](../../src/skills/agency-portfolio-rollup/SKILL.md))
and answers "how is the whole book doing this week?" The agency
roadmap is what comes after that:

- **Scheduled weekly client reports.** Agencies run the same
  questions every Monday for every client. Pair the existing
  [`programme-performance-report`](../../src/skills/programme-performance-report/SKILL.md)
  with Claude's own scheduling so each client gets a tailored
  report in their inbox without anyone touching a dashboard.
  We don't run the schedule — Claude does — but we tune the skill
  to produce the same shape every week so the agency can drop the
  output straight into their client portal.
- **Monthly / quarterly deck generator.** A
  **`client-deck`** skill emits a slide-shaped Markdown
  (title slide, headline numbers, top publisher table, trend
  chart description, callouts) that the user can convert to
  Google Slides via a separate Claude artifact step. Same data
  the rollup pulls; different shape.
- **White-label output.** The reports today are rendered in our
  default voice. The next iteration honours a per-brand
  `agency-profile.json` (logo URL, primary colour, signoff
  block) so the same skill emits Acme-branded output for Acme
  and Globex-branded output for Globex. The profile is local;
  we never ship it.
- **Cross-client benchmarking.** "How does Acme's conversion
  rate compare to the rest of my DTC clients this quarter?" —
  needs careful anonymisation so client A doesn't see client B's
  numbers. The skill computes the comparator from the agency's
  own book; we never look at it.
- **New client onboarding.** Adding a brand to `brands.json`
  today is a re-run of the setup wizard. An agency adding a new
  client wants to: name the brand, pick the networks the brand
  is on, paste each network's brand ID, done. A
  **`add-brand`** subcommand does exactly that, skipping the
  unrelated credential prompts.

### Finance side — the CFO chasing network payments

The CFO and the agency finance lead share a different vocabulary
from the affiliate manager: A/R aging, accrual, clawback rate,
multi-currency reconciliation, 1099 generation. Today
`affiliate-mcp` exposes the raw transaction data that these
workflows need; the skills don't yet speak the CFO's language. The
finance pack is:

- **Aging report.** "What's owed to me, by who, how long has it
  been waiting?" Approved-but-unpaid transactions per network,
  bucketed by age (0–30, 30–60, 60–90, 90+ days). Flag anything
  past the network's published payment timeline as a chase
  candidate. The publisher-side version of this exists in
  [`affiliate-earnings-report`](../../src/skills/affiliate-earnings-report/SKILL.md)
  as a "flag anything unpaid >90 days" line; the CFO skill turns
  it into a structured A/R table with chase recommendations.
- **Payment reconciliation.** When Awin pays out, did the payment
  match the locked-in commissions you expected? A
  **`reconcile-payout`** skill takes a payment statement (paste
  it; CSV or PDF text), matches it line-by-line against the
  network's reported paid transactions, and flags variances.
- **Reversal-rate watch.** A spike in reversals is a finance
  signal as much as an ops one. A
  **`reversal-rate-watch`** skill computes the reversal rate by
  network and by programme, week-over-week, and flags any
  programme whose reversal rate jumped >2σ above its trailing
  90-day baseline.
- **Revenue forecast from pipeline.** Locked + pending
  transactions across every network, with the network's
  historical approval rate applied, projects "how much will
  actually land". Honest about the inputs: forecast is bounded
  below by paid + approved, bounded above by paid + approved +
  pending × historical-approval-rate.
- **Multi-currency rollup with FX timestamping.** The agency
  rollup keeps each currency on its own sub-line today
  (deliberately — agencies invoice in client currencies). The
  finance skill takes the opposite stance: rolls everything to
  a reporting currency at the FX rate from the transaction
  date, with the rate source named. We don't ship an FX feed;
  we read from a configurable provider (default: ECB daily
  reference rates, public, free).
- **1099 / tax exports.** US publishers crossing $600 in a
  calendar year get a 1099 from each network. **`tax-export`**
  on the publisher side emits the data in the shape an
  accountant expects (per network, per status, per currency,
  per financial year). UK / EU equivalents (Self Assessment,
  VAT-relevant fields) ship alongside.

## Network coverage

Two threads here: more networks, and existing networks promoted to
`production`.

### More networks (wanted)

The README's [Wanted](../../README.md#wanted) table lists four
networks people have specifically asked for: Tradedoubler, Partnerize,
Skimlinks, Webgains. None of them have an adapter today. Adding any
of them is a `contribute`-skill conversation; the priority order is
roughly the order in the table. If a network's own engineering team
adopts the adapter (via [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
under "Adopting your network"), they jump the queue.

Beyond the wanted list, the next tier of networks to consider —
based on share of inbound questions to the project — is ShareASale,
ClickBank, Refersion, and PartnerStack. Each is a separate
contribution; no commitment to any of them by us, but the scaffold
is ready ([`templates/new-network/`](../../templates/new-network/)).

### Promote existing adapters from partial / experimental → production

This depends on live acceptance tests against real accounts. The
order, once accounts are available:

1. **Awin (publisher)** — already the reference implementation;
   smallest gap to production.
2. **Impact (publisher)** — second; the 5xx-storm workarounds need
   one real-world week of telemetry to confirm the retry envelope
   is still right.
3. **CJ (publisher)** — third; the GraphQL-on-200 error path
   particularly wants live evidence.
4. **Awin (advertiser)** — first brand-side promotion; rate-budget
   behaviour on a multi-brand Accelerate account needs verifying.
5. **Impact (advertiser)** — second brand-side; the sync-vs-async
   report polling path has `// TODO(verify)` notes.
6. **CJ (advertiser)** — third brand-side; `viewer.companyMemberships`
   field name verification, performance row status mapping.
7. **Rakuten (publisher)** — only after Publisher Solutions grants
   API access on the test account.
8. **eBay (publisher)** — only after the EPN developer-account
   approval gate; needs a real reporting endpoint round-trip.

Promotion mechanics: each adapter's `network.json` carries a
`claim_status` field. A live acceptance run flips it to `production`;
a regression flips it back. The summary table in
[`REPORT.md`](../../REPORT.md) regenerates on every merge, so the
public view stays honest.

### Brand-side parity

Three networks (Awin, CJ, Impact) ship brand-side adapters today.
The gap:

- **Rakuten brand-side.** Rakuten has an advertiser-tier API but a
  more complex auth model than the publisher side. We skipped it at
  v0.1; v0.2 is the right place to revisit.
- **Partnerize, when added.** Partnerize is uncommon in that the
  same network has clearly separated publisher- and advertiser-tier
  credentials, both well-documented. Adding it should produce two
  adapters in one pass.

Brand-side parity for eBay is a non-goal — EPN has only one
advertiser (eBay itself), so there's no brand-side surface to
integrate with.

## Action, not just reporting

Every adapter today is read-only on the brand side and effectively
read-only on the publisher side (the only mutating op is
`generateTrackingLink`, and on most networks that's deterministic URL
construction with no API call). The roadmap for write paths is
deliberate: we add them one operation at a time, behind explicit
consent, with the diff visible before it happens.

The first writes to ship, in order:

1. **Validate a pending transaction (brand side).** Highest-value
   write op for in-house brand managers. Hard consent gate: the
   user types the list of transaction IDs, the skill summarises
   what will be approved (count, total commission, per-publisher
   breakdown), the user types "approve" before any HTTP call goes
   out.
2. **Adjust a single publisher's commission rate (brand side).**
   The brand manager's other recurring write workflow.
3. **Apply to a programme (publisher side).** Where the network
   supports application via API (Awin does; CJ does for some
   programme types; Impact does). Today's roadmap surfaces the
   apply URL; the upgrade is to fill the form and submit it on the
   user's confirmation.

Writes are gated per credential, not per network. A user with
read-only credentials at Awin and read-write credentials at Impact
gets Impact writes and not Awin writes; we never lie about scope.

## Skills that need to exist but don't fit elsewhere

A few skills don't belong to a single persona but would help all of
them:

- **`affiliate-quick-question`** — a small fast skill that answers
  one-off questions ("what's my Awin token's expiry?", "how many
  programmes am I on?", "what was my best day last month?") without
  the structured shape of the bigger skills. Lower latency, lower
  ceremony.
- **`affiliate-explain`** — explains a row, a status, or a
  network-specific term in English. "Why is this transaction
  `LOCKED`?", "What does Awin mean by `validationDate`?". Reads from
  the same per-network notes the findings docs are built on. Helps
  new users in particular.
- **`affiliate-network-status-page`** — checks the public status
  page of every configured network (Awin, CJ, Impact, eBay, Rakuten
  all publish one) and surfaces ongoing incidents alongside the
  user's data. If you see lower numbers than expected, this tells
  you whether it's your problem or theirs.

## Non-goals

Things we deliberately do not plan to build, with the rationale:

- **Our own dashboard / hosted UI.** The product is the
  conversation. If the user wants a chart, Claude makes them a
  chart. We don't compete with the network dashboards on their
  own terms.
- **Scraping where an API exists.** Every operation today maps to a
  documented public API. We won't scrape rendered dashboards for
  data the network chose not to expose; we'll surface that the data
  isn't available and explain why (per the
  `NotImplementedError` pattern documented in
  [`AGENTS.md`](../../AGENTS.md)).
- **A hosted credential store.** Credentials stay on the user's
  machine. The cloud / mobile path in the Onboarding section is the
  one exception, and it's opt-in, separately auth'd, and explicit
  about the trade-off.
- **Cross-network FX normalisation by default.** Agencies report in
  client currencies; publishers care about their payment currency.
  The finance pack's roll-to-reporting-currency is opt-in for
  exactly the CFO workflow; the default stays per-currency.
- **Affiliate fraud detection beyond what the networks themselves
  surface.** We can flag anomalies the user can see in their own
  data. We do not run our own fraud model against publisher
  behaviour, traffic patterns, or external signals.

## How this roadmap changes

This document is intent. The honest state of every shipping
adapter is in [`REPORT.md`](../../REPORT.md), regenerated from
each adapter's `network.json` on every merge. The status of any
in-flight skill or feature is in the GitHub issue tracker, not
here.

If you think a workflow on this list is in the wrong order — or a
workflow you do every day isn't on the list — open an issue and
say what you do. We treat every "I wish it could…" as a vote.
