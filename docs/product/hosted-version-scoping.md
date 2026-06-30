# Hosted version for non-technical users: value-first scoping (2026-06-27)

> Status: discovery proposal, pre-decision. This document deliberately sets the
> local-first README stance aside to look at the value a hosted version would
> unlock, and at what hosting would actually have to solve. It does not
> authorise implementation. A hosted product reverses an accepted product
> boundary (manifesto Principle 2; `docs/product/chatgpt-scoping.md`) and would
> need its own decision record under `docs/decisions/` before any foundation is
> built.

## Why this is worth thinking about

The project's value and its current distribution model point at two different
audiences, and they barely overlap.

The value is largest for people who manage affiliate relationships for a living:
agency account managers, brand managers, and multi-network publishers. The
packaged skills speak directly to their week: `agency-portfolio-rollup`,
`programme-performance-report` in QBR cadence, `programme-anomaly-watch`,
`partner-roster-audit`, `chase-unpaid-commissions`, `partner-outreach`. These
are the jobs that today cost a person hours of CSV exports, dashboard filtering,
and spreadsheet stitching across many network back-ends.

The distribution model reaches the opposite group. To get any of that value
today a user needs a terminal, Node 20+, willingness to paste API credentials
into a shell or a `.env` file, and the patience to wire an MCP client. The one
low-friction path (Claude Desktop `.mcpb`) covers credential entry for four
networks. Everyone else hits a setup wall.

So the people who would get the most value are, on average, the least able to
reach it. That gap is the entire case for a hosted version. Nothing about the
adapters, the workflows, or the data needs to change. The thing that needs to
change is who has to do the install and who holds the keys.

## Where the value concentrates

Three properties create the value, and none of them is network-specific:

1. **Consolidation.** One question spans 72 network families instead of 72
   dashboards. "Which programmes have approved commission unpaid past 90 days?"
   is one prompt, not a morning of exports.
2. **Workflow, not endpoints.** The skills map to real jobs (QBR prep, anomaly
   review, partner re-engagement) so the user never learns an API name.
3. **Plain language in the tool they already use.** The answer arrives inside
   Claude or ChatGPT, next to the doc they were already writing.

Notably, value scales with how non-technical the user is. A developer can write
their own script against the Awin API. An agency account manager preparing a
client QBR cannot, and that is precisely the person the skills are written for.
The hosted version is not a convenience layer on top of the existing value. For
the highest-value cohort it is the only way the value exists at all.

## The friction wall, precisely

A genuinely non-technical user is blocked at one or more of:

- **Runtime.** Installing Node and running `npx`.
- **Credential capture.** Finding each network's keys in its dashboard and
  pasting them into a terminal wizard or a `.env` file. Only four networks have
  a UI field today.
- **Client wiring.** Editing `claude_desktop_config.json` or ChatGPT's
  developer-mode connector settings.
- **Liveness.** The tunnel approach in `chatgpt-scoping.md` keeps credentials
  local but requires the user's laptop to be awake whenever the assistant calls
  a tool.

A hosted version removes all four at once: log in with a browser, connect each
network through a guided OAuth or paste-once flow, ask questions. No runtime, no
local file, no client config, no laptop-awake constraint.

## What hosting actually has to solve

The adapter logic is clean and ports unchanged. The hard problems are all at the
boundary the project has so far deliberately not built. From the architecture
review:

- **Identity and isolation.** The server is identity-blind today. Credentials
  load once from `~/.affiliate-mcp/.env` into `process.env`; OAuth tokens cache
  in module-level state; `brands.json` and client-strategy files live on local
  disk. Every one of these is process-global and would collide across users.
  Hosting requires a real per-user boundary: authenticated identity, and
  request-scoped credential, token, brand, and strategy lookups keyed by user.

- **Credential custody, the real decision.** This is the crux, not an
  implementation detail. Today the project never holds a user's network
  credentials. A hosted version that stores them takes on custody of live
  affiliate API keys for many tenants: encryption at rest, key rotation, breach
  exposure, GDPR and likely SOC 2 scope, and the trust conversation that
  follows. This single change is what `chatgpt-scoping.md` meant by "different
  product." It is reversible only with a deliberate, documented decision.

- **Browser-handoff actions do not fit hosting.** Operations like Awin
  publisher programme application have no API and are handled by handing the
  user a URL to their own authenticated dashboard session
  (`docs/decisions/2026-06-12-browser-handoff-contract.md`). In a hosted,
  multi-tenant service there is no clean way to drive a user's dashboard session
  without storing their login session, which is a much larger custody and safety
  risk than holding API keys. These operations should stay out of scope for a
  first hosted version, surfaced as "continue in your browser" links rather than
  hosted actions.

- **Honest-truth and audit obligations grow.** The project's existing
  commitment to honest network truth becomes a contractual one once an agency
  relies on a hosted report for a client. Central audit logging (who accessed
  which brand's data, when) shifts from nice-to-have to expected.

## The option spectrum

Following the comparison style of `chatgpt-scoping.md`, from least to most
custody:

| Option | Zero-install? | Credential custody | Verdict |
|---|---|---|---|
| **Assisted-local tunnel** (shipped design, `chatgpt-scoping.md`) | No (needs runtime + awake machine) | None; keys stay local | Already the answer for semi-technical users. Does not reach the non-technical cohort. |
| **Bring-your-own-key, hosted execution** | Yes | We store per-user encrypted keys, decrypt only at call time | Smallest hosted step that actually removes the wall. Custody is real but bounded to API keys. |
| **Fully managed SaaS** (accounts, billing, dashboards) | Yes | Full, plus session-level for browser actions | Largest reversal and largest compliance surface. A separate company-scale commitment, not a feature. |

The middle option is the one worth designing. It unlocks the non-technical
cohort with the narrowest possible expansion of what the project holds.

## Recommended shape, if Rob wants to pursue it

A phased path that maximises value per unit of risk:

1. **Decision first.** Land a decision record that explicitly accepts (or
   rejects) hosted credential custody, names the legal and security owner, and
   sets the privacy contract for hosted data. Until it merges, no foundation.
   This is the governance gate, not optional process.

2. **Foundation: per-user boundary, read-only, top networks.** Start with the
   four API-backed, production-grade networks (Awin, CJ, Impact, Rakuten) and
   read-only workflows only (earnings, performance, anomaly, unpaid
   commissions). Highest value, bounded risk, no write actions, no browser
   handoffs. The work is an HTTP+auth wrapper, an encrypted per-user credential
   vault, and request-scoped versions of the credential, token, brand, and
   strategy lookups. Adapters themselves are untouched.

3. **Guided connection flow.** Replace terminal credential entry with a
   browser onboarding flow per network: OAuth where the network supports it,
   guided paste-once where it does not. This is where the non-technical
   experience is won or lost.

4. **Defer writes and browser handoffs.** Keep them as local-only or
   "continue in your browser" until there is a separate, accepted hosted-action
   safety contract.

The wedge is the agency account manager doing a portfolio rollup or QBR across
brands. If the hosted version does that one journey end to end with zero
install, it has proven the value. Everything else is breadth on top of a working
spine.

## What this costs and what it reverses, honestly

- It reverses manifesto Principle 2's default and the explicit rejection in
  `chatgpt-scoping.md`. That is a maintainer decision, not an agent one.
- It moves the project from "we never hold your data" to "we hold your API keys
  under a stated contract." The trust and compliance cost is real and ongoing.
- It does not require touching the adapter contract, the skills, or the
  workflows. The value layer is ready; the boundary layer is the build.
- The assisted-local tunnel remains the right answer for semi-technical users
  who would rather not hand over keys. Hosted is an addition for the cohort that
  cannot self-host, not a replacement.

## Open decisions for Rob

1. Is hosted credential custody acceptable in principle, and if so who owns its
   legal, security, and privacy contract?
2. Bring-your-own-key hosted execution, or wait? (Recommendation: the BYO-key
   middle option, read-only, four networks, as the first proof.)
3. Does the privacy-first telemetry decision
   (`docs/decisions/2026-06-13-privacy-first-telemetry.md`) extend cleanly to
   hosted data, or does hosting need its own privacy contract?
4. Is the agency QBR / portfolio-rollup journey the right wedge to prove value
   before any breadth?

## Next step

If the direction is worth pursuing, the next artefact is a decision record under
`docs/decisions/` proposing hosted credential custody with the contract above,
not implementation. This document is discovery only.
