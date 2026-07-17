/**
 * First-run launch decision.
 *
 * The bare `affiliate-networks-mcp` command (no subcommand) is used in two very
 * different contexts:
 *
 *   - A human types it in a terminal. Here stdin is a TTY, and if no config
 *     file exists yet the friendliest thing is to print a pointer to `setup`
 *     and exit, rather than block on a stdio transport the user did not ask for.
 *   - An MCP client (Claude Desktop, the claude.ai connector, Codex) launches it
 *     over stdio. Here stdin is a pipe, not a TTY. The client expects a live
 *     server that answers `initialize`. Exiting — even cleanly — reads to the
 *     client as "Server disconnected", and the stderr banner pointing at `setup`
 *     is invisible in that surface.
 *
 * So the banner-and-exit path is correct ONLY when both: no config exists AND
 * we are attached to an interactive terminal. In every other case we start the
 * server, and unconfigured networks surface as per-tool `config_error`
 * envelopes (see `requireCredential`) the client can actually show the user.
 *
 * Kept as a pure function so the decision is unit-testable without spawning a
 * subprocess or faking a pseudo-terminal.
 */
export interface FirstRunContext {
  /** True when no config file exists yet (see `isFirstRun`). */
  firstRun: boolean;
  /** True when stdin is an interactive terminal (`process.stdin.isTTY`). */
  interactive: boolean;
}

/**
 * Whether the bare-command path should print the first-run banner and exit
 * instead of starting the MCP server.
 */
export function shouldShowFirstRunBanner(ctx: FirstRunContext): boolean {
  return ctx.firstRun && ctx.interactive;
}
