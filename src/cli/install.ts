/**
 * `affiliate-networks-mcp install` — connect this MCP server to Claude.
 *
 * Detects which Claude clients are installed (Desktop, Code) and wires up the
 * `affiliate` entry for each. Desktop edits go through a safe-edit module that
 * preserves any other MCP servers the user has configured and takes a
 * timestamped backup before any write. Code edits go through the `claude mcp`
 * CLI, which manages its own storage.
 *
 * Output channel: stdout. Same precedent as `setup`/`test`/`doctor` — JSON-RPC
 * is not active for these commands.
 */

import { getPrompter, type Prompter } from './wizard/prompts.js';
import {
  addAffiliateEntry,
  MalformedDesktopConfigError,
  removeAffiliateEntry,
  resolveDesktopConfigPath,
  type DesktopEditResult,
} from './install/claude-desktop.js';
import {
  addToClaudeCode,
  ClaudeCodeError,
  removeFromClaudeCode,
  type CodeResult,
} from './install/claude-code.js';
import { detectClients, type DetectionResult } from './install/detect.js';

export type InstallTarget = 'auto' | 'desktop' | 'code' | 'all';

export interface InstallOptions {
  prompter?: Prompter;
  target?: InstallTarget;
  dryRun?: boolean;
  forceOverwrite?: boolean;
  /** Overrides for tests. */
  detection?: DetectionResult;
  desktopConfigPathOverride?: string;
  spawnClaudeCode?: import('./install/claude-code.js').SpawnFn;
  /** When true, suppress the post-run "restart Claude" / verify hints. */
  quiet?: boolean;
}

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

interface ResolvedTargets {
  desktop: boolean;
  code: boolean;
}

async function resolveTargets(
  detection: DetectionResult,
  target: InstallTarget,
  prompter: Prompter,
): Promise<ResolvedTargets | null> {
  if (target === 'desktop') return { desktop: true, code: false };
  if (target === 'code') return { desktop: false, code: true };
  if (target === 'all') {
    return {
      desktop: detection.desktop !== 'notSupported',
      code: true,
    };
  }

  // auto mode — pick from what's detected.
  const desktopAvailable = detection.desktop === 'present';
  const codeAvailable = detection.code === 'present';

  if (!desktopAvailable && !codeAvailable) {
    if (detection.desktop === 'notSupported') {
      out('No supported Claude client detected.');
      out('Claude Desktop is not supported on this platform.');
      out('Install Claude Code (https://claude.com/claude-code) and re-run.');
    } else {
      out('No Claude client detected.');
      out('Install Claude Desktop (https://claude.ai/download) or Claude Code');
      out('(https://claude.com/claude-code) and re-run.');
    }
    return null;
  }

  if (desktopAvailable && codeAvailable) {
    const choice = await prompter.menu('Which Claude client(s) should I connect?', [
      { key: 'all', label: 'both — Claude Desktop and Claude Code' },
      { key: 'desktop', label: 'Claude Desktop only' },
      { key: 'code', label: 'Claude Code only' },
      { key: 'cancel', label: 'cancel — make no changes' },
    ]);
    if (choice === 'cancel') return null;
    if (choice === 'desktop') return { desktop: true, code: false };
    if (choice === 'code') return { desktop: false, code: true };
    return { desktop: true, code: true };
  }

  // Exactly one is available.
  return { desktop: desktopAvailable, code: codeAvailable };
}

export async function runInstall(opts: InstallOptions = {}): Promise<number> {
  const prompter = opts.prompter ?? getPrompter();
  const target = opts.target ?? 'auto';
  const dryRun = opts.dryRun ?? false;
  const forceOverwrite = opts.forceOverwrite ?? false;

  out('');
  out('  affiliate-networks-mcp — connect to Claude');
  out('  -----------------------------------------');
  out('');

  const detection = opts.detection ?? (await detectClients());
  const detectedParts: string[] = [];
  if (detection.desktop === 'present') detectedParts.push('Claude Desktop');
  if (detection.desktop === 'notSupported') detectedParts.push('(Claude Desktop not supported on this platform)');
  if (detection.code === 'present') detectedParts.push('Claude Code');
  if (detectedParts.length === 0) detectedParts.push('none');
  out(`Detected: ${detectedParts.join(', ')}`);
  out('');

  const targets = await resolveTargets(detection, target, prompter);
  if (!targets) return 0;

  if (targets.desktop && detection.desktop === 'notSupported') {
    out('Claude Desktop is not supported on this platform. Skipping.');
    targets.desktop = false;
  }

  if (!targets.desktop && !targets.code) {
    out('Nothing to do.');
    return 0;
  }

  let didDesktop = false;
  let didRestart = false;

  if (targets.desktop) {
    const desktopConfigPath =
      opts.desktopConfigPathOverride ?? detection.desktopConfigPath ?? resolveDesktopConfigPath();
    if (!desktopConfigPath) {
      out('Claude Desktop: could not resolve config path. Skipping.');
    } else {
      try {
        const result = await addAffiliateEntry({
          configPath: desktopConfigPath,
          dryRun,
          forceOverwrite,
          onConflict: async () => {
            const choice = await prompter.confirm(
              "Claude Desktop already has a different 'affiliate' entry. Overwrite?",
              { defaultYes: true },
            );
            return choice;
          },
        });
        printDesktopResult(result);
        didDesktop = true;
        if (result.action === 'created' || result.action === 'added' || result.action === 'updated') {
          didRestart = true;
        }
      } catch (err) {
        if (err instanceof MalformedDesktopConfigError) {
          out(`Claude Desktop: ${err.message}`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          out(`Claude Desktop: unexpected error — ${msg}`);
        }
        return 1;
      }
    }
  }

  if (targets.code) {
    try {
      const result = await addToClaudeCode({
        ...(opts.spawnClaudeCode ? { spawn: opts.spawnClaudeCode } : {}),
        dryRun,
      });
      printCodeResult(result);
    } catch (err) {
      if (err instanceof ClaudeCodeError) {
        out(`Claude Code: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        out(`Claude Code: unexpected error — ${msg}`);
      }
      return 1;
    }
  }

  if (!opts.quiet) {
    out('');
    if (didDesktop && didRestart) {
      out('Restart Claude Desktop for changes to take effect.');
    }
    out('Then ask Claude: "What affiliate networks do you have access to?"');
  }
  return 0;
}

export async function runUninstall(opts: InstallOptions = {}): Promise<number> {
  const prompter = opts.prompter ?? getPrompter();
  const target = opts.target ?? 'auto';
  const dryRun = opts.dryRun ?? false;

  out('');
  out('  affiliate-networks-mcp — disconnect from Claude');
  out('  ----------------------------------------------');
  out('');

  const detection = opts.detection ?? (await detectClients());
  const targets = await resolveTargets(detection, target, prompter);
  if (!targets) return 0;

  if (targets.desktop && detection.desktop === 'notSupported') {
    targets.desktop = false;
  }

  if (!targets.desktop && !targets.code) {
    out('Nothing to do.');
    return 0;
  }

  if (targets.desktop) {
    const desktopConfigPath =
      opts.desktopConfigPathOverride ?? detection.desktopConfigPath ?? resolveDesktopConfigPath();
    if (desktopConfigPath) {
      try {
        const result = await removeAffiliateEntry({ configPath: desktopConfigPath, dryRun });
        printDesktopResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out(`Claude Desktop: ${msg}`);
        return 1;
      }
    }
  }

  if (targets.code) {
    try {
      const result = await removeFromClaudeCode({
        ...(opts.spawnClaudeCode ? { spawn: opts.spawnClaudeCode } : {}),
        dryRun,
      });
      printCodeResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`Claude Code: ${msg}`);
      return 1;
    }
  }

  return 0;
}

function printDesktopResult(result: DesktopEditResult): void {
  const path = result.path;
  switch (result.action) {
    case 'created':
      out(`Claude Desktop: created ${path}`);
      break;
    case 'added':
      out(`Claude Desktop: added 'affiliate' to ${path}`);
      break;
    case 'updated':
      out(`Claude Desktop: updated 'affiliate' in ${path}`);
      break;
    case 'unchanged':
      out(`Claude Desktop: 'affiliate' already configured in ${path} — no change`);
      break;
    case 'removed':
      out(`Claude Desktop: removed 'affiliate' from ${path}`);
      break;
    case 'absent':
      out(`Claude Desktop: 'affiliate' was not present in ${path}`);
      break;
    case 'would-create':
      out(`Claude Desktop (dry-run): would create ${path}`);
      break;
    case 'would-add':
      out(`Claude Desktop (dry-run): would add 'affiliate' to ${path}`);
      break;
    case 'would-update':
      out(`Claude Desktop (dry-run): would update 'affiliate' in ${path}`);
      break;
    case 'would-remove':
      out(`Claude Desktop (dry-run): would remove 'affiliate' from ${path}`);
      break;
  }
  if (result.backupPath) {
    out(`  Backup: ${result.backupPath}`);
  }
}

function printCodeResult(result: CodeResult): void {
  switch (result.action) {
    case 'added':
      out("Claude Code: added 'affiliate'");
      break;
    case 'updated':
      out("Claude Code: updated 'affiliate' (removed and re-added)");
      break;
    case 'unchanged':
      out("Claude Code: 'affiliate' already configured — no change");
      break;
    case 'removed':
      out("Claude Code: removed 'affiliate'");
      break;
    case 'absent':
      out("Claude Code: 'affiliate' was not present");
      break;
    case 'would-add':
      out("Claude Code (dry-run): would add 'affiliate'");
      break;
    case 'would-update':
      out("Claude Code (dry-run): would update 'affiliate'");
      break;
    case 'would-remove':
      out("Claude Code (dry-run): would remove 'affiliate'");
      break;
  }
}
