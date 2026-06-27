# Privacy-first telemetry

- **Date:** 2026-06-13
- **Status:** Accepted (2026-06-13)
- **Affects:** the "no telemetry" product non-goal in `AGENTS.md`, `PRIVACY.md`,
  a telemetry module in shared core, the CLI setup and install surfaces, the
  desktop setup app, and a first-party ingestion endpoint
  (`telemetry-cloudflare/`)
- **Depends on:** nothing merged. Supersedes the blanket "no telemetry" non-goal
  recorded in `AGENTS.md` and is the foundation the implementation in
  [#173](https://github.com/bobberrisford/affiliatemcp/pull/173) is reshaped
  against.

## Context

`affiliate-mcp` shipped with an explicit non-goal: "no telemetry", "no
phone-home telemetry". That promise has served the local-first ethos well, but
it leaves the project blind in two ways that now matter at the current scale of
72 networks across 86 adapters. There is no signal about which networks are
actually configured and exercised, so adapter priority and the
production/partial/experimental promotion order are guesswork. And there is no
signal about which operations fail in the field, so a network that quietly
breaks upstream is only discovered when a user reports it.

The maintainer's triage of #173 was explicit: telemetry changes a stated product
non-goal, introduces a hosted ingestion surface, and spans privacy, deployment,
shared runtime, and cross-client consent. A decision must settle the
privacy and deployment contract before any implementation lands. This record
takes that position.

## Decision

Adopt opt-in, aggregate-only telemetry, off by default, sent to a first-party
ingestion endpoint, and never carrying affiliate data, credentials, or
account identifiers.

### Default and consent

- **Off by default. Opt-in only.** Telemetry is disabled unless the operator
  explicitly enables it. The current public promise is that the server runs
  locally and sends nothing; an opt-out default would silently break that
  promise for every existing user on upgrade. Opt-in keeps the promise intact
  for anyone who does nothing.
- Consent is requested once, in plain language, at setup and in the desktop
  setup app, and the choice is recorded locally. Declining is a first-class
  outcome, not a nag.
- An environment kill switch always wins. When telemetry is off, the code path
  that would emit is never entered; there is no buffering "for later".

### What is collected

Aggregate, anonymous usage and health signal only:

- the release version, a coarse platform string (OS family), and the MCP client
  type (Claude Desktop, Claude Code, CLI, other);
- which networks are configured and exercised, by network slug only;
- operation invocation counts and error counts grouped by category (for
  example auth failure, rate limit, upstream 5xx), keyed to the
  `NetworkErrorEnvelope` operation and network names;
- a random, rotatable install identifier that is not derived from any machine,
  user, or account attribute.

### What is never collected

- No credentials, API keys, tokens, or any value read from `~/.affiliate-mcp/.env`.
- No affiliate data: no transaction records, earnings figures, click data,
  programme financials, tracking links, or `rawNetworkData` passthrough.
- No account identifiers: no publisher ID, advertiser ID, brand ID, order ID,
  or resolved `networkBrandId`.
- No cache contents, no file paths, no free-text, no arguments passed to a tool
  call.

The boundary is a strict allowlist in code: a field is sent only if it appears
on the list above, never by virtue of not being denied.

### Deployment surface

- Ingestion is a first-party Cloudflare Worker with a small datastore
  (`telemetry-cloudflare/`), owned by this project, minimal, and inspectable in
  the repository. No third-party analytics SaaS is used, so aggregate usage
  data is never handed to an external processor.
- Local-first still holds for the user's actual data. Telemetry is a separate,
  explicitly enabled, aggregate channel; the affiliate data and credentials
  remain on the user's machine exactly as before.

### Cross-client contract

The consent state and the collection allowlist live in shared core. Claude
Desktop, Claude Code, the CLI, and the `.mcpb` bundle are thin clients of that
one contract; none of them defines its own telemetry scope or default. A change
to what is collected is a change to the shared contract and a risk-based review
item.

## Security

- Strict allowlist, not denylist: only the enumerated aggregate fields can ever
  leave the machine, so a new field added elsewhere in the codebase is not
  silently transmitted.
- Off by default and explicitly opt-in, so the privacy posture of an
  un-configured install is unchanged from today.
- No credentials and no affiliate data in any payload; the install identifier
  carries no account or machine linkage.
- First-party ingestion only, no third-party processor.
- Documented in full in `PRIVACY.md`, which is the single source of truth for
  what is collected and how to disable it.

This is a privacy, deployment, shared-contract, cross-client, and
product-direction decision with implementation consequences, and is a
risk-based review item for maintainer review.

## Rejected alternatives

- **Keep "no telemetry" as an absolute non-goal.** The status quo. Rejected
  because it leaves adapter prioritisation and field-breakage detection to
  guesswork at a scale where that now has a real cost.
- **Opt-out default.** Better data coverage, but it flips a standing public
  privacy promise for existing users on upgrade. Rejected; the coverage gain
  does not justify breaking the promise silently.
- **Rich, per-event detail.** More useful product signal, but a far larger
  privacy surface to document and defend, and a tempting path toward collecting
  identifiers. Rejected for v1 in favour of the aggregate allowlist; a richer
  scope would need its own decision.
- **A third-party analytics SaaS** (for example a hosted product-analytics
  vendor). Rejected: it hands aggregate usage data to an external processor and
  contradicts the first-party, inspectable, self-hostable posture the rest of
  the project holds to.

## Consequences

- The `AGENTS.md` non-goal changes from "no telemetry" to "optional, opt-in,
  aggregate-only telemetry that conforms to `PRIVACY.md`". This record is the
  authority for that change.
- `PRIVACY.md` becomes a shipped, load-bearing document: it must enumerate
  exactly what is collected, the opt-in mechanism, the kill switch, and the
  ingestion endpoint.
- Shared core gains a telemetry module and a consent gate; the CLI and desktop
  setup flows gain the opt-in prompt.
- The project takes on operating a small first-party ingestion service, with
  its own retention and access posture to be documented alongside it.

## Implementation follow-ups

1. Reshape [#173](https://github.com/bobberrisford/affiliatemcp/pull/173)
   against this record: rebase onto current `main` (the branch is stale, its
   `AGENTS.md` still describes four networks), confirm the default is opt-in,
   and confirm the emitted payload matches the aggregate allowlist exactly,
   with the never-collected list enforced in code.
2. Land `PRIVACY.md` as the single source of truth, referenced from `README.md`,
   `.env.example`, and the setup docs.
3. Add tests that assert no credential, affiliate-data, or identifier field can
   reach the telemetry payload, and that telemetry is inert when disabled.
4. Document the `telemetry-cloudflare/` ingestion service: what it stores, for
   how long, and who can read it.
