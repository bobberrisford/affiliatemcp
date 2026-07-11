# Affiliate Networks MCP Bundle

This is affiliate-mcp's primary **non-technical onboarding track**: the
host-native Claude Desktop package for
[affiliate-mcp](https://github.com/bobberrisford/affiliatemcp). It runs the
complete local MCP server without requiring Node.js, Terminal, or manual edits
to `claude_desktop_config.json`.

During installation, Claude Desktop can securely collect credentials for Awin,
CJ, Impact, and Partnerize. Password-style values are stored using the secure
credential handling provided by Claude Desktop.

The complete server includes every affiliate-mcp adapter. If you already use
other networks, select your existing `~/.affiliate-mcp` configuration directory
during installation. Until the portable browser setup flow ships, adding a new
network outside the four listed above uses the technical CLI track:

```sh
npx affiliate-networks-mcp setup
```

The standalone Electron/DMG setup app is a fixes-only compatibility fallback,
not another primary onboarding track.

## Updating

The extension does not update itself. To update, download the latest
`affiliate-networks-mcp-<version>.mcpb` from the
[GitHub releases page](https://github.com/bobberrisford/affiliatemcp/releases/latest)
and install it over the top via **Settings → Extensions → Advanced settings →
Install Extension…**. Claude Desktop treats it as the same extension, so your
saved credentials and settings are kept.

Credentials and affiliate API calls remain on your machine. See the project
[privacy policy](https://github.com/bobberrisford/affiliatemcp/blob/main/PRIVACY.md)
for details. Anonymous usage telemetry is optional and off by default in the
extension settings.
