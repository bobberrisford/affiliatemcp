# Updating affiliate-mcp

The project ships updates frequently during the beta. How you update depends
on how you installed. Nothing here re-enters credentials: every path below
keeps your existing configuration.

## Claude Desktop extension (`.mcpb`): re-download it

The extension cannot update itself and does not show an update notice inside
Claude Desktop. To update:

1. Download the latest `affiliate-networks-mcp-<version>.mcpb` from the
   [releases page](https://github.com/bobberrisford/affiliatemcp/releases/latest).
2. Install it exactly as you did the first time: **Settings → Extensions →
   Advanced settings → Install Extension…** and select the downloaded file.

Claude Desktop replaces the old version in place and keeps your saved
credentials and settings, because the extension name stays the same. To hear
about new releases, watch the repository or check the releases page.

## CLI and npx installs: one command

This covers the Claude Desktop config entry, Codex, and any other local stdio
client configured to run `npx affiliate-networks-mcp`:

```
npx affiliate-networks-mcp update          # apply the latest release now
npx affiliate-networks-mcp update check    # report current vs latest, change nothing
```

The server also checks npm once per day and prints a startup notice when a
newer release exists; the check is anonymous and documented in
[PRIVACY.md](../PRIVACY.md). Silent auto-update is off by default; opt in
with `npx affiliate-networks-mcp update enable`.

## Claude Code plugin: re-run the install

It fetches the latest release:

```
claude plugin install affiliate-networks-mcp@affiliatemcp
```

## Claude Cowork mirror: re-sync, then update the plugin

Run `npx affiliate-networks-mcp cowork-mirror --sync` to refresh the private
mirror, then update the plugin from the synced marketplace in Cowork.

## Standalone desktop app (DMG): nothing to do

It checks GitHub Releases on launch and installs updates on quit. If an
update fails, the app shows a download banner instead.
