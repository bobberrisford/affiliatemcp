#!/usr/bin/env node
/**
 * affiliate-mcp CLI entry point.
 *
 * - With no arguments: detect first-run (no `~/.affiliate-mcp/.env`). If
 *   first-run, print a friendly pointer to `affiliate-mcp setup` and exit.
 *   Otherwise start the MCP server on stdio.
 * - Subcommands: `setup`, `test`, `doctor`, `validate <slug>`. At v0.1 most
 *   are stubs printing "implemented in chunk N" — the orchestrator wires the
 *   real behaviour in later chunks.
 *
 * Output rules: nothing on stdout unless we're running the MCP server (stdout
 * is the protocol channel). User-facing CLI text goes to stderr.
 */

import { isFirstRun, loadConfig, CONFIG_ENV_FILE } from './shared/config.js';

// Side-effect import: registers every network adapter with the shared registry.
// Must precede any subcommand path (validate/setup/test/doctor) that consults it.
import './networks/index.js';

function write(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

function printFirstRunBanner(): void {
  write('');
  write('  affiliate-mcp — first run detected');
  write('  --------------------------------');
  write(`  No config file at ${CONFIG_ENV_FILE}.`);
  write('  Run `affiliate-mcp setup` to configure your networks.');
  write('  See https://github.com/atolls/affiliate-mcp for documentation.');
  write('');
}

function printStub(message: string): void {
  write(message);
}

function printHelp(): void {
  write('affiliate-mcp — MCP server for affiliate networks (Awin, CJ, Impact, Rakuten)');
  write('');
  write('Usage:');
  write('  affiliate-mcp                 Start the MCP server on stdio');
  write('  affiliate-mcp setup           Interactive setup wizard');
  write('  affiliate-mcp test            Friendly diagnostic against configured networks');
  write('  affiliate-mcp doctor          Verbose diagnostic with raw responses');
  write('  affiliate-mcp validate <slug> Run the full validation suite against one network');
  write('  affiliate-mcp --help          Show this help');
  write('');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return 0;
  }

  // Load config for every path; only the no-arg server path treats absence as first-run.
  loadConfig();

  switch (cmd) {
    case undefined: {
      if (isFirstRun()) {
        printFirstRunBanner();
        return 0;
      }
      const { startServer } = await import('./server.js');
      await startServer();
      return 0;
    }
    case 'setup': {
      printStub('`affiliate-mcp setup` — implemented in chunk 4 (setup wizard).');
      return 0;
    }
    case 'test': {
      printStub('`affiliate-mcp test` — implemented in chunk 4 (setup wizard).');
      return 0;
    }
    case 'doctor': {
      printStub('`affiliate-mcp doctor` — implemented in chunk 4 (setup wizard).');
      return 0;
    }
    case 'validate': {
      const slug = rest[0];
      if (!slug) {
        write('Usage: affiliate-mcp validate <network-slug>');
        return 2;
      }
      const { validateNetwork } = await import('./shared/diagnostic.js');
      const result = await validateNetwork(slug);
      write(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    default: {
      write(`Unknown command: ${cmd}`);
      printHelp();
      return 2;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`affiliate-mcp fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
