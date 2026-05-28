# Roadmap

> A to-do list. Each item has a build prompt underneath it — paste
> the prompt into Claude Code (or an equivalent agent) inside this
> repo to start the work. UK English throughout. Status of the
> shipping adapters lives in [`REPORT.md`](../../REPORT.md);
> architectural rationale lives in
> [`ai-native-affiliate-data.md`](./ai-native-affiliate-data.md).

The list is shaped by two questions:

1. **Can someone get this running in five minutes without help?**
2. **Once running, does it cover what an affiliate manager actually
   does on a Monday morning?**

If you pick something up, open an issue first and link the PR to it
so two contributors don't duplicate the work.

## Onboarding — make it easy to start

- [ ] **`install` subcommand that writes the Claude Desktop config in place.**
  Wraps the manual JSON edit step at the end of setup. Detects which
  MCP-capable clients are installed (Claude Desktop, Claude Code,
  Cursor, Codex, VS Code MCP) and offers to wire each one up.

  > Add an `install` subcommand to `affiliate-networks-mcp` (entry
  > point `src/index.ts`, sibling to `setup`, `test`, `doctor`).
  > Implement it under `src/cli/install.ts`. It must:
  > (1) detect each MCP-capable client installed on the host —
  > Claude Desktop config path varies by OS (see
  > `examples/claude-desktop-config.md` for locations), Claude Code
  > uses `~/.claude/settings.json`, Cursor uses
  > `~/.cursor/mcp.json`, Codex CLI uses its own config — and
  > report which it found;
  > (2) for each detected client, show the JSON block it will add
  > and ask for confirmation before writing;
  > (3) write the block atomically (read existing JSON, merge,
  > write to a temp file, rename);
  > (4) verify by re-reading the file and asserting the block
  > round-trips;
  > (5) print the exact phrase the user should type into the client
  > to confirm wiring ("list my affiliate networks").
  > Tests in `tests/cli/install.test.ts` mirroring the style of
  > `tests/cli/setup.test.ts`. No new dependencies — use Node's
  > `fs/promises`. UK English in all user-facing strings.

- [ ] **`doctor` self-fix mode.**
  Today `doctor` reports failures and exits. The shape of every
  common failure is already known — trailing whitespace in a token,
  expired bearer, missing `EBAY_MARKETPLACE_ID` on a US account —
  so it should offer to fix them inline.

  > Extend `src/cli/doctor.ts` with a `--fix` flag. Walk every
  > failure that the existing diagnostic surfaces and, for each one
  > whose remediation is mechanical, prompt the user with the
  > proposed fix and apply it on confirmation. Start with:
  > (a) trailing whitespace / newline in any env value at
  > `~/.affiliate-mcp/.env` — strip and rewrite;
  > (b) expired Rakuten bearer — force a token refresh via
  > `src/networks/rakuten/auth.ts._resetTokenCache` and re-test;
  > (c) missing `EBAY_MARKETPLACE_ID` on a credential whose
  > `verifyAuth` 4xx body mentions marketplace — prompt for the
  > value, default `EBAY_GB`, write to env;
  > (d) `~/.affiliate-mcp/.env` mode not `0600` — re-chmod.
  > Each fix runs through the existing `envfile` helpers in
  > `src/cli/wizard/envfile.ts`; never write env state outside that
  > module. Add tests in `tests/cli/doctor.test.ts` with fixture
  > env files; no live API calls.

- [ ] **"Did you mean…" credential hints in the setup wizard.**
  The single biggest setup-time failure is pasting the wrong field
  from the dashboard. Recognise the shape of common mispastes per
  network and say so before validation.

  > Add a per-network `recognise(input: string): MispasteHint | null`
  > helper to each adapter's `setup` brief (see how `setupBrief`
  > works in `src/networks/awin/setup.ts`). The helper inspects a
  > pasted credential value and, where the shape matches a known
  > *other* field on the same network, returns a hint like
  > `"that looks like an Impact Account SID, not the Auth Token —
  > the Auth Token is the field immediately below it on the API
  > Settings page"`. Wire it into `src/cli/wizard/prompts.ts` so the
  > hint appears *before* the live validation call (saves a round-
  > trip). Cover the three highest-frequency mispastes per network:
  > Awin (publisher ID into token slot), CJ (company ID into token
  > slot), Impact (SID into auth-token slot, vice versa), Rakuten
  > (client ID into client secret), eBay (App ID into Cert ID).
  > Tests in `tests/cli/wizard/recognise.test.ts` per network.

- [ ] **MCPB / `.dxt` bundle.**
  The Node-install step is the single biggest non-affiliate
  barrier. Packaging as an MCP bundle collapses install to a
  double-click.

  > Produce an MCP bundle (`.dxt`) for `affiliate-networks-mcp` per
  > the MCP project's bundling guidance
  > (https://modelcontextprotocol.io/docs/develop/build-with-agent-skills
  > and the bundle spec linked from there). The bundle should
  > include the compiled `dist/` output and a pinned Node runtime;
  > on first run it must still write to
  > `~/.affiliate-mcp/.env` so credential storage is unchanged.
  > Add a `npm run bundle` script under `scripts/bundle.ts` that
  > produces the artefact, and a CI job in `.github/workflows/`
  > that publishes the bundle alongside each npm release. Update
  > `README.md` Getting Started with the bundle path *above* the
  > `npx` path. Do not remove the `npx` path — it stays for
  > technical users.

- [ ] **OAuth where the network supports it.**
  Three networks (Awin, Impact, eBay) accept OAuth even though we
  paste tokens today. Move them to a browser handshake so the user
  never sees an API token.

  > For each of Awin, Impact, and eBay, add a browser-based OAuth
  > path to the setup wizard. The reference is the brand-side Awin
  > OAuth flow already in `src/networks/awin-advertiser/`. Each
  > network's setup brief gains a `oauth: { authorizeUrl,
  > tokenUrl, scopes, clientId? }` block; when present, the wizard
  > offers OAuth as the default and "paste a token" as the
  > fallback. Implement the loopback redirect on an ephemeral
  > localhost port (no public callback URL). Persist only the
  > resulting bearer / refresh token to `~/.affiliate-mcp/.env`;
  > never the client secret if the network's flow doesn't need one
  > on disk. CJ and Rakuten stay paste-only — their public APIs
  > don't expose an OAuth flow for publisher credentials.

- [ ] **Brand auto-discovery with pre-filled nicknames.**
  Today the wizard lists discovered brands and asks for a nickname
  per brand. Pre-fill a sensible default (slugified display name)
  so most users press enter through the list.

  > In `src/cli/wizard/brands.ts` (or equivalent — the file that
  > orchestrates the `listBrands` → nickname loop), after fetching
  > each network's discovered brand list, compute a default
  > nickname per brand: lowercase, ASCII-fold, replace any non-
  > `[a-z0-9]` run with `-`, trim hyphens, dedupe against already-
  > assigned nicknames in this session by appending `-2`, `-3`,
  > etc. Present each row as `[discovered name] → suggested
  > nickname [press enter to accept, or type a new one]`. Skipping
  > a brand stays an option. Tests in
  > `tests/cli/wizard/brands.test.ts`.

- [ ] **Hosted / cloud-mode MCP endpoint (opt-in).**
  For agency operators who want to ask questions from their phone.
  Local-first stays the default; this is a separate path with its
  own auth.

  > Add a `remote/` deployment target alongside the existing
  > stdio server. Use Streamable HTTP per the MCP transport spec.
  > Auth is OAuth at the server boundary; per-user credential
  > storage is server-side encrypted at rest with a KMS key the
  > operator controls. Do not start this without an issue covering
  > the threat model (specifically: what changes vs. local-first,
  > and what users opt in to). The server shares the adapter and
  > tools layer with stdio — only the transport differs.

## Publisher daily questions

- [ ] **`upcoming-payouts` skill.**
  *"When am I getting paid next, by who, for how much?"* across
  every network in one response. Each network has its own payment
  cadence — apply the cadence to the approved-but-unpaid pool.

  > New skill at `src/skills/upcoming-payouts/SKILL.md` following
  > the style of `affiliate-earnings-report`. The skill:
  > (1) calls each registered publisher network's
  > `affiliate_<network>_list_transactions` with `status: approved`
  > (and `paid: false` derivation per network);
  > (2) groups by network and computes the next-payout date per
  > network using the cadence rules below — keep these in
  > `src/skills/upcoming-payouts/payout-cadence.json` so they can
  > be edited without code: Awin (1st and 15th, Net-30 on
  > validation date), CJ (20th of the month, Net-20), Impact
  > (bi-weekly), Rakuten (monthly), eBay (monthly);
  > (3) outputs a table with columns network / next payout date /
  > amount (per currency) / number of transactions, sorted by
  > date ascending;
  > (4) flags any approved transactions older than 2× the
  > network's documented cadence as a chase candidate.
  > Tests in `tests/skills/upcoming-payouts/` with fixture
  > responses per network.

- [ ] **`reversal-investigator` skill.**
  *"Why was this transaction reversed?"* — take a transaction ID,
  fetch the full record, explain the reason, compare against the
  programme's historical reversal rate.

  > New skill at `src/skills/reversal-investigator/SKILL.md`. It
  > accepts a transaction ID and (optionally) a network slug. If
  > the slug is omitted, it tries each registered network's
  > `getTransactionById` (Awin already exposes this; add a
  > shared `getTransactionById(id: string): Transaction | null`
  > op to the canonical contract for the other networks and
  > implement it where the underlying API supports it). Surface:
  > the verbatim `reversalReason` / `declineReason` from
  > `rawNetworkData`, the canonical status, and a single-line
  > English explanation. Then call `listTransactions` for the
  > same programme over the trailing 90 days and report
  > "this programme's reversal rate over the last 90 days is X%
  > (Y reversed out of Z)". No invention; if the network doesn't
  > expose enough data, say so.

- [ ] **`build-link` skill.**
  *"Give me an affiliate link for [URL]"*, single or bulk. Picks
  the right network + programme from the user's registered set.

  > New skill at `src/skills/build-link/SKILL.md`. Single-URL
  > path: ask the user which network/programme to use if the URL
  > matches more than one of their registered programmes; pick
  > automatically if it matches exactly one. Bulk path: accept a
  > Markdown table or CSV of URLs (+ optional subid column),
  > generate links in parallel via each adapter's
  > `generateTrackingLink`, return as a table with original URL,
  > network, programme, tracking link, subid. Honour deterministic
  > construction where the adapter supports it (Awin, CJ, eBay,
  > Rakuten — no API round-trip); fall back to the API for Impact.
  > Tests in `tests/skills/build-link/` covering single and bulk.

- [ ] **`programme-discovery` skill.**
  *"Find me programmes I'm not on but should be."* Scans the
  available-programme pool per network, ranks by EPC / commission
  rate, filters by category.

  > New skill at `src/skills/programme-discovery/SKILL.md`. Calls
  > `listProgrammes({ status: 'available' })` on each registered
  > network and merges results. Sort by EPC where the network
  > publishes it (Awin yes, Impact yes, CJ partial, Rakuten no);
  > fall back to commission-rate sort otherwise. Accept a
  > `category` filter ("fashion", "DTC", "finance" etc.) and a
  > `minEpc` filter. Output a table; per row include the apply
  > URL so the user can complete the join on the network's
  > dashboard. Do *not* attempt to apply via API in this skill —
  > that's a separate write-path item.

- [ ] **`compare-networks-for-brand` skill.**
  *"Nike runs on Awin and CJ — which pays better today?"*

  > New skill at `src/skills/compare-networks-for-brand/SKILL.md`.
  > Accepts a brand name or advertiser ID. Looks across the user's
  > registered networks for any programme whose name fuzzy-matches
  > the input. For each match, pull live commission rate, EPC,
  > cookie window from `getProgramme`. Output a side-by-side
  > comparison with a one-line recommendation: "Awin pays 8% with
  > a 30-day cookie; CJ pays 6% with a 45-day cookie. If your
  > typical conversion is fast (<7 days) Awin wins on
  > commission." Never invent figures — only the fields the
  > network published.

- [ ] **`tax-export` skill (publisher).**
  Emits paid transactions in a shape an accountant or tax
  software expects.

  > New skill at `src/skills/tax-export/SKILL.md`. Accepts a tax
  > year (`2025`, `FY2025`, or explicit dates) and an optional
  > jurisdiction (`US`, `UK`, `EU`). Pulls
  > `status: paid` transactions from every registered network,
  > groups per currency, and emits CSV with columns: date, network,
  > brand, gross sale, commission, currency, status, transaction
  > ID. For `US` jurisdiction, additionally annotate per-network
  > whether the user crossed the 1099 threshold ($600 in a
  > calendar year). For `UK` and `EU`, emit VAT-relevant fields
  > where the network exposes them. Output is the CSV plus a
  > one-paragraph summary the user can paste into an email to
  > their accountant.

- [ ] **`publisher-anomaly-watch` skill.**
  The brand-side `programme-anomaly-watch` skill exists; this is
  its publisher equivalent. Weekly scan for revenue drops,
  reversal spikes, dead programmes, top-merchant dropouts.

  > New skill at `src/skills/publisher-anomaly-watch/SKILL.md`,
  > mirroring `src/skills/programme-anomaly-watch/SKILL.md` on the
  > publisher side. Compute week-over-week deltas per programme;
  > flag programmes whose revenue dropped >30% or whose reversal
  > rate jumped >2× their trailing-90-day baseline; flag
  > programmes that went from non-zero to zero ("dead"); flag
  > merchants that left the user's top-10. Same scheduling-friendly
  > output shape — terse, structured, designed to be triggered by
  > Claude's own scheduling on a weekly cadence.

## Brand-side daily questions

- [ ] **`validate-transactions` skill (write path).**
  The highest-value brand-side write op. Behind a hard consent
  gate: list what will be approved, get explicit "approve"
  confirmation before any non-GET HTTP call goes out.

  > This is the first write op for the project. Read the read-
  > only stance documented in
  > `src/networks/<slug>-advertiser/client.ts` (HTTP client
  > refuses non-GET methods) and design the relaxation carefully.
  > Add a `writeMode: 'never' | 'on-confirm'` flag per credential
  > in `~/.affiliate-mcp/.env`, default `'never'`. The skill at
  > `src/skills/validate-transactions/SKILL.md`:
  > (1) calls `listTransactions({ status: 'pending' })` per brand
  > × network;
  > (2) summarises the queue (count, total commission per
  > currency, per-publisher breakdown);
  > (3) asks the user to type the word `approve` (not just press
  > enter) before proceeding;
  > (4) calls `approveTransaction(id)` per row, with a fresh
  > `withResilience` invocation per call. Add `approveTransaction`
  > to the canonical advertiser contract in
  > `src/shared/types.ts` and implement it on Awin, CJ, Impact
  > advertiser adapters where the underlying API supports it.
  > Errors envelope as per principle 4.1. Tests must cover the
  > consent gate refusing to proceed without the explicit string.

- [ ] **`new-publisher-triage` skill.**
  Weekly look at pending publisher applications. Approval itself
  stays a network-dashboard action until the write path lands.

  > New skill at `src/skills/new-publisher-triage/SKILL.md`. For
  > each registered advertiser network, call the listPublishers
  > op with `status: pending`. (The op is scaffolded today and
  > throws `NotImplementedError`; this skill is the trigger to
  > implement it on Awin, CJ, Impact advertisers where the
  > network's API exposes the pending application pool.) For each
  > applicant, fetch publisher metadata (traffic source category,
  > monthly visitors if disclosed, network tenure, prior approvals
  > history). Recommend approve / decline / hold per applicant
  > with a one-sentence rationale. Output is a table; clicking
  > the approve link sends the user to the network dashboard
  > (write op stays manual at this stage).

- [ ] **`tracking-diagnostic` skill.**
  *"Why isn't my tracking firing?"* — walk a test order ID or
  click ID through the network's reporting.

  > New skill at `src/skills/tracking-diagnostic/SKILL.md`.
  > Accepts a click ID, transaction ID, or order ID and a network
  > slug. Pulls the click record (if available), the conversion
  > record (if available), the commission record (if available)
  > and reports which step recorded the event and which did not.
  > For each gap, surface the network's documented common cause
  > (cookie blocked, attribution-window expired, programme paused,
  > etc.) from a per-network knowledge file at
  > `src/networks/<slug>-advertiser/tracking-troubleshoot.md`.
  > No invention — if the network has no record of the event,
  > say so.

- [ ] **`coupon-leak-watch` skill.**
  Brands give exclusive codes to specific publishers. Codes leak.
  Correlate code usage against the publisher who should own it.

  > New skill at `src/skills/coupon-leak-watch/SKILL.md`. Reads a
  > `coupon-owners.json` configured by the user (per brand: map
  > of `couponCode → owningPublisherId`). Pulls the last 30 days
  > of transactions per brand × network, extracts the coupon
  > field where the network exposes it (`PromoCode` on Impact,
  > `voucherCode` on Awin transactions), and flags any
  > transaction whose coupon belongs to a publisher other than
  > the one whose tracking link drove the sale. Output is a
  > per-brand table of flagged transactions. Honest about the
  > limitation: networks that don't expose the coupon field on
  > the transaction record can't be diagnosed.

- [ ] **`publisher-brief-drafter` skill.**
  Draft a tailored email to top publishers about an upcoming
  promo. We draft, we don't send.

  > New skill at `src/skills/publisher-brief-drafter/SKILL.md`.
  > Inputs: promo dates, headline offer, brand. Pulls the top N
  > publishers (default 50) by trailing-90-day commission across
  > the brand's bound networks. For each, draft a short email
  > including the promo details and a per-publisher line citing
  > their recent performance. Output is a single Markdown
  > document with one section per publisher; the user copies
  > each section into their email client. No SMTP integration —
  > sending stays outside the tool.

## Agency workflows

- [ ] **Scheduled weekly client reports.**
  The portfolio rollup already runs on-demand; the agency wants
  it scheduled per client and delivered without anyone touching
  a dashboard.

  > Update `src/skills/programme-performance-report/SKILL.md`
  > with a stable "weekly report" output shape (fixed sections,
  > fixed headings, fixed order) so the agency can drop it
  > straight into their client portal each Monday. Add a worked
  > example showing how to wire it to Claude's own scheduling
  > (no scheduler in this repo — we just produce the
  > deterministic output). Add an
  > `examples/agency-weekly-schedule.md` walkthrough showing the
  > Claude side of the wiring.

- [ ] **`client-deck` skill.**
  Monthly / quarterly performance deck. Emits slide-shaped
  Markdown the user converts to Google Slides via a separate
  Claude artifact step.

  > New skill at `src/skills/client-deck/SKILL.md`. Accepts a
  > brand slug and a period (`month`, `quarter`, explicit dates).
  > Output is a Markdown document with H1-per-slide structure:
  > title slide, headline numbers, top-publisher table, trend
  > description (we describe the trend in prose; Claude renders
  > the chart in the conversation), callouts. The same data the
  > `programme-performance-report` already pulls; different
  > shape.

- [ ] **White-label output via `agency-profile.json`.**
  Today reports use our default voice. Honour a per-agency
  profile so the same skill emits Acme-branded output for Acme
  and Globex-branded output for Globex.

  > Add support for an optional
  > `~/.affiliate-mcp/agency-profile.json` with fields
  > `agencyName`, `agencyLogoUrl`, `primaryColour`, `signoffBlock`,
  > and per-brand overrides under `brands.<slug>`. Update
  > `agency-portfolio-rollup`, `programme-performance-report`,
  > and `client-deck` skills to read the profile and inject the
  > brand-appropriate header/footer. Profile stays local —
  > never read, never sent anywhere. Tests cover the no-profile
  > path producing today's default output unchanged.

- [ ] **`cross-client-benchmark` skill.**
  *"How does Acme's CR compare to my other DTC clients?"* Careful
  anonymisation — client A never sees client B's numbers.

  > New skill at `src/skills/cross-client-benchmark/SKILL.md`.
  > Accepts a focus brand and an optional comparator pool
  > (default: all other brands in the agency's `brands.json`).
  > Computes conversion rate, AOV, EPC, reversal rate for the
  > focus brand and a single anonymised "comparator pool"
  > aggregate (mean, median, p25, p75). The output names the
  > focus brand explicitly and refers to the pool only as
  > "your other clients (n=X)". Never names another brand in
  > the comparator side of the output. Tests verify the
  > anonymisation invariant.

- [ ] **`add-brand` subcommand.**
  Adding a brand to `brands.json` today requires re-running the
  full setup wizard. Agencies onboarding a new client want a
  fast path that skips credential prompts.

  > Add `affiliate-networks-mcp add-brand [slug]` to the CLI.
  > Implements at `src/cli/add-brand.ts`. Skips all credential
  > prompts (credentials are already configured). Lists the
  > registered advertiser networks; asks which the new brand is
  > on; for each, asks for the network's brand ID (or offers a
  > `listBrands` discovery pass). Writes the resulting
  > bindings to `~/.affiliate-mcp/brands.json` atomically. Tests
  > in `tests/cli/add-brand.test.ts`.

## Finance / CFO workflows

- [ ] **`aging-report` skill.**
  *"What's owed to me, by who, how long has it been waiting?"*

  > New skill at `src/skills/aging-report/SKILL.md`. Pulls
  > approved-but-unpaid transactions per network (publisher side)
  > or per brand × network (brand-side / agency). Buckets by age:
  > 0–30, 30–60, 60–90, 90+ days. Compares each bucket against the
  > network's documented payment cadence (same
  > `payout-cadence.json` as `upcoming-payouts`); flags any bucket
  > whose age exceeds the cadence as a chase candidate. Output is
  > a table per currency. Pair with `upcoming-payouts` for the
  > forward-looking view.

- [ ] **`reconcile-payout` skill.**
  When the network pays out, did the payment match the
  locked-in commissions? Match a statement against reported paid
  transactions.

  > New skill at `src/skills/reconcile-payout/SKILL.md`. Inputs:
  > a paste of the payment statement (CSV, table, or extracted
  > PDF text — accept all three) and a network slug. Pulls
  > `status: paid` transactions from that network over a date
  > window straddling the statement, matches line-by-line on
  > transaction ID where the statement exposes it (otherwise on
  > date + amount), and reports variance: matched, missing
  > from statement, missing from network. Surface the verbatim
  > unmatched rows; never silently bucket them.

- [ ] **`reversal-rate-watch` skill.**
  A reversal-rate spike is a finance signal as much as an ops
  one. Week-over-week by network and by programme, flag
  anything >2σ above its trailing-90-day baseline.

  > New skill at `src/skills/reversal-rate-watch/SKILL.md`.
  > Compute reversal rate (count of reversed / count of all
  > finalised) per network and per programme over the last 7
  > days. Compare against the trailing 90-day baseline mean and
  > stdev. Flag any series that is >2σ above its baseline.
  > Output: table sorted by z-score descending. Honest about
  > small-sample noise — suppress series with <20 finalised
  > transactions in the window.

- [ ] **`revenue-forecast` skill.**
  Pipeline-based forecast: paid + approved + pending ×
  approval-rate.

  > New skill at `src/skills/revenue-forecast/SKILL.md`. For each
  > registered publisher network (or brand-side programme):
  > paid_to_date + approved_unpaid + (pending × historical-90-day
  > approval-rate-for-this-programme). Output a low/mid/high
  > bounded estimate per currency: low = paid + approved, high =
  > paid + approved + pending, mid = paid + approved + pending ×
  > approval-rate. Each component named explicitly. Tests verify
  > the bound invariants (mid lies between low and high).

- [ ] **Multi-currency rollup with FX timestamping.**
  Agencies invoice in client currencies — that stance stays the
  default in `agency-portfolio-rollup`. This is the opposite
  stance for the CFO workflow: roll everything to one reporting
  currency at the transaction-date FX rate, with the source
  named.

  > New skill at `src/skills/finance-rollup/SKILL.md`. Accepts a
  > reporting currency (default `USD`) and a date range. Pulls
  > every transaction across registered networks; for each row
  > whose currency differs from the reporting currency, fetches
  > the ECB daily reference rate for that transaction's date
  > (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html — public, free, no auth).
  > Cache rates locally at `~/.affiliate-mcp/fx-cache.json` per
  > date+pair. Output names the rate source on every converted
  > row. If the user prefers a different provider, the source URL
  > is configurable via `FX_RATE_SOURCE_URL` env var.

- [ ] **`tax-export` (CFO variant).**
  The publisher tax-export above ships per-publisher; this is
  the agency-finance equivalent for an agency that needs the
  same shape across every client.

  > Once the publisher `tax-export` skill is in, extend it with a
  > `scope: 'agency'` mode that iterates every brand in
  > `brands.json` and emits one CSV per brand plus an aggregate
  > summary. Both modes share the same column shape; only the
  > grouping changes.

## Network coverage

- [ ] **Add Tradedoubler (publisher).**
  Public REST API with token auth.

  > Use the `contribute` skill (auto-loaded when you open this
  > repo in Claude Code). Type *"add Tradedoubler to
  > affiliate-mcp"*. The skill walks scaffold selection, API
  > research, adapter implementation, tests, and docs. Reference:
  > the tracking issue in
  > `docs/wanted-networks.json` and the [Tradedoubler API docs](https://dev.tradedoubler.com/).
  > Ship at `claim_status: experimental` until exercised against
  > a live account.

- [ ] **Add Partnerize (publisher + advertiser).**
  Separate publisher- and advertiser-tier APIs; aim to ship
  both adapters in one pass.

  > Use the `contribute` skill. Type *"add Partnerize to
  > affiliate-mcp, both sides"*. The skill knows the
  > publisher-vs-advertiser fork from the brief; pick "both" at
  > the early prompt. Reference docs:
  > https://api-docs.partnerize.com/.

- [ ] **Add Skimlinks (publisher).**
  > Use the `contribute` skill. Type *"add Skimlinks to
  > affiliate-mcp, publisher side"*. Reference docs:
  > https://developers.skimlinks.com/.

- [ ] **Add Webgains (publisher).**
  > Use the `contribute` skill. Type *"add Webgains to
  > affiliate-mcp, publisher side"*. Approval may be required for
  > API access — surface that in the setup brief like Rakuten
  > does. Reference docs:
  > https://www.webgains.com/public/en/help-section/.

- [ ] **Promote Awin (publisher) to `production`.**
  > Run the live acceptance test against a real Awin publisher
  > account: `npm run validate:network -- awin` with credentials
  > configured. Confirm all six implemented ops pass; confirm the
  > `listClicks` `NotImplementedError` is the only structural
  > gap. Flip `claim_status` in `src/networks/awin/network.json`
  > from `partial` to `production` and regenerate `REPORT.md`
  > (`npm run generate:report`). Add a brief "live validation"
  > note to `docs/findings/awin.md` with the date and the test
  > account scope.

- [ ] **Promote Impact (publisher) to `production`.**
  > Same shape as the Awin promotion. Additionally: the
  > 5xx-storm workarounds in `src/networks/impact/adapter.ts`
  > (`ACTIONS_RESILIENCE` constant) should be re-tested against
  > current Impact behaviour during validation. If Impact's
  > stability has improved, dial back retries from 4 to the
  > default 2 in the same PR.

- [ ] **Promote CJ (publisher) to `production`.**
  > Same shape. The GraphQL-on-200 error path
  > (`tests/networks/cj/adapter.test.ts → "surfaces GraphQL
  > errors payloads verbatim even on HTTP 200"`) wants live
  > evidence — exercise at least one query that CJ rejects (a
  > malformed field) and confirm the verbatim error body reaches
  > the user.

- [ ] **Promote Awin / CJ / Impact advertiser adapters to `partial` then `production`.**
  > Three separate live-validation passes, one per network. The
  > target for each is the same shape as the publisher
  > promotions. The Awin advertiser pass particularly wants a
  > multi-brand Accelerate account to verify the 20-per-minute
  > rate-budget handling under load. The Impact advertiser pass
  > wants a tenant that exercises the sync-vs-async report
  > polling path (currently `// TODO(verify)`).

- [ ] **Promote Rakuten (publisher) to `production`.**
  > Requires Publisher Solutions to grant API access on the test
  > account (~5 business days). Once granted, run the validation
  > and also implement `listClicks` against `clicks_reports` if
  > the upgraded account has access — the implementation is a
  > ~20-line addition mirroring `listTransactions`'s shape.

- [ ] **Promote eBay (publisher) to `partial` then `production`.**
  > Requires the EPN developer-account approval gate (~3 business
  > days). The reporting endpoints in particular need a real
  > round-trip — every field name, status string, and pagination
  > shape in the adapter today is synthesised from documentation
  > only.

- [ ] **Add Rakuten (advertiser).**
  > Use the `contribute` skill. Type *"add Rakuten advertiser
  > adapter to affiliate-mcp"*. Auth model is more complex than
  > the publisher side — start by mapping the OAuth flow
  > carefully. The skill will pick the brand-side scaffold and
  > the read-only stance per the existing brand-side adapters'
  > conventions.

## Action / write paths

- [ ] **`adjust-commission-rate` skill (write path).**
  The brand manager's second recurring write workflow after
  transaction validation.

  > Add an `adjustCommissionRate` op to the canonical advertiser
  > contract in `src/shared/types.ts` and implement it on the
  > advertiser adapters whose APIs support it. New skill at
  > `src/skills/adjust-commission-rate/SKILL.md` follows the
  > same consent-gate pattern as `validate-transactions`: list
  > the proposed changes (publisher, current rate, new rate,
  > effective date), require the user to type `apply` before
  > any non-GET call goes out. Tests cover the consent gate.

- [ ] **`apply-to-programme` skill (write path).**
  Today programme-discovery surfaces the apply URL; the upgrade
  is to submit the application via API on the user's
  confirmation.

  > Add an `applyToProgramme(programmeId: string, body:
  > ApplicationBody): ApplicationResult` op to the canonical
  > publisher contract in `src/shared/types.ts` and implement it
  > on the publisher adapters whose APIs support it (Awin yes;
  > CJ partial — depends on programme type; Impact yes; Rakuten
  > and eBay no). New skill at
  > `src/skills/apply-to-programme/SKILL.md` follows the same
  > consent-gate pattern.

## Cross-cutting

- [ ] **`affiliate-quick-question` skill.**
  Lower-ceremony skill for one-off questions that don't justify
  the structured shape of the bigger skills.

  > New skill at `src/skills/affiliate-quick-question/SKILL.md`.
  > Designed to answer single-fact questions ("how many
  > programmes am I on?", "what was my best day last month?",
  > "what's my Awin token's expiry?") with one or two lines.
  > Picks the right adapter call from the question; never fans
  > out across networks unless the question explicitly demands
  > it. The smaller surface keeps latency down — most questions
  > should resolve in one tool call.

- [ ] **`affiliate-explain` skill.**
  Explains a row, a status, or a network-specific term in
  English. Reads from per-network notes.

  > New skill at `src/skills/affiliate-explain/SKILL.md`. Reads
  > from a shared knowledge base at
  > `src/skills/affiliate-explain/glossary/<slug>.md` per
  > network — same content as the findings docs, but indexed by
  > term. The skill takes a snippet ("status: LOCKED",
  > "validationDate", "EXTENDED") and explains what the term
  > means on the network it came from. Helps new users
  > particularly; cheap to ship because the knowledge already
  > exists in `docs/findings/`.

- [ ] **`network-status-page` skill.**
  Surfaces ongoing network incidents alongside the user's data.
  Helps the user distinguish their problem from the network's.

  > New skill at `src/skills/network-status-page/SKILL.md`.
  > Fetches each registered network's public status page (Awin,
  > CJ, Impact, eBay, Rakuten all publish one) and parses the
  > current-status block. URLs and parsers live per network at
  > `src/networks/<slug>/status-page.ts`. Output is one line per
  > network, sorted so any ongoing incident is at the top.
  > Read-only; no credential required (the status pages are
  > public).

## Non-goals

Things we deliberately do not plan to build:

- Our own dashboard / hosted UI.
- Scraping where an API exists.
- A hosted credential store (the cloud / mobile path above is
  the one explicit exception and is opt-in).
- Cross-network FX normalisation by default (it's opt-in for
  the CFO workflow only).
- Affiliate fraud detection beyond what the networks themselves
  surface.

## How this roadmap changes

This document is the to-do list. The honest state of every
shipping adapter is in [`REPORT.md`](../../REPORT.md), regenerated
from each adapter's `network.json` on every merge. The status of
any in-flight skill or feature is in the GitHub issue tracker, not
here.

If you think a workflow on this list is in the wrong place — or a
workflow you do every day isn't on the list — open an issue and
say what you do. We treat every "I wish it could…" as a vote.
