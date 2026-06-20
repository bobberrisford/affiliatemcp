# Security

`affiliate-networks-mcp` is a local-first, open-source MCP server. It runs on
the user's own machine, uses credentials the user supplies, and has no hosted
service. This document covers the security posture in brief and how to report a
vulnerability. The full data-handling detail, including the answers brands and
agencies usually ask for in a vendor assessment, is in
[`docs/security/overview.md`](./docs/security/overview.md).

## Posture in one paragraph

There is no hosted service and no account to create with us. Network
credentials are written to `~/.affiliate-mcp/.env` on the user's machine with
owner-only permissions (mode `0600`) and are sent only to the official APIs of
the networks the user configures. Affiliate data is fetched live, processed
locally, and is not forwarded to this project. Optional usage telemetry is off
by default, opt-in, aggregate-only, and never carries credentials, account
identifiers, or affiliate data. The retention and storage contract is in
[`PRIVACY.md`](./PRIVACY.md).

Because the project holds none of a user's credentials or affiliate data, the
relevant security boundary is the user's own machine and their own network API
keys, not a vendor's infrastructure.

## Supported versions

The project is in public beta. Security fixes are made against the latest
published release. Pin to a released version rather than an arbitrary commit,
and upgrade to take a fix.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private
vulnerability reporting:

1. Open <https://github.com/bobberrisford/affiliatemcp/security/advisories>.
2. Choose **Report a vulnerability**.

Please do not open a public issue for a suspected vulnerability. Include the
affected version, a description, reproduction steps, and the impact you expect.

We aim to acknowledge a report within a few working days and to agree a
disclosure timeline with the reporter. There is no bug-bounty programme.

## Scope

In scope: the published `affiliate-networks-mcp` package, its adapters, the CLI,
the desktop setup app, and the host-native bundle.

Out of scope: vulnerabilities in the affiliate networks' own APIs or
dashboards, in the MCP client (for example Claude Desktop, Claude Code, or
Codex), or in the user's operating system or terminal. Report those to the
relevant vendor.
