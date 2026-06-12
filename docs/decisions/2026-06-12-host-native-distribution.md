# Host-native distribution replaces the standalone installer

- **Date:** 2026-06-12
- **Status:** Accepted
- **Affects:** Claude Desktop distribution, release workflow, desktop setup app

## Context

affiliate-mcp exists to bring affiliate data into the AI workspace a
professional already uses. The standalone Electron setup app removed Terminal
friction, but created another application to download, understand, update, and
support. It also configured only Claude Desktop even though the core and skills
are designed for multiple MCP hosts.

MCP hosts now provide native package and plugin installation. Claude Desktop
supports MCP Bundles (`.mcpb`), including a bundled Node runtime, extension
settings, and secure handling for sensitive values.

## Decision

Use each AI host's native installation system as the primary distribution path.

The first implementation is a Claude Desktop MCP Bundle:

- the bundle contains the complete local affiliate-mcp server;
- Claude Desktop owns installation, runtime, permissions, and secret storage;
- the manifest offers setup fields for the four launch networks with rich
  credential guidance;
- an existing `~/.affiliate-mcp/.env` remains usable for every other adapter;
- versioned GitHub releases carry the generated `.mcpb` artifact.

The Electron setup app remains a compatibility fallback while the host-native
path proves itself. It receives fixes but no new product scope.

## Consequences And Follow-Ups

- Add a portable loopback-only browser setup flow for all networks. It must use
  a one-time token, bind only to loopback, reject cross-origin requests, and
  keep credentials out of URLs.
- Package the MCP server and skills through the native Claude Code and Codex
  plugin systems.
- Publish standard installation metadata to the MCP Registry.
- Retire the standalone DMG after native installation and portable setup cover
  its remaining successful workflows.

The browser setup flow is deliberately separate because it introduces an HTTP
and credential-write security boundary. MCP form elicitation is not a
substitute: the protocol prohibits requesting API keys and access tokens through
ordinary form-mode elicitation.
