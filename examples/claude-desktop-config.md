# Example: Claude Desktop config for affiliate-mcp

JSON does not support comments, so this file is the prose companion to
[`claude-desktop-config.json`](./claude-desktop-config.json). It explains what
each field does and how to adapt the example to your own setup.

## Where this file lives

Claude Desktop reads its MCP server configuration from
`claude_desktop_config.json` in the application's user-config directory:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Restart Claude Desktop after editing the file.

## Field-by-field

```json
{
  "mcpServers": {
    "affiliate": {
      "command": "npx",
      "args": ["affiliate-networks-mcp"],
      "env": {
        "AWIN_API_TOKEN": "your-token-here",
        "AWIN_PUBLISHER_ID": "your-id-here"
      }
    }
  }
}
```

- `mcpServers.affiliate` — the key is the local name Claude Desktop uses to
  refer to this server in its UI. You can rename it to anything; tools will
  still be exposed under their `affiliate_<network>_…` names.
- `command` — `npx` runs the published `affiliate-networks-mcp` binary without a
  global install. If you have installed the package globally
  (`npm install -g affiliate-networks-mcp`), you can replace this with
  `affiliate-networks-mcp` and drop the `args` entry.
- `args` — the package name when invoked via `npx`. Add `--config-dir
  /some/path` here if you want to override the default `~/.affiliate-mcp/`
  config directory.
- `env` — per-server environment variables. The example shows two Awin
  values; in practice you almost never need to set these here because the
  setup wizard writes them to `~/.affiliate-mcp/.env` (mode `0600`) and the
  server loads that file at startup. The `env` block is useful only if you
  want to override or scope credentials to this single MCP client.

## The recommended flow

1. Run `npx affiliate-networks-mcp setup` once. The wizard validates each credential
   against the live network and writes `~/.affiliate-mcp/.env`.
2. Add the minimal config to Claude Desktop — only `command` and `args`:

   ```json
   {
     "mcpServers": {
       "affiliate": {
         "command": "npx",
         "args": ["affiliate-networks-mcp"]
       }
     }
   }
   ```

3. Restart Claude Desktop. Open a new conversation and type "list my
   affiliate networks" — the meta-tool `affiliate_list_networks` should fire.

## Troubleshooting

- Tools do not appear: check the Claude Desktop logs (Settings → Developer →
  View logs). Run `npx affiliate-networks-mcp doctor` in a terminal to confirm the
  server can start.
- A specific network errors: run `npx affiliate-networks-mcp doctor <slug>` (for
  example `npx affiliate-networks-mcp doctor awin`) and follow the suggested
  remediation in the output.
- You see no `affiliate_*` tools at all: the server probably failed to start
  because no credentials were configured. Run the wizard.
