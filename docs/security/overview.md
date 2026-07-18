# Security and data-handling overview

**Status:** Current

This document is the source of truth for security and data-handling questions
about `affiliate-networks-mcp`. It is written so that a brand, agency, or their
security reviewer can self-serve the answers a vendor assessment usually asks
for, without a bespoke questionnaire. It restates the architecture in security
terms and maps it to the common questionnaire categories.

Canonical references it does not repeat:

- [`PRIVACY.md`](../../PRIVACY.md) owns the storage, retention, and telemetry
  contract.
- [`SECURITY.md`](../../SECURITY.md) owns vulnerability reporting.
- The README section "Where your credentials live" owns the local file layout.

## The short version

`affiliate-networks-mcp` is a local-first, open-source MCP server. On the local
path — the default and the free path this document describes — it runs on the
user's own machine, under the user's own account, using credentials the user
supplies. There is no account to create with us and no server-side
multi-tenancy; the project does not receive, store, or process a user's
credentials or affiliate data.

There is one exception: a separate, opt-in **hosted tier** does hold per-user
credentials on hosted infrastructure, under a documented custody contract. It
is out of scope for the local-path answers below; its custody model,
encryption boundaries, and honest limits are stated in
[`hosted-trust.md`](./hosted-trust.md), with the retention policy in
[`PRIVACY.md`](../../PRIVACY.md). The rest of this document describes the local
path unless it says otherwise.

This matters for an assessment because most vendor questionnaires assume the
vendor holds the customer's data on the vendor's infrastructure. On the local
path that assumption does not hold: the security boundary that matters is the
operator's own machine and their own network API keys. On the hosted tier the
boundary moves to the hosted infrastructure, per the trust page above.

## How data flows

```
  Operator's machine                         Third parties
  ------------------                         -------------
  MCP client (Claude Desktop / Code / Codex)
        |  stdio
        v
  affiliate-networks-mcp (local process)
        |  HTTPS, per-network API calls  -->  Affiliate network APIs
        |                                     (the user's own accounts)
        |
        |  optional, opt-in, aggregate  -->   Cloudflare (telemetry only)
        v
  ~/.affiliate-mcp/   (.env, brands.json, optional cache)
```

- The MCP client talks to the local server over stdio. Prompts, tool
  arguments, and results stay between the client and the local process.
- The local process calls each configured network's official API directly over
  HTTPS. These are the same API calls the network would see from the user's own
  dashboard usage.
- Affiliate data returned by those APIs is processed in memory on the user's
  machine. It is not sent to this project.
- The only outbound traffic to infrastructure operated for this project is
  optional, opt-in, aggregate-only telemetry, described below and in
  `PRIVACY.md`.

## Questionnaire-mapped answers

| Category | Answer |
| --- | --- |
| Hosting / deployment model | Local-first by default. The software runs as a process on the user's own machine; on this path there is no SaaS tenancy and no account with us. A separate, opt-in hosted tier runs on Cloudflare under the custody contract in [`hosted-trust.md`](./hosted-trust.md). |
| Where customer data is stored | On the user's machine only. Credentials in `~/.affiliate-mcp/.env` (mode `0600`); brand mappings in `~/.affiliate-mcp/brands.json`; optional result cache under `~/.affiliate-mcp/cache/` (off by default, owner-only permissions). |
| Does the vendor receive customer data or credentials? | No. Credentials go only to the configured networks' official APIs. Affiliate data is fetched live and processed locally; it is not forwarded to this project. |
| Sub-processors | None for credentials or affiliate data. For optional opt-in telemetry only, Cloudflare routes and stores aggregate counts (see `PRIVACY.md`). If telemetry is off, there are no sub-processors. |
| Data in transit | All network API calls are over HTTPS to the networks' own endpoints. Optional telemetry is sent over HTTPS. |
| Data at rest | Managed by the user's own operating system. Local files use owner-only permissions (`0600` for files, `0700` for the cache directory). The project does not add a separate encryption layer; full-disk encryption is the operator's control. On a shared machine where file permissions cannot be relied on, leave caching off so transaction-level results are never written to disk. |
| Authentication and access control | On the local path the user authenticates directly to each network using their own API credentials, with no login to a service operated by us. The opt-in hosted tier does have accounts (email magic-link sign-in) and sessions, scoped to serving only the account's own data; see [`hosted-trust.md`](./hosted-trust.md). |
| Data retention | We retain none of the user's credentials or affiliate data. Local files persist until the user deletes them. Telemetry retention is defined in `PRIVACY.md`. |
| Data deletion / portability | The user controls all data. Remove a network by deleting its keys from `~/.affiliate-mcp/.env`; clear the cache with `affiliate-networks-mcp cache clear`; remove everything by uninstalling and deleting `~/.affiliate-mcp/`. |
| Logging | Operational logs go to stderr on the user's machine and are not collected by us. The project never logs credentials. |
| Telemetry / analytics | Off by default, opt-in, aggregate-only. Never carries credentials, account identifiers, affiliate data, prompts, arguments, results, amounts, URLs, error text, or exact timestamps. Full contract in `PRIVACY.md`. |
| Source code review | The project is open source. The full implementation, including the adapter contract and resilience layer, is available for inspection at <https://github.com/bobberrisford/affiliatemcp>. |
| Vulnerability reporting | Prefer GitHub private vulnerability reporting when available; otherwise request a private disclosure channel without posting exploit details publicly. See `SECURITY.md`. |
| Compliance certifications (SOC 2, ISO 27001) | On the local path, not applicable in the usual sense: there is no vendor-held data to certify, and the relevant controls (device security, key management, disk encryption) sit with the operator. The hosted tier holds vendor-side data but is not yet certified; formal-compliance work is explicitly deferred until team-tier demand, per [`hosted-trust.md`](./hosted-trust.md). |
| Data protection / GDPR | We are not a processor of the user's affiliate data, because it is never sent to us. The operator and the affiliate networks remain the parties handling that data under their existing agreements. |

## Telemetry, stated plainly

Anonymous usage telemetry is off by default. It is sent only after the user
explicitly opts in. When enabled it sends at most one aggregate summary per
active day: a monthly-rotating random identifier, the package version and
launch surface, and coarse counts by network, operation, and outcome. It never
sends credentials, account identifiers, or affiliate data. The complete field
list, storage, and retention are in `PRIVACY.md`. If a brand or agency requires
it switched off, the operator runs `affiliate-networks-mcp telemetry disable`,
or the host sets `AFFILIATE_MCP_TELEMETRY` to off.

## Our position on questionnaires

This overview, plus `PRIVACY.md`, `SECURITY.md`, and the public source code, is
the source of truth and is kept current. Because the project holds none of a
customer's credentials or affiliate data, the standard vendor questionnaire
mostly does not apply, and these documents answer it more completely than a
hand-filled form would.

For that reason we default every brand and agency to this self-serve overview
rather than completing bespoke per-customer questionnaires. For enterprise
engagements with a specific contractual need, we will consider answering a
questionnaire on a case-by-case basis, using this overview as the basis for the
answers.

## What a brand or agency still owns

The local-first model moves some responsibilities to the operator. A reviewer
should confirm, on the operator's side:

- the operator's machine is managed to the organisation's standard, ideally with
  full-disk encryption;
- network API credentials are scoped and rotated per the network's own
  controls;
- the optional result cache is left off on shared machines;
- credentials are never committed to source control or shared in plain text.

These are the controls that actually protect the data, because that is where
the data and credentials live.
