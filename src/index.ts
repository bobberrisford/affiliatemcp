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
  write('  affiliate-networks-mcp install         Connect to Claude Desktop / Claude Code / Codex');
  write('  affiliate-networks-mcp uninstall       Remove the affiliate entry from AI clients');
  write('  affiliate-networks-mcp test            Friendly diagnostic against configured networks');
  write('  affiliate-networks-mcp doctor          Verbose diagnostic with raw responses');
  write('  affiliate-networks-mcp cowork-mirror   Create a private GitHub mirror for Claude Cowork');
  write('  affiliate-networks-mcp validate <slug> Run the full validation suite against one network');
  write('  affiliate-networks-mcp --help          Show this help');
  write('');
  write('install/uninstall flags:');
  write('  --desktop          Target Claude Desktop only');
  write('  --code             Target Claude Code only');
  write('  --codex            Target Codex only (OpenAI, local stdio MCP)');
  write('  --cowork           Set up for Claude Cowork (private GitHub mirror)');
  write('  --all              Target Desktop + Code + Codex, no prompt');
  write('  --dry-run          Show what would change without writing');
  write('  --force-overwrite  Rewrite a malformed Claude Desktop config (backs up first)');
  write('');
  write('cowork-mirror flags:');
  write('  [name]             Repo name to create (default: affiliatemcp-internal)');
  write('  --sync             Re-mirror upstream into an existing private repo');
  write('  --use-gh           Force the GitHub CLI path');
  write('  --use-pat          Force the token path (skip gh detection)');
  write('  --non-interactive  Never prompt; requires gh or AFFILIATE_MCP_GITHUB_TOKEN');
  write('  --dry-run          Report what would change without touching GitHub');
  write('');
}

interface InstallFlags {
  target: 'auto' | 'desktop' | 'code' | 'codex' | 'all' | 'cowork';
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
      case '--codex':
        flags.target = 'codex';
        break;
      case '--cowork':
        flags.target = 'cowork';
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

interface CoworkMirrorFlags {
  repoName?: string;
  sync: boolean;
  dryRun: boolean;
  nonInteractive: boolean;
  prefer?: 'gh' | 'pat';
}

function parseCoworkMirrorFlags(rest: string[]): CoworkMirrorFlags {
  const flags: CoworkMirrorFlags = { sync: false, dryRun: false, nonInteractive: false };
  for (const arg of rest) {
    switch (arg) {
      case '--sync':
        flags.sync = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--non-interactive':
        flags.nonInteractive = true;
        break;
      case '--use-gh':
        flags.prefer = 'gh';
        break;
      case '--use-pat':
        flags.prefer = 'pat';
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag for cowork-mirror: ${arg}`);
        }
        if (flags.repoName !== undefined) {
          throw new Error(`Unexpected extra argument for cowork-mirror: ${arg}`);
        }
        flags.repoName = arg;
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
    case 'cowork-mirror': {
      const { runCoworkMirror, CoworkMirrorError, GitHubBackendError } = await import(
        './cli/install/cowork-mirror.js'
      );
      try {
        const flags = parseCoworkMirrorFlags(rest);
        await runCoworkMirror({
          sync: flags.sync,
          dryRun: flags.dryRun,
          nonInteractive: flags.nonInteractive,
          ...(flags.repoName ? { repoName: flags.repoName } : {}),
          ...(flags.prefer ? { prefer: flags.prefer } : {}),
        });
        return 0;
      } catch (err) {
        if (err instanceof CoworkMirrorError || err instanceof GitHubBackendError) {
          write(err.message);
          return 1;
        }
        if (err instanceof Error && err.message.startsWith('Unknown flag')) {
          write(err.message);
          return 2;
        }
        throw err;
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
