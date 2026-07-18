# Security

`affiliate-networks-mcp` is a local-first, open-source MCP server. It runs on
the user's own machine and uses credentials the user supplies. There is also a
separate, opt-in hosted tier; its custody model, encryption boundaries, and
honest limits are stated in
[`docs/security/hosted-trust.md`](./docs/security/hosted-trust.md). This
document covers the security posture in brief and how to report a
vulnerability. The full data-handling detail, including the answers brands and
agencies usually ask for in a vendor assessment, is in
[`docs/security/overview.md`](./docs/security/overview.md).

## Posture in one paragraph

On the local path — the default and the free path — there is no account to
create with us. Network credentials are written to `~/.affiliate-mcp/.env` on
the user's machine with owner-only permissions (mode `0600`) and are sent only
to the official APIs of the networks the user configures. The opt-in hosted
tier is the one exception to "nothing leaves your machine", under the custody
contract in
[`docs/security/hosted-trust.md`](./docs/security/hosted-trust.md). Affiliate data is fetched live, processed
locally, and is not forwarded to this project. Optional usage telemetry is off
by default, opt-in, aggregate-only, and never carries credentials, account
identifiers, or affiliate data. The retention and storage contract is in
[`PRIVACY.md`](./PRIVACY.md).

On the local path the project holds none of a user's credentials or affiliate
data, so the relevant security boundary is the user's own machine and their own
network API keys, not a vendor's infrastructure. On the opt-in hosted tier that
boundary moves to the hosted infrastructure under a documented custody
contract; see [`docs/security/hosted-trust.md`](./docs/security/hosted-trust.md).

## Supported versions

The project is in public beta. Security fixes are made against the latest
published release. Pin to a released version rather than an arbitrary commit,
and upgrade to take a fix.

## Reporting a vulnerability

Report suspected vulnerabilities through the most private GitHub route
available for the repository:

1. Open <https://github.com/bobberrisford/affiliatemcp/security/advisories>.
2. If **Report a vulnerability** is available, use it.
3. If private reporting is unavailable, open a public issue asking for a
   private disclosure channel, but do not include exploit details, credentials,
   or sensitive reproduction material in the public issue.

Please do not post exploit details publicly. Once a private channel is
established, include the affected version, a description, reproduction steps,
and the impact you expect.

We aim to acknowledge a report within a few working days and to agree a
disclosure timeline with the reporter. There is no bug-bounty programme.

## Scope

In scope: the published `affiliate-networks-mcp` package, its adapters, the CLI,
the desktop setup app, and the host-native bundle.

Out of scope: vulnerabilities in the affiliate networks' own APIs or
dashboards, in the MCP client (for example Claude Desktop, Claude Code, or
Codex), or in the user's operating system or terminal. Report those to the
relevant vendor.
