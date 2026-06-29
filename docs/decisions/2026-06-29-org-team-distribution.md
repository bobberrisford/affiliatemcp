# Org and team distribution: native host allowlists, not the public Directory

- **Date:** 2026-06-29
- **Status:** Proposed (Path A selected by Rob, 2026-06-29; awaiting merge)
- **Affects:** Claude Desktop and Claude Code distribution, `DEPLOY.md`, the
  `.mcpb` manifest, `.claude-plugin/marketplace.json`, README install docs
- **Builds on:** [`2026-06-12-host-native-distribution.md`](./2026-06-12-host-native-distribution.md)
  (Accepted). That record fixed the individual install paths (the `.mcpb`
  bundle, the Claude Code and Codex plugins, MCP Registry metadata). It did not
  cover how a central IT admin deploys the server to a whole team, nor whether
  the public Anthropic Connectors Directory is a viable surface. This record
  settles both.

## Context

A central IT team wants to add affiliate-mcp for their whole organisation so
individual users do not each have to set it up. The obvious-looking route, the
public Connectors Directory, fails: a Directory-installed entry surfaces with a
server id of the form `ant.dir.ant.<hash>.<name>` and the runtime error
`No server configuration found`.

The cause is a surface mismatch, not a bug. The public Connectors Directory and
org-admin Custom Connectors both require a **remote HTTPS** server reachable
from Anthropic's infrastructure; per Anthropic's own docs, "Local STDIO servers
cannot be connected directly." affiliate-mcp is local-first by design: it runs
on the user's machine over stdio, the user brings their own affiliate-network
credentials, and a hard product boundary states there is no hosted version and
credentials never leave the user's machine (`AGENTS.md`). A public Directory
listing would therefore have no resolvable server config, which is exactly the
error users hit, and making it work would mean hosting the server, which the
boundary forbids.

The org-admin surfaces that **do** support a local stdio server keep it local
and keep credentials on-device:

- **Claude Desktop — Desktop Extensions allowlist.** An org owner uploads a
  `.mcpb` bundle; the org controls who may install it; each user enters their
  own credentials into the bundle's settings, stored by Claude Desktop.
- **Claude Code — managed settings.** A private plugin marketplace pinned with
  `extraKnownMarketplaces` / `strictKnownMarketplaces`, and/or a
  `managed-mcp.json` listing the stdio server, delivered by server-managed
  settings or MDM.

These are org-only, not the public Directory; there is no org-private Directory
listing for a local server.

## Decision

Org and team rollout uses each host's native **org-admin** deployment surface,
with the server running locally and credentials staying per-user on-device.

- **Claude Desktop (primary for non-technical teams).** Ship the generated
  `.mcpb` bundle. The org owner uploads it to the Desktop Extensions allowlist
  and enables it for the team. Each user fills the bundle's per-network
  credential fields (the four launch networks: Awin, CJ, Impact, Partnerize;
  sensitive fields are stored by Claude Desktop's secret storage). Every other
  adapter remains usable through the user's own `~/.affiliate-mcp/.env`.
- **Claude Code (primary for technical teams).** Distribute the existing private
  marketplace (`.claude-plugin/marketplace.json`), pinned through managed
  settings; the plugin already declares the stdio server. Where an org wants an
  exclusive, fixed set, deploy a `managed-mcp.json` entry running
  `npx -y affiliate-networks-mcp` over stdio. Both are delivered by
  server-managed settings or MDM.

We do **not** pursue the public Anthropic Connectors Directory. It is
remote-HTTPS-only; listing there would require a hosted server and break the
local-first, no-hosted-version, credentials-on-device boundary.

The open MCP Registry (modelcontextprotocol.io), already a follow-up of the
host-native decision, may still carry local install metadata. That registry is
distinct from the Anthropic Connectors Directory and is unaffected by this
record.

## Rejected alternatives

- **List in the public Connectors Directory.** Rejected: accepts remote HTTPS
  connectors only, so a local stdio server cannot resolve a config there (the
  `No server configuration found` failure). Making it work means hosting the
  server, which the product boundary forbids.
- **Stand up a self-hosted remote server per org now (Path B).** Deferred, not
  rejected on merit. A per-org self-hosted remote model could keep credentials
  inside the org's own infrastructure (though not on the user's device) and
  could then list in the Directory. It is a genuinely new product surface
  (authentication, consent, who hosts, auditability) and needs its own decision
  record before any work. Out of scope here.
- **A setup skill as the deployment mechanism.** Rejected: a skill is
  instructions Claude follows, not an installer. On Claude Desktop and the web
  it cannot register an MCP server at all; on Claude Code it would only re-run
  what the plugin already does, and it does not solve central, IT-managed
  rollout. A guided setup skill remains useful for the credential step once the
  server is connected, but it is not a distribution surface.

## Consequences and follow-ups

- IT can deploy org-wide with artefacts that already exist
  (`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, the `.mcpb`
  manifest). The remaining work is documentation and verifying the allowlist
  upload, not new runtime behaviour.
- The local-first boundary is preserved: the server runs on each user's machine
  and credentials stay on-device.
- Add an "Org / IT team rollout" section to `DEPLOY.md` covering the Desktop
  Extensions allowlist upload and the Claude Code managed-settings /
  `managed-mcp.json` snippets.
- Confirm whether the Desktop Extensions allowlist requires a signed `.mcpb`,
  and document the requirement (ties into the signing identity open question in
  `DEPLOY.md` §3).
- Update the README install section to name the org/admin path alongside the
  individual install paths.

## Sources

- Enabling and using the Desktop Extension allowlist —
  https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist
- Control MCP server access for your organization (`managed-mcp.json`,
  allow/deny lists) — https://code.claude.com/docs/en/managed-mcp
- Create and distribute a plugin marketplace —
  https://code.claude.com/docs/en/plugin-marketplaces
- Get started with custom connectors using remote MCP (remote-HTTPS-only) —
  https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Submitting to the Connectors Directory —
  https://claude.com/docs/connectors/building/submission
