# Affiliate MCP Product and Technical Roadmap

> Status: current product and technical roadmap.
>
> Repository assessment date: 2026-06-15.
>
> This document recommends direction and sequencing. Accepted records under
> [`../decisions/`](../decisions) and shipped behaviour remain authoritative.
> Recommendations that change architecture, public contracts, privacy,
> security, deployment, or cross-client behaviour require a focused decision
> record before implementation.

## 1. Executive summary

### What the product is today

affiliate-mcp is a local-first affiliate data layer for AI workspaces. It
connects user-supplied affiliate-network credentials to:

- a local stdio MCP server;
- generated, typed network tools;
- packaged affiliate workflow skills;
- MCP prompts;
- setup, diagnostic, and client-install CLI commands;
- host-native Claude Desktop and Claude Code packages;
- local Codex configuration.

The repository contains 86 adapters across 72 network families: 63
publisher-side adapters and 23 advertiser-side adapters. The breadth is real,
but maturity is uneven: 82 adapters declare `experimental` and four declare
`partial`; none currently declares `production`.

### Who it clearly serves today

The clearest working paths are:

- technical or semi-technical publishers who can run the CLI and want
  cross-network earnings, transaction, programme, and link analysis;
- brand and agency operators using the advertiser-side adapters and packaged
  reporting skills;
- Claude Desktop users who can install the host-native `.mcpb` bundle,
  especially when they use Awin, CJ, Impact, or Partnerize;
- Claude Code and Codex users comfortable with local MCP and package setup;
- affiliate-network contributors who can follow the rigid adapter scaffold and
  contribution workflow.

### Where the value proposition is strong

- The shared contract turns inconsistent network APIs into understandable
  affiliate operations.
- The local-first model is credible: credentials remain local, result caching
  is optional, and runtime telemetry is opt-in.
- The project covers both sides of affiliate marketing, including logical brand
  bindings for agency and advertiser workflows.
- The repo has strong fixture coverage, error honesty, resilience conventions,
  contributor guardrails, and a substantial automated test suite.
- Packaged skills show the product can deliver useful outcomes rather than only
  expose endpoints.

### Where the product story is unclear

- The headline promise varies between "Claude or Codex", "Claude or ChatGPT",
  and a wider "AI of choice" ambition.
- Setup is presented through several overlapping mechanisms: `.mcpb`, CLI
  wizard, CLI installer, manual Claude Desktop JSON, Claude Code plugin, Codex
  TOML, Cowork mirror, and the Electron setup app.
- Adapter count is prominent even though most adapters have not been verified
  against live accounts.
- Tools, MCP prompts, packaged skills, examples, and product backlog documents
  need one explicit contribution rule.
- Some skills and examples contain stale assumptions or names despite the
  repository's broader current surface.

### Top three product risks

1. **Breadth without trust.** Users may interpret 86 adapters as 86 reliable
   integrations even though 82 are experimental.
2. **Setup choice overload.** The project risks making non-technical users
   choose between implementation mechanisms they should not need to understand.
3. **Disconnected capability growth.** More adapters and endpoint-specific
   tools can grow faster than useful, verified customer journeys.

### Top three technical risks

1. **Adapter-scale maintenance.** More than 75,000 lines of adapter code,
   averaging roughly 875 lines per adapter, create a growing verification and
   consistency burden.
2. **Contract and metadata drift.** Runtime metadata, `network.json`, generated
   docs, package/plugin versions, skills, prompts, and install surfaces can
   disagree.
3. **Cross-client assumptions.** A portable MCP server does not automatically
   make installation, skills, prompts, credentials, and workflow behaviour
   portable across every AI client.

The next phase should optimise for verified customer outcomes, not adapter
count. The product should present two onboarding tracks, make Claude Desktop
the strongest non-technical path without narrowing the mission, and prove a
portable local MCP core across several clients before adding a remote ChatGPT
surface.

## 2. Current product surface

### MCP tools and prompts

- [`src/tools/generate.ts`](../../src/tools/generate.ts) generates the
  canonical operations for each registered adapter and six meta-tools:
  `affiliate_list_networks`, `affiliate_run_diagnostic`,
  `affiliate_resolve_brand`, and the advisory client-strategy tools
  `affiliate_get_client_strategy`, `affiliate_set_client_strategy`, and
  `affiliate_list_client_strategies`.
- Publisher adapters receive seven canonical operations. Advertiser adapters
  additionally expose `listMediaPartners` and `getProgrammePerformance`, and
  their tools require a logical `brand` argument.
- Awin and Tradedoubler have additional network-specific tool generators in
  [`src/networks/awin/tools.ts`](../../src/networks/awin/tools.ts) and
  [`src/networks/tradedoubler/tools.ts`](../../src/networks/tradedoubler/tools.ts).
- [`src/prompts/generate.ts`](../../src/prompts/generate.ts) exposes five
  Awin-specific MCP prompts for performance, offers, links, transactions, and
  programme opportunities.

### Affiliate-network adapters

- [`src/networks/`](../../src/networks) contains 86 adapter directories.
- [`src/networks/index.ts`](../../src/networks/index.ts) imports every adapter
  for its registration side effect.
- [`src/shared/types.ts`](../../src/shared/types.ts) defines the stable,
  provider-neutral domain and adapter contracts.
- Every adapter has a structured `network.json`; every adapter also has a
  user-facing setup guide under [`docs/networks/`](../networks).
- [`REPORT.md`](../../REPORT.md) is generated from manifests and findings, but
  its introduction still describes the original four-network report while its
  table now contains the full adapter surface.
- 82 adapters declare `experimental`; Awin, CJ, Impact, and Rakuten publisher
  adapters declare `partial`.

### Skills and workflows

Ten packaged skills live under [`skills/`](../../skills):

- Publisher: earnings report, network status, setup help, affiliate-link audit,
  and unpaid-commission chase.
- Brand and agency: programme performance, publisher review, reversal report,
  portfolio rollup, and anomaly watch.

[`docs/product/agency-account-manager-deliverables.md`](./agency-account-manager-deliverables.md)
maps agency deliverables to shipped, extended, partial, and proposed workflows.
The skills prove useful workflow value, but they currently have stronger
packaging and validation for Claude-oriented hosts than for every target AI
client.

### Setup and install flows

| Surface | Actual path | Current role |
| --- | --- | --- |
| Credential setup | `npx affiliate-networks-mcp setup` | Complete guided path for all adapters; requires Node.js and a terminal |
| Health check | `test`, `doctor`, and `affiliate_run_diagnostic` | Strong troubleshooting and capability surfaces |
| Claude Desktop native | GitHub release `.mcpb` from [`mcpb/`](../../mcpb) | Primary non-terminal path; secure fields cover four networks |
| Claude Desktop CLI | `npx affiliate-networks-mcp install --desktop` | Writes and backs up native config |
| Claude Desktop manual | [`examples/claude-desktop-config.md`](../../examples/claude-desktop-config.md) | Useful fallback for technical users |
| Claude Code plugin | [`.claude-plugin/`](../../.claude-plugin) | Installs MCP plus packaged skills |
| Claude Code CLI config | `install --code` | Registers the stdio MCP server through the Claude CLI |
| Codex | `install --codex` | Writes local stdio MCP configuration |
| Claude Cowork | `cowork-mirror` | Creates a private GitHub mirror; requires org-admin follow-through |
| Electron setup app | [`desktop/`](../../desktop) | Fixes-only compatibility fallback |

### AI-client support

- **Claude Desktop:** shipped through `.mcpb`, CLI configuration, manual
  configuration, and the compatibility desktop app.
- **Claude Code:** shipped through plugin packaging and CLI registration.
- **Codex:** shipped through local stdio MCP configuration; the same config is
  used by CLI and IDE extension.
- **Claude Cowork:** partially shipped through a private-mirror flow.
- **ChatGPT:** no shipped connector. Repository plans correctly distinguish
  local stdio support from reachable HTTPS MCP.
- **Cursor and VS Code:** the local MCP server is compatible in principle, but
  this repository does not provide a documented, tested first-party setup
  journey for either.
- **Generic MCP clients:** possible through manual stdio configuration, but not
  presented as a polished journey.

### Telemetry and privacy

- [`PRIVACY.md`](../../PRIVACY.md) documents opt-in, aggregate-only runtime
  telemetry and local cache behaviour.
- [`src/shared/telemetry.ts`](../../src/shared/telemetry.ts) centralises the
  client-side allowlist, consent gate, daily aggregation, and upload.
- [`telemetry-cloudflare/`](../../telemetry-cloudflare) contains the first-party
  ingestion and dashboard service.
- The accepted telemetry decision, privacy policy, and implementation are close
  but not identical in every detail. For example, the decision permits a coarse
  OS family while the shipped privacy policy explicitly says operating system
  is never sent.

### Examples, docs, and product guidance

- The root [`README.md`](../../README.md) is the main public product and setup
  document.
- [`docs/README.md`](../README.md) defines documentation authority.
- [`docs/decisions/`](../decisions) contains accepted and proposed records.
- [`docs/product/`](.) contains direction, active proposals, research, and
  historical plans.
- [`site/`](../../site) contains the public website.
- [`AGENTS.md`](../../AGENTS.md) and repo-local delivery skills define a mature
  human and coding-agent contribution system.

## 3. Customer journeys

### Publisher user

- **Entry point:** README, website, network-specific search, or a recommendation
  to ask an AI assistant about earnings.
- **Setup path:** `.mcpb` for a small launch-network set, otherwise the CLI
  setup wizard followed by client installation.
- **First aha moment:** a cross-network earnings report, unpaid commission
  review, or transaction investigation without opening multiple dashboards.
- **Friction:** obtaining API credentials, understanding experimental support,
  terminal use outside the four `.mcpb` setup fields, and uneven network
  capability.
- **Missing affordances:** a capability-aware first-run workflow, a portable
  credential setup UI, and a simple statement of which networks are verified
  versus merely available.
- **Manifesto fit:** strong when the user's client can run local stdio MCP;
  weaker when setup requires Claude-specific packaging or an undocumented
  generic-client configuration.

### Brand or advertiser user

- **Entry point:** README brand-side examples or a need for programme reporting.
- **Setup path:** choose advertiser side in the wizard, configure credentials,
  then discover and nickname brands.
- **First aha moment:** a programme performance report or publisher rollup for
  one logical brand across networks.
- **Friction:** only 23 advertiser adapters, uneven operation coverage, many
  experimental integrations, and unclear separation between read workflows,
  proposed writes, and browser handoffs.
- **Missing affordances:** a clear advertiser capability matrix and a
  guided first report that explains coverage gaps.
- **Manifesto fit:** good for read-oriented reporting; not yet a complete
  affiliate operations layer.

### Agency managing multiple clients

- **Entry point:** agency examples and packaged portfolio/reporting skills.
- **Setup path:** configure multi-brand advertiser credentials, bind logical
  brand names, then use agency skills.
- **First aha moment:** one portfolio rollup or client report spanning several
  brand-network bindings.
- **Friction:** brand mapping complexity, unsupported metrics, uneven strategy
  coverage across the book, and no team-level configuration management.
- **Missing affordances:** capability-aware templates, shared team deployment,
  and controlled output delivery.
- **Manifesto fit:** strategically strong because the AI workspace is the
  natural place for reporting and narrative work; operational maturity is
  incomplete.

### Affiliate-network contributor

- **Entry point:** adoption issue, `CONTRIBUTING.md`, or repo-local
  `contribute` skill.
- **Setup path:** follow the network scaffold, reference adapter, fixtures,
  setup docs, and verification commands.
- **First aha moment:** their network becomes a typed integration with
  generated tools and public capability documentation.
- **Friction:** large reference adapters, duplicated manifest/runtime metadata,
  manual registration, generated-doc responsibilities, and live credential
  requirements.
- **Missing affordances:** a clearer production-promotion contract and
  automation that detects metadata and registration drift.
- **Manifesto fit:** strong. Network ownership is an effective way to improve
  truthful, portable support.

### Non-technical Claude Desktop user

- **Entry point:** download the `.mcpb` release.
- **Setup path:** install the extension and enter launch-network credentials.
- **First aha moment:** ask "What affiliate networks do you have access to?"
  and then run a packaged workflow.
- **Friction:** only four rich credential forms, unclear fallback for other
  networks, experimental-network trust, and extension settings that still
  expose technical concepts.
- **Missing affordances:** portable guided credential setup for every adapter
  and a first-run workflow that proves value immediately.
- **Manifesto fit:** currently the strongest non-technical path, but
  Claude-specific.

### Technical user using a terminal, Claude Code, Codex, or another client

- **Entry point:** npm, GitHub, or direct MCP discovery.
- **Setup path:** `npx affiliate-networks-mcp setup`, `test`, then host
  registration.
- **First aha moment:** direct multi-network queries, packaged skills where
  supported, or custom automation through the local MCP server.
- **Friction:** client-specific configuration, undocumented Cursor/VS Code
  paths, no MCP Registry metadata, and skills that do not have a proven
  cross-host packaging contract.
- **Missing affordances:** a generic local MCP guide, tested client matrix, and
  machine-readable distribution metadata.
- **Manifesto fit:** strong at the server/tool layer; inconsistent at the
  installation and workflow-packaging layers.

## 4. Installer and onboarding strategy

### Assessment

The project should support two user-facing onboarding tracks, not market every
mechanism as a separate product path.

#### Track A: non-technical

1. Install the Claude Desktop `.mcpb`.
2. Complete host-native credential fields where available.
3. Use a future portable, loopback-only browser setup flow for all remaining
   networks.
4. Run a guided first workflow.

Claude Desktop is the strongest current non-technical path because it can own
installation, runtime, permissions, and secret handling. It should be described
as the easiest path today, not as the limit of the product vision.

#### Track B: technical and semi-technical

1. Run `npx affiliate-networks-mcp setup`.
2. Run `npx affiliate-networks-mcp test`.
3. Connect through a host-native plugin, the CLI installer, or a documented
   generic stdio MCP configuration.

The CLI should remain the complete setup and diagnostic path. It is also the
fallback when a host-native package cannot collect every network credential.

### Setup-path decisions

- **Primary non-technical path:** Claude Desktop `.mcpb`.
- **Primary technical path:** CLI setup plus host-native/config installation.
- **Secondary path:** documented generic local stdio MCP configuration.
- **Actively supported product tracks:** two. Host-specific instructions sit
  under those tracks rather than becoming separate product propositions.

### macOS DMG and Electron app

The accepted host-native distribution decision already places the Electron app
in compatibility-fallback status. That remains correct.

The DMG solves two problems that `.mcpb` does not yet solve completely:

- a non-terminal credential UI for every adapter;
- a bundled runtime and direct Claude Desktop config path independent of
  host-native extension capabilities.

Those benefits are outweighed over time by:

- signing, notarisation, auto-update, Electron, packaging, and security
  maintenance;
- a Claude-only setup application inside an AI-of-choice product;
- user confusion about whether the app is the product, an installer, or a
  required runtime;
- duplicated setup and client-connection logic.

**Recommendation:** keep the DMG available and fixes-only while the `.mcpb`
path proves stable and portable setup is built. Remove it from primary
messaging. Retire it when `.mcpb` plus portable setup covers its successful
journeys, with a documented migration path for existing users.

## 5. MCP versus skills strategy

### Definition

- **MCP tool:** one typed, auditable affiliate operation with explicit inputs,
  outputs, capability truth, and errors. It belongs in the provider-neutral
  contract when multiple networks share its semantics, or as a deliberately
  network-specific tool when the capability is valuable and cannot yet be
  generalised.
- **Skill:** a reusable customer workflow that orchestrates tools and reasoning
  to produce an affiliate outcome, such as an earnings report, unpaid
  commission chase, publisher review, or QBR.
- **Adapter:** the network-specific implementation of the typed operation,
  including auth, API quirks, normalisation, and known limitations.
- **Documentation:** setup guidance, capability truth, manual fallbacks, and
  explanations that do not need model-executable workflow instructions.

### Current assessment

Skills are valuable and shipped, but not yet fully first-class across the
product:

- Claude Code plugin packaging discovers them directly.
- Other clients may expose the MCP tools without loading the packaged skills.
- Tests strongly validate skill presence and agency skill tool names, but they
  do not validate complete workflow semantics or every publisher skill's cited
  tool names.
- MCP prompts overlap with skills, especially around Awin workflows.
- The setup-help skill has hand-written quick references for four launch
  networks, while the rest of the adapter registry relies on generated setup
  steps and per-network docs.
- The earnings-report example cites `affiliate_<network>_earnings_summary`,
  while generated canonical tool names use `get_earnings_summary`.

### Rule for contributors

1. Start with a named affiliate job-to-be-done.
2. If the missing capability is an atomic operation shared by at least two
   real network implementations, propose a provider-neutral tool-contract
   decision.
3. If the operation is network-specific and proven valuable, keep it inside
   that network and document why it is exceptional.
4. If existing tools can complete the job, add or extend a skill rather than a
   tool.
5. If the need is setup guidance, capability truth, or a manual step, improve
   documentation rather than creating an executable surface.
6. Do not duplicate one workflow across a skill, MCP prompt, and example unless
   each serves a named client compatibility need and shares a tested source of
   truth.

### Workflow opportunity

Public affiliate APIs block some high-value work: writes, partner outreach
delivery, dashboard-only reports, validation actions, and some detailed
tracking checks. The current MCP layer can still support high-value workflows:

- cross-network publisher earnings and unpaid commission operations;
- brand and agency reporting, anomaly triage, and QBR preparation;
- partner performance reviews and reactivation worklists;
- reversal and pending-transaction investigations;
- capability-aware setup and health checks;
- advisory client strategy and KPI context;
- evidence-backed drafts and action plans that leave final execution to the
  operator.

## 6. AI-of-choice roadmap

The manifesto should mean portable data and workflow capability, not identical
installation UX on every host.

| Platform | Current state | Assessment and path |
| --- | --- | --- |
| Claude Desktop | Works today | Strongest non-technical path through `.mcpb`; full-network credential setup still needs a portable flow |
| Claude Code | Works today | Plugin installs MCP plus skills; strong technical and workflow path |
| Claude Cowork / organisation flows | Possible but awkward | Private mirror and org-admin steps work, but support burden and lifecycle are high |
| Codex | Works today | Local stdio MCP works through CLI and IDE config; packaged skill parity is not proven |
| Generic local MCP clients | Possible with clear path | Server already uses stdio; needs a concise, tested generic setup guide |
| VS Code / Copilot-style environments | Possible with clear path | VS Code supports local and remote MCP surfaces; the repo needs first-party setup and compatibility proof |
| Cursor | Possible with clear path | Generic MCP support makes local stdio plausible; the repo needs verified instructions and workflow expectations |
| ChatGPT | Possible but awkward | Requires reachable HTTPS MCP, authentication, lifecycle management, and clear disclosure that tool traffic leaves the local machine |
| OpenAI API remote MCP tools | Possible with clear path | Requires a remote HTTPS MCP deployment and a deliberate auth/security model |
| Other agent surfaces | Possible with clear path | Support when they can consume the stable MCP contract; document tested status instead of claiming generic parity |

### ChatGPT and remote OpenAI surfaces

Local stdio MCP support in Codex is not ChatGPT connector support. A credible
ChatGPT path needs:

- a reachable HTTPS Streamable HTTP MCP endpoint;
- authentication and token lifecycle;
- explicit user consent for remote tool-call traffic;
- stable lifecycle and failure recovery;
- clear separation between a local quick-tunnel experiment and a dependable
  managed product;
- a decision on whether credentials remain local behind a tunnel or are stored
  in a hosted service;
- security, audit, privacy, abuse, and support ownership.

The current quick-tunnel proposal is useful design input, but it should not be
treated as an already accepted production direction.

### Meaning over time

- **Next three months:** portable local stdio MCP, host-native distribution
  where available, and tested setup for Claude Desktop, Claude Code, Codex, VS
  Code, and generic MCP clients.
- **Next twelve months:** a deliberate remote HTTPS MCP option for ChatGPT and
  managed/team use cases, while local-first remains the default and complete
  open-source path.

## 7. Architecture review

### What is coherent

- [`src/shared/types.ts`](../../src/shared/types.ts) provides a clear,
  provider-neutral domain contract and an escape hatch for raw network data.
- The adapter boundary is consistent: auth, client, adapter, setup, manifest,
  docs, fixtures, and tests.
- Error envelopes, resilience, logging, credential loading, cache policy, and
  brand resolution are centralised.
- Tool generation prevents every network from inventing an unrelated public
  surface.
- Advertiser brand context is resolved before adapter calls and participates in
  cache identity.
- The delivery system in `AGENTS.md` and `.claude/skills/` is unusually clear
  about ownership, decisions, review, and small coherent outcomes.
- The test suite is extensive. At the 2026-06-15 assessment baseline, 3,465
  tests passed; CI also verifies the timezone-sensitive Admitad and Monetizze
  suites under UTC and `Europe/Paris`.

### Where coherence is weakening

#### Adapter breadth and file size

The 86 adapter implementations total more than 75,000 lines. Several reference
and mature adapters exceed 1,000 lines. This is not automatically spaghetti,
but it raises the cost of applying fixes, reviewing consistency, and verifying
shared assumptions.

The correct response is not a broad abstraction rewrite. First identify
demonstrated duplication and bug classes across multiple adapters, then extract
small shared primitives behind focused decisions.

#### Metadata duplication

Each `network.json` uses snake-case metadata such as `claim_status` and
`credential_scope`, while each adapter also constructs camel-case runtime
metadata such as `claimStatus` and `credentialScope`. Drift is possible because
both are maintained manually.

#### Registration and exceptional tools

Every adapter self-registers on import, while
[`src/networks/index.ts`](../../src/networks/index.ts) manually imports every
adapter. This is simple but increasingly fragile at 86 adapters. Awin and
Tradedoubler are explicitly special-cased in the generic tool generator for
custom tools, creating another manual extension list.

#### Version drift

At inspection time:

- npm package: `0.7.1`;
- telemetry package version: `0.7.1`;
- Claude plugin: `0.6.6`;
- MCP server identity: `0.1.0`;
- Electron app: `0.1.1`.

Some differences may be intentional, but the release contract is not obvious
and drift can mislead support, telemetry, and client UIs.

#### Skills, prompts, and examples

The repo tests that shipped skills exist and that agency skills cite real
tools. It does not yet provide one semantic contract test that verifies every
shipped workflow, prompt, and example against the generated tool registry and
current capability model.

#### Client-specific logic

Core domain behaviour is mostly client-neutral. Installation logic is
appropriately host-specific, but onboarding copy and setup flow are becoming
coupled to a growing list of clients. New clients should use thin installer or
documentation layers rather than branch domain behaviour.

#### Test portability

The initial assessment reproduced two timezone-dependent failures in Admitad
and Monetizze date parsing under `Europe/Paris`. PR
[#202](https://github.com/bobberrisford/affiliatemcp/pull/202) resolved the
defect, documented the remaining uncertainty about upstream timezone semantics,
and added UTC and `Europe/Paris` CI proof. That proof should remain part of the
release baseline.

### Architecture recommendation

Freeze speculative breadth temporarily. Standardise verification, metadata,
versioning, workflow contracts, and client compatibility before adding more
networks or AI clients. Use small decision-first changes for public or shared
contracts, not a general refactor.

## 8. Privacy-first telemetry

### Current promise

The shipped promise is:

- runtime telemetry is off by default and explicitly opt-in;
- credentials and affiliate data remain local;
- at most one aggregate summary per active day is sent;
- payloads contain a rotating random identifier, package version, launch
  surface, and counts by network, operation, and coarse outcome;
- no prompts, arguments, results, amounts, URLs, error text, account IDs, or
  exact timestamps are sent.

Consent is explicit enough for the current CLI and host-managed setting model,
provided every host preserves the same off-by-default contract and makes an
environment override visible.

### Consistency issues to resolve

- The accepted decision permits a coarse OS family; the shipped privacy policy
  says operating system is never collected.
- The accepted decision names client types; the implementation records a
  smaller launch-surface taxonomy.
- The manifesto still contains historical "no phone home" language that can be
  read as conflicting with opt-in telemetry.
- A first-party ingestion service is now part of the operational product and
  needs the same release, access, retention, and incident discipline as the
  client.

### Acceptable high-level taxonomy

| Category | Acceptable events or dimensions |
| --- | --- |
| Lifecycle | server start, setup complete, client install complete |
| Adoption | coarse launch surface, package version, opted-in active day |
| Network usage | configured or exercised network slug, aggregated |
| Operation usage | canonical operation name or approved network-specific operation, aggregated |
| Health | success, auth error, rate limit, config error, upstream error, other error |
| Setup health | coarse completion or failure stage with no entered values or error text |

### Never collect

- credentials, tokens, secrets, cookies, or auth headers;
- affiliate records, raw network data, amounts, commissions, or transaction
  details;
- account, publisher, advertiser, brand, programme, order, or transaction IDs;
- publisher names, brand names, programme names, or client names;
- prompts, skill inputs, tool arguments, tool results, free text, or error
  messages;
- URLs, file paths, exact timestamps, locale, or machine-derived identifiers;
- cross-month identifiers or any stable identifier derived from a user,
  account, machine, or credential.

### Recommendation

Keep telemetry narrow and operational. Use it to decide which adapters and
operations deserve verification and repair, not to profile affiliate
businesses. Any taxonomy expansion requires a decision record, privacy-policy
update, allowlist tests, retention review, and host-consent review before
implementation.

## 9. Product roadmap

### Now: cleanup and clarity

| Item | Description and why it matters | Who it serves | Product impact | Complexity | Risk | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Canonical product story | Reconcile README, package, website, and product-doc claims around local-first, supported clients, and verified versus experimental networks | Everyone | High | Low | Low | Must-have |
| Verified-outcome scorecard | After adapter promotion gates are accepted, track verified networks, successful setup journeys, and workflow coverage instead of leading with adapter count | Users, maintainers, networks | High | Medium | Medium | Must-have |
| Workflow contract audit | Repair stale skills, prompts, and examples and define ownership between them | Publishers, agencies, client users | High | Medium | Low | Must-have |
| Two-track onboarding | Present one non-technical and one technical setup journey | New users, support | High | Low | Low | Must-have |
| Maintain green release baseline | Keep timezone and platform portability proof in release checks | Maintainers, contributors | Medium | Low | Low | Must-have |

### Next: adoption and useful workflows

| Item | Description and why it matters | Who it serves | Product impact | Complexity | Risk | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Portable credential setup | Cover every adapter without requiring terminal use while preserving local credential handling | Non-technical users | High | High | High | Must-have |
| Guided first value | After setup, launch a capability-aware earnings, status, or programme report | New users | High | Medium | Low | Must-have |
| Workflow packs by persona | Strengthen publisher and agency packs around a small number of verified, repeatable outcomes | Publishers, agencies | High | Medium | Medium | Should-have |
| Network verification programme | Give networks and credentialed users a clear route to promote adapters | Users, network contributors | High | Medium | Medium | Must-have |
| Tested local client matrix | Document and verify Claude, Codex, VS Code, Cursor, and generic MCP setup | Technical users | Medium | Medium | Medium | Should-have |
| Agency strategy context hardening | Expand and test the shipped local client strategy and KPI context across more reporting workflows | Agencies | Medium | Medium | Medium | Should-have |

### Later: platform expansion and monetisation

| Item | Description and why it matters | Who it serves | Product impact | Complexity | Risk | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Secure remote HTTPS MCP | Enable ChatGPT and managed deployments without replacing local-first | ChatGPT users, teams | High | High | High | Experimental |
| Team and agency management | Shared deployment, policy, audit, and client configuration | Agencies, enterprises | High | High | High | Experimental |
| Certified adapters | Formal verification and ownership with affiliate networks | Users, networks | High | Medium | Medium | Should-have |
| Premium workflow services | Managed or specialised workflow packs built on the open core | Agencies, brands | Medium | Medium | Medium | Experimental |
| Bounded actions | Implement only after accepted write, authority, consent, and audit foundations are proven | Brands, agencies | Medium | High | High | Experimental |

## 10. Technical roadmap

### Sequence 1: establish a trustworthy baseline

1. Maintain the green timezone-independent baseline and broaden portability
   proof when a demonstrated failure class justifies it.
2. Add semantic validation for every shipped skill, MCP prompt, and example.
3. Define adapter promotion and live-verification evidence.
4. Reconcile product, package, plugin, server, and telemetry version sources.
5. Add release checks for generated-document and client-metadata drift.

### Sequence 2: simplify extension points

1. Make `network.json` the candidate source of truth for static adapter
   metadata, subject to a decision on runtime loading or generation.
2. Generate or validate the adapter registration index rather than relying on
   an unchecked manual import list.
3. Define a reviewed extension mechanism for exceptional network-specific
   tools.
4. Extract only proven cross-adapter helpers that remove a demonstrated bug
   class.
5. Keep provider-neutral contracts in shared core and client-specific
   installation in thin host modules.

### Sequence 3: improve setup and packaging

1. Document the two onboarding tracks.
2. Build the accepted loopback-only portable setup flow after its security
   boundary is reviewed.
3. Keep `.mcpb`, Claude Code plugin, and local stdio config as host-native
   wrappers around the same server and config system.
4. Define DMG retirement acceptance criteria and migration.
5. Publish standard MCP Registry metadata.

### Sequence 4: prove AI-client portability

1. Define a client compatibility matrix covering tools, prompts, skills,
   resources, auth/setup, and transport.
2. Add tested setup docs for VS Code and generic MCP clients.
3. Verify Cursor setup and state its actual workflow-packaging limits.
4. Decide how workflow packs are distributed when a host does not consume
   Claude-style skills.
5. Keep ChatGPT remote HTTPS support as a separate decision and transport.

### Sequence 5: telemetry and remote readiness

1. Reconcile the telemetry decision, privacy policy, schema, dashboard, and
   operations.
2. Add allowlist and consent-contract tests across every distribution surface.
3. Define operational ownership, retention, access, incident handling, and
   deletion for ingestion.
4. Only then evaluate remote HTTPS MCP auth, audit, and hosting options.

### Testing strategy

- Keep fixture-based adapter tests as the default.
- Add timezone and platform matrix coverage for portable parsing and config.
- Add generated-registry and metadata-drift checks.
- Add workflow contract tests against the real tool registry.
- Add install-path tests per supported client.
- Define live acceptance evidence separately from CI; never require public CI
  to hold real affiliate credentials.

### Contribution workflow

- Use the existing `delivery-steward` workflow for each roadmap outcome.
- Keep one coherent user outcome per PR.
- Use decision-first PRs for shared/public contracts, privacy, security,
  deployment, and cross-client architecture.
- Keep only one risk-based PR actively awaiting deliberate maintainer review.
- Rob is the current maintainer decision owner across affiliate-domain truth,
  customer journeys, architecture, privacy, security, deployment, and
  cross-client trade-offs. Use independent agent review as the default backstop
  for Rob-authored risk PRs, and use CODEOWNER or contributor review when a
  separate owner exists.

## 11. Monetisation options

The open-source local server and essential workflow layer should remain
complete and useful. Monetisation should charge for operation, assurance,
collaboration, or specialised service, not for unlocking a user's own data.

| Option | Who pays and what for | Why open source still makes sense | Trust risks | Prerequisites | Horizon |
| --- | --- | --- | --- | --- | --- |
| Support contracts | Agencies, brands, and networks pay for response times, integration help, and maintenance | Core remains inspectable and self-service | Support may distort roadmap toward a few customers | Stable support policy and verified baseline | Near-term |
| Managed agency setup | Agencies pay for credential onboarding, brand mapping, workflow configuration, and training | Users can still do it themselves | Handling customer environments or credentials carelessly | Clear access boundaries and runbooks | Near-term |
| Network-certified adapter services | Networks pay for verification work, maintenance, compatibility testing, or certification without payment affecting reliability claims | Adapter code and evidence remain public | Pay-to-play perception or misleading certification | Accepted promotion criteria and independence rules; focused commercial decision | Mid-term |
| Premium packaged skills | Agencies or brands pay for specialised workflow packs, templates, or maintained vertical expertise | Open core tools and essential workflows remain available | Artificially withholding basic workflows | Portable packaging and clear value boundary | Mid-term |
| Hosted remote MCP gateway | Teams pay for stable HTTPS access, auth, uptime, audit, and operations | Local deployment remains free and complete | Credentials/data leave local machine; high security burden | Remote architecture, auth, audit, compliance, operations | Mid-term |
| Team or organisation layer | Agencies and enterprises pay for shared config, policy, roles, audit, and deployment | Individual local use remains open | Centralisation can weaken local-first promise | Identity, tenancy, policy, audit, secure secret handling | Mid-term |
| Analytics dashboards | Teams pay for durable operational views and collaboration | Dashboard consumes the open data layer | Product may drift into generic BI; hosted data risk | Clear customer need, storage and privacy model | Long-term |
| Affiliate-network partnerships | Networks fund adapters, workflows, or ecosystem adoption | Public adapter benefits every user | Independence and ranking bias | Transparent sponsorship and claims policy | Mid-term |
| Privacy-preserving benchmarking | Participants pay for aggregate reliability or ecosystem benchmarks | Methodology and collection contract can be public | Re-identification and trust damage | Separate explicit consent, aggregation thresholds, privacy review | Long-term |
| Cloud config sync | Teams pay for safe config portability | Local config remains supported | Secret leakage and account compromise | Encryption, identity, recovery, threat model | Long-term |
| Enterprise version | Enterprises pay for deployment, policy, support, and compliance | Open core remains the technical foundation | Feature fragmentation and open-core resentment | Proven enterprise demand and clean product boundary | Long-term |

**Recommended monetisation order:** support contracts and managed agency setup
first. These monetise expertise without changing the privacy model.
Network-certified adapter services may follow only after accepted promotion
gates and a focused commercial decision preserve the independence of
reliability claims. A hosted remote gateway or team layer can follow only after
explicit demand and a reviewed security architecture.

## 12. Recommended decisions (advisory until recorded)

1. **Primary install path:** Claude Desktop `.mcpb` for non-technical users.
2. **Secondary install path:** `npx affiliate-networks-mcp setup`, then
   host-native or generic local stdio MCP configuration.
3. **macOS DMG/app installer:** keep as a fixes-only compatibility fallback;
   remove from primary messaging and retire after `.mcpb` plus portable setup
   reaches journey parity.
4. **MCP versus skills:** tools are typed atomic operations; skills are
   persona-centred workflows that orchestrate tools into outcomes.
5. **AI of choice in the next three months:** tested portable local MCP across
   Claude Desktop, Claude Code, Codex, VS Code, and generic MCP clients.
6. **AI of choice in the next twelve months:** pursue an optional, secure remote
   HTTPS MCP path for ChatGPT and managed use only if demand and a reviewed
   security architecture justify it, while keeping local-first complete.
7. **Do not build yet:** more speculative adapters, broad autonomous writes,
   general browser automation, rich dashboards, or hosted credential storage.
8. **Before adding more networks:** standardise verification evidence,
   promotion gates, metadata ownership, registration checks, live-proof
   expectations, and workflow relevance.
9. **Before adding more AI clients:** standardise the client compatibility
   matrix, generic setup contract, workflow packaging expectations, versioning,
   and support ownership.
10. **Before expanding telemetry:** standardise one taxonomy, one consent
    contract, one allowlist, retention/access operations, and privacy-policy
    review.

These are roadmap recommendations. Decision-first items become binding only
after focused records are accepted under [`../decisions/`](../decisions).

## 13. Proposed GitHub issues and work packages

Each package is one reviewable user outcome. Decision-first packages begin
with a small decision PR; dependent implementation remains draft. Sequence
risk-based work so only one PR actively awaits maintainer review.

### 1. P0: Establish the roadmap as canonical and reconcile product claims

- **Customer outcome:** users understand what works today, who it serves, and
  which clients and adapters are verified.
- **Problem:** README, package metadata, website copy, and product docs make
  overlapping client and maturity claims.
- **Proposed scope:** make this roadmap canonical; audit public claims; align
  local-first, client support, adapter maturity, and onboarding language.
- **Out of scope:** runtime changes, adapter verification, installer changes.
- **Owning layer:** product documentation.
- **Dependencies:** this roadmap.
- **Risks:** removing useful nuance or making the product sound narrower than
  its direction.
- **Acceptance criteria:** every public claim distinguishes shipped,
  experimental, and planned support; older roadmap docs have explicit status.
- **Decision-first:** no, unless the claim audit surfaces a disputed product
  direction.
- **Suggested owner type:** product and docs; Rob leads product truth.

### 2. P0: Maintain a green, timezone-independent release baseline

- **Status:** completed foundation via issue
  [#200](https://github.com/bobberrisford/affiliatemcp/issues/200) and PR
  [#202](https://github.com/bobberrisford/affiliatemcp/pull/202); retain as a
  release requirement.

- **Customer outcome:** releases behave consistently regardless of maintainer
  or user timezone.
- **Problem:** the initial assessment found Admitad and Monetizze date tests
  failing under `Europe/Paris`; that defect is resolved, but the portability
  proof must not regress.
- **Proposed scope:** retain the focused timezone-matrix proof and apply the
  same approach when another demonstrated portability defect appears.
- **Out of scope:** broad adapter refactors or unrelated flaky tests.
- **Owning layer:** affected adapters and CI.
- **Dependencies:** none.
- **Risks:** losing focused CI proof or incorrectly assuming upstream timezone
  semantics.
- **Acceptance criteria:** `npm run verify` passes in UTC and a non-UTC
  timezone; findings or limitations state any remaining upstream ambiguity.
- **Decision-first:** no, unless fixing it requires changing canonical date
  semantics.
- **Suggested owner type:** technical; Rob confirms affiliate-network truth
  where evidence is ambiguous.

### 3. P0: Define adapter verification and promotion gates

- **Customer outcome:** users can tell which integrations are trustworthy for
  real work.
- **Problem:** 82 adapters are experimental and there is no concise,
  customer-facing promotion standard.
- **Proposed scope:** define evidence required for experimental, partial, and
  production; define expiration or freshness of live verification; define how
  network adoption affects claims.
- **Out of scope:** verifying every adapter in one issue.
- **Owning layer:** product governance and contribution workflow.
- **Dependencies:** roadmap claim reconciliation. The verified-outcome
  scorecard remains blocked until this decision is accepted.
- **Risks:** standards that are impossible for community contributors or too
  weak to build trust.
- **Acceptance criteria:** a maintainer and contributor can consistently decide
  an adapter status; public docs explain the statuses.
- **Decision-first:** yes, because claim status is a cross-network public
  contract.
- **Suggested owner type:** product and technical; Rob leads domain evidence
  and contract implications, with independent agent review for the decision.

### 4. P0: Audit shipped skills, prompts, and examples against actual tools and journeys

- **Customer outcome:** packaged workflows call real tools and reflect current
  network support.
- **Problem:** stale setup-help assumptions and tool names exist; prompts,
  skills, and examples overlap.
- **Proposed scope:** repair known drift; validate every cited concrete tool;
  identify duplicates; assign each workflow a customer journey and supported
  host expectation.
- **Out of scope:** new tools or new workflow packs.
- **Owning layer:** skills, prompts, examples, and workflow tests.
- **Dependencies:** none.
- **Risks:** changing user-visible workflow behaviour without preserving useful
  intent.
- **Acceptance criteria:** all concrete tool references resolve; every shipped
  workflow states capabilities and gaps; semantic tests cover the shipped set.
- **Decision-first:** no, unless resolving overlap changes the public MCP
  prompt or workflow-packaging strategy.
- **Suggested owner type:** product, technical, and docs.

### 5. P0: Simplify onboarding into non-technical and technical tracks

- **Customer outcome:** a new user can choose a setup path without
  understanding installers or MCP transports.
- **Problem:** several overlapping paths are presented as peers.
- **Proposed scope:** rewrite onboarding around two tracks; keep host-specific
  details under each; add a clear first-value prompt.
- **Out of scope:** building portable setup or removing an installer.
- **Owning layer:** README, website, and setup documentation.
- **Dependencies:** public-claim reconciliation.
- **Risks:** hiding necessary fallback paths.
- **Acceptance criteria:** one primary non-technical journey and one primary
  technical journey are obvious; fallback details remain findable.
- **Decision-first:** no, because host-native distribution is already accepted.
- **Suggested owner type:** product and docs; Rob leads journey clarity.

### 6. P1: Define portable credential setup and DMG retirement criteria

- **Customer outcome:** non-technical users can configure any supported network
  without a terminal.
- **Problem:** `.mcpb` rich setup fields cover four networks; the Electron app
  duplicates product surface.
- **Proposed scope:** decide portable setup security and UX contract; define
  exact DMG journey-parity and retirement gates.
- **Out of scope:** implementation in the decision PR and unrelated installer
  changes.
- **Owning layer:** setup architecture and distribution.
- **Dependencies:** two-track onboarding.
- **Risks:** local credential-write security, browser attack surface, and
  disruption to existing DMG users.
- **Acceptance criteria:** accepted decision covers threat model, consent,
  lifecycle, supported platforms, migration, and retirement criteria.
- **Decision-first:** yes.
- **Suggested owner type:** technical and product; Rob leads security,
  architecture, and non-technical journey trade-offs, with independent agent
  review before acceptance.

### 7. P1: Standardise adapter metadata, registry generation, and version propagation

- **Customer outcome:** capability, version, and support information stays
  accurate across runtime, docs, packages, and clients.
- **Problem:** metadata and registration are manually duplicated; versions
  drift across surfaces.
- **Proposed scope:** choose sources of truth and generation/validation
  boundaries; implement in small follow-up PRs.
- **Out of scope:** rewriting adapter implementations.
- **Owning layer:** build, registry, metadata, and release architecture.
- **Dependencies:** adapter verification gates.
- **Risks:** shared-contract changes and release breakage across 86 adapters.
- **Acceptance criteria:** one documented source exists for each metadata
  class; CI detects drift; adding an adapter has fewer unchecked manual steps.
- **Decision-first:** yes.
- **Suggested owner type:** technical; Rob leads, with independent agent review
  for metadata and release-surface implications.

### 8. P1: Publish MCP Registry metadata and document VS Code and generic MCP setup

- **Customer outcome:** technical users can discover and connect affiliate-mcp
  outside Claude and Codex.
- **Problem:** standard MCP Registry metadata and tested generic setup docs are
  absent.
- **Proposed scope:** publish metadata; document and verify VS Code and generic
  local stdio setup; record tested versions and limitations.
- **Out of scope:** remote HTTP MCP and packaged workflow parity.
- **Owning layer:** distribution metadata and docs.
- **Dependencies:** version/metadata direction where required.
- **Risks:** claiming client support that has not been tested.
- **Acceptance criteria:** registry listing is valid; setup is manually proven;
  docs classify actual support.
- **Decision-first:** no, unless registry packaging requires a cross-client
  architecture choice.
- **Suggested owner type:** technical and docs; contributor-friendly after
  metadata direction is settled.

### 9. P1: Define cross-host workflow packaging and compatibility testing

- **Customer outcome:** users get useful affiliate workflows, not only raw
  tools, in their chosen AI client.
- **Problem:** Claude-style skills, MCP prompts, and host support are not
  equivalent.
- **Proposed scope:** define portable workflow source, host-specific wrappers,
  supported capabilities, and compatibility tests.
- **Out of scope:** rewriting all skills or promising identical behaviour.
- **Owning layer:** workflow packaging and cross-client architecture.
- **Dependencies:** workflow contract audit and tested client matrix.
- **Risks:** duplicated workflows, lowest-common-denominator design, or
  host-specific behaviour leaking into core.
- **Acceptance criteria:** accepted strategy states what is portable, what is
  host-specific, and how every shipped pack is tested.
- **Decision-first:** yes.
- **Suggested owner type:** product and technical; Rob leads architecture and
  workflow value, with independent agent review for cross-host compatibility.

### 10. P1: Reconcile telemetry consent, taxonomy, policy, and ingestion operations

- **Customer outcome:** opted-in users can trust exactly what is collected and
  how it is operated.
- **Problem:** accepted decision, privacy policy, implementation taxonomy, and
  ingestion operations have small but material differences.
- **Proposed scope:** choose one taxonomy; reconcile docs and code in sequenced
  follow-ups; define retention, access, incident, and deletion operations.
- **Out of scope:** richer product analytics or any affiliate-data collection.
- **Owning layer:** privacy, shared telemetry contract, and ingestion service.
- **Dependencies:** none, but it should be the only active risk-based PR while
  reviewed.
- **Risks:** loss of user trust, privacy-policy mismatch, and accidental scope
  expansion.
- **Acceptance criteria:** one allowlist and consent contract matches policy,
  implementation, tests, and operations.
- **Decision-first:** yes.
- **Suggested owner type:** technical and product; Rob leads privacy and
  architecture, with independent agent review for consent and ingestion risk.

### 11. P2: Choose a secure remote HTTPS MCP path for ChatGPT and managed deployments

- **Customer outcome:** ChatGPT and team users can access affiliate-mcp through
  a dependable, honestly described remote path.
- **Problem:** ChatGPT cannot consume the local stdio server directly.
- **Proposed scope:** compare local tunnel, user-owned deployment, and managed
  gateway options; decide auth, credential location, consent, audit, lifecycle,
  support, and privacy boundaries.
- **Out of scope:** implementation, Deep Research retrieval tools, and hosted
  credential storage without an accepted design.
- **Owning layer:** remote transport and deployment architecture.
- **Dependencies:** local client portability, telemetry/privacy reconciliation,
  and clear product demand.
- **Risks:** credentials or affiliate data leaving the machine, unstable
  lifecycle, abuse, and operational burden.
- **Acceptance criteria:** accepted decision selects an MVP boundary and names
  rejected alternatives, threat model, and local-first implications.
- **Decision-first:** yes.
- **Suggested owner type:** technical and product; Rob leads architecture,
  security, and customer-demand validation, with independent agent review for
  threat-model gaps.

### 12. P2: Validate monetisation through agency support and network-certified adapters

- **Customer outcome:** agencies and networks can pay for assurance and service
  without weakening the open local product.
- **Problem:** monetisation options are broad and unvalidated.
- **Proposed scope:** run small discovery and service pilots for managed agency
  setup, support, and certified adapters; document willingness to pay and trust
  concerns.
- **Out of scope:** feature gates, enterprise forks, hosted credential storage,
  or premiumising essential workflows.
- **Owning layer:** product and commercial discovery.
- **Dependencies:** accepted adapter verification gates, clear onboarding, and
  a focused decision preserving the independence of reliability claims before
  any paid certification product launches.
- **Risks:** pay-to-play trust, roadmap distortion, and support commitments
  exceeding maintainer capacity.
- **Acceptance criteria:** evidence identifies who pays, for what, at what
  support burden, and with what open-source boundary.
- **Decision-first:** no for discovery; yes before introducing a paid product
  or licensing boundary.
- **Suggested owner type:** product; Rob leads customer and industry discovery
  and records technical prerequisites before any paid product boundary.
