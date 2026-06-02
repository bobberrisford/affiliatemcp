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
  write('  affiliate-networks-mcp — first run detected');
  write('  -----------------------------------------');
  write(`  No config file at ${CONFIG_ENV_FILE}.`);
  write('  Run `affiliate-networks-mcp setup` to configure your networks.');
  write('  See https://github.com/atolls/affiliate-mcp for documentation.');
  write('');
}

function printHelp(): void {
  write('affiliate-networks-mcp — MCP server for affiliate networks (Awin, CJ, Impact, Rakuten)');
  write('');
  write('Usage:');
  write('  affiliate-networks-mcp                 Start the MCP server on stdio');
  write('  affiliate-networks-mcp setup           Interactive setup wizard');
  write('  affiliate-networks-mcp install         Connect to Claude Desktop / Claude Code');
  write('  affiliate-networks-mcp uninstall       Remove the affiliate entry from Claude clients');
  write('  affiliate-networks-mcp test            Friendly diagnostic against configured networks');
  write('  affiliate-networks-mcp doctor          Verbose diagnostic with raw responses');
  write('  affiliate-networks-mcp validate <slug> Run the full validation suite against one network');
  write('  affiliate-networks-mcp consent <action> Manage doing-layer consent grants (grant/revoke/list)');
  write('  affiliate-networks-mcp --help          Show this help');
  write('');
  write('install/uninstall flags:');
  write('  --desktop          Target Claude Desktop only');
  write('  --code             Target Claude Code only');
  write('  --all              Target both, no prompt');
  write('  --dry-run          Show what would change without writing');
  write('  --force-overwrite  Rewrite a malformed Claude Desktop config (backs up first)');
  write('');
}

interface InstallFlags {
  target: 'auto' | 'desktop' | 'code' | 'all';
  dryRun: boolean;
  forceOverwrite: boolean;
}

function parseInstallFlags(rest: string[]): InstallFlags {
  const flags: InstallFlags = { target: 'auto', dryRun: false, forceOverwrite: false };
  for (const arg of rest) {
    switch (arg) {
      case '--desktop':
        flags.target = 'desktop';
        break;
      case '--code':
        flags.target = 'code';
        break;
      case '--all':
        flags.target = 'all';
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--force-overwrite':
        flags.forceOverwrite = true;
        break;
      default:
        throw new Error(`Unknown flag for install/uninstall: ${arg}`);
    }
  }
  return flags;
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
      // startServer() resolves as soon as the stdio transport's data listeners
      // are attached. main() returns trigger `process.exit(code)` (see bottom
      // of this file), which is a hard exit and would kill the server before
      // any MCP message is processed. Block forever so the transport stays
      // live until the parent client disconnects stdin or sends SIGTERM.
      await new Promise<never>(() => {});
      return 0; // unreachable
    }
    case 'setup': {
      const { runSetup } = await import('./cli/setup.js');
      return await runSetup();
    }
    case 'install': {
      const { runInstall } = await import('./cli/install.js');
      try {
        const flags = parseInstallFlags(rest);
        return await runInstall(flags);
      } catch (err) {
        write((err as Error).message);
        return 2;
      }
    }
    case 'uninstall': {
      const { runUninstall } = await import('./cli/install.js');
      try {
        const flags = parseInstallFlags(rest);
        return await runUninstall(flags);
      } catch (err) {
        write((err as Error).message);
        return 2;
      }
    }
    case 'test': {
      const { runTest } = await import('./cli/test.js');
      const slug = rest[0];
      return await runTest(slug ? { slug } : {});
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli/doctor.js');
      const slug = rest[0];
      return await runDoctor(slug ? { slug } : {});
    }
    case 'validate': {
      const slug = rest[0];
      if (!slug) {
        write('Usage: affiliate-networks-mcp validate <network-slug>');
        return 2;
      }
      const { validateNetwork } = await import('./shared/diagnostic.js');
      const result = await validateNetwork(slug);
      write(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    case 'consent': {
      const { runConsent, parseConsentArgs } = await import('./cli/consent.js');
      try {
        return await runConsent(parseConsentArgs(rest));
      } catch (err) {
        write((err as Error).message);
        return 2;
      }
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
    process.stderr.write(`affiliate-networks-mcp fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
