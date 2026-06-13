/**
 * `affiliate-networks-mcp install` — connect this MCP server to AI clients.
 *
 * Detects which Claude clients are installed (Desktop, Code) and can also wire
 * Codex and GitHub Copilot (VS Code) directly through their local MCP configs.
 * Desktop, Codex, and Copilot edits go through safe-edit modules that
 * preserve any other MCP servers the user has configured and take a
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
import {
  addAffiliateCodexEntry,
  removeAffiliateCodexEntry,
  resolveCodexConfigPath,
  type CodexEditResult,
} from './install/codex.js';
import {
  addAffiliateCopilotEntry,
  MalformedCopilotConfigError,
  removeAffiliateCopilotEntry,
  resolveCopilotConfigPath,
  type CopilotEditResult,
} from './install/copilot.js';

export type InstallTarget =
  | 'auto'
  | 'desktop'
  | 'code'
  | 'codex'
  | 'copilot'
  | 'all'
  | 'cowork';

export interface InstallOptions {
  prompter?: Prompter;
  target?: InstallTarget;
  dryRun?: boolean;
  forceOverwrite?: boolean;
  /** Overrides for tests. */
  detection?: DetectionResult;
  desktopConfigPathOverride?: string;
  codexConfigPathOverride?: string;
  copilotConfigPathOverride?: string;
  spawnClaudeCode?: import('./install/claude-code.js').SpawnFn;
  /** Override for tests — the Cowork mirror runner. */
  coworkMirror?: typeof import('./install/cowork-mirror.js').runCoworkMirror;
  /** When true, suppress the post-run "restart Claude" / verify hints. */
  quiet?: boolean;
}

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

interface ResolvedTargets {
  desktop: boolean;
  code: boolean;
  cowork: boolean;
  codex: boolean;
  copilot: boolean;
}

const NO_TARGETS: ResolvedTargets = {
  desktop: false,
  code: false,
  cowork: false,
  codex: false,
  copilot: false,
};

async function resolveTargets(
  detection: DetectionResult,
  target: InstallTarget,
  prompter: Prompter,
): Promise<ResolvedTargets | null> {
  if (target === 'desktop') return { ...NO_TARGETS, desktop: true };
  if (target === 'code') return { ...NO_TARGETS, code: true };
  if (target === 'codex') return { ...NO_TARGETS, codex: true };
  if (target === 'copilot') return { ...NO_TARGETS, copilot: true };
  if (target === 'cowork') return { ...NO_TARGETS, cowork: true };
  if (target === 'all') {
    // --all is the no-prompt path. Codex and Copilot are included because they
    // are local file writes and do not require the client to be installed.
    // Cowork is deliberately excluded: it creates a GitHub repo and is best
    // done interactively (or via `--cowork`).
    return {
      desktop: detection.desktop !== 'notSupported',
      code: true,
      cowork: false,
      codex: true,
      copilot: true,
    };
  }

  // auto mode — pick from what's detected. Cowork can't be reliably detected
  // on disk (separate org app), so it's always offered as a choice rather than
  // gated on detection.
  const desktopAvailable = detection.desktop === 'present';
  const codeAvailable = detection.code === 'present';
  const codexAvailable = detection.codex === 'present';
  const copilotAvailable = detection.copilot === 'present';
  const availableCount = [
    desktopAvailable,
    codeAvailable,
    codexAvailable,
    copilotAvailable,
  ].filter(Boolean).length;

  if (availableCount === 0) {
    // No detected config-editable client. Still offer Codex and Copilot because
    // their installers only write a local config file and do not need the CLI.
    const choice = await prompter.menu(
      'No Claude Desktop, Claude Code, Codex, or GitHub Copilot found. Which client should I connect?',
      [
        { key: 'codex', label: 'connect to Codex (OpenAI, local MCP)' },
        { key: 'copilot', label: 'connect to GitHub Copilot (VS Code, local MCP)' },
        { key: 'cowork', label: 'create a private GitHub mirror for Cowork' },
        { key: 'cancel', label: 'make no changes' },
      ],
    );
    if (choice === 'codex') return { ...NO_TARGETS, codex: true };
    if (choice === 'copilot') return { ...NO_TARGETS, copilot: true };
    if (choice === 'cowork') return { ...NO_TARGETS, cowork: true };
    if (detection.desktop === 'notSupported') {
      out('Claude Desktop is not supported on this platform.');
      out('Install Claude Code (https://claude.com/claude-code), Codex, VS Code +');
      out('GitHub Copilot, or re-run with --codex / --copilot.');
    } else {
      out('No Claude, Codex, or Copilot client detected.');
      out('Install Claude Desktop (https://claude.ai/download), Claude Code');
      out('(https://claude.com/claude-code), Codex, VS Code + GitHub Copilot,');
      out('or re-run with --codex / --copilot.');
    }
    return null;
  }

  if (availableCount > 1) {
    const choices = [{ key: 'all', label: 'all detected local clients' }];
    if (desktopAvailable) choices.push({ key: 'desktop', label: 'Claude Desktop only' });
    if (codeAvailable) choices.push({ key: 'code', label: 'Claude Code only' });
    if (codexAvailable) choices.push({ key: 'codex', label: 'Codex only (OpenAI, local MCP)' });
    if (copilotAvailable)
      choices.push({ key: 'copilot', label: 'GitHub Copilot only (VS Code, local MCP)' });
    choices.push(
      { key: 'cowork', label: 'Claude Cowork (org marketplace via private mirror)' },
      { key: 'cancel', label: 'cancel — make no changes' },
    );
    const choice = await prompter.menu('Which AI client(s) should I connect?', choices);
    if (choice === 'cancel') return null;
    if (choice === 'desktop') return { ...NO_TARGETS, desktop: true };
    if (choice === 'code') return { ...NO_TARGETS, code: true };
    if (choice === 'codex') return { ...NO_TARGETS, codex: true };
    if (choice === 'copilot') return { ...NO_TARGETS, copilot: true };
    if (choice === 'cowork') return { ...NO_TARGETS, cowork: true };
    return {
      desktop: desktopAvailable,
      code: codeAvailable,
      cowork: false,
      codex: codexAvailable,
      copilot: copilotAvailable,
    };
  }

  // Exactly one config-editable client is available.
  return {
    desktop: desktopAvailable,
    code: codeAvailable,
    cowork: false,
    codex: codexAvailable,
    copilot: copilotAvailable,
  };
}

export async function runInstall(opts: InstallOptions = {}): Promise<number> {
  const prompter = opts.prompter ?? getPrompter();
  const target = opts.target ?? 'auto';
  const dryRun = opts.dryRun ?? false;
  const forceOverwrite = opts.forceOverwrite ?? false;

  out('');
  out('  affiliate-networks-mcp — connect to AI clients');
  out('  ---------------------------------------------');
  out('');

  const detection = opts.detection ?? (await detectClients());
  const detectedParts: string[] = [];
  if (detection.desktop === 'present') detectedParts.push('Claude Desktop');
  if (detection.desktop === 'notSupported') detectedParts.push('(Claude Desktop not supported on this platform)');
  if (detection.code === 'present') detectedParts.push('Claude Code');
  if (detection.codex === 'present') detectedParts.push('Codex');
  if (detection.copilot === 'present') detectedParts.push('GitHub Copilot');
  if (detectedParts.length === 0) detectedParts.push('none');
  out(`Detected: ${detectedParts.join(', ')}`);
  out('');

  const targets = await resolveTargets(detection, target, prompter);
  if (!targets) return 0;

  if (targets.cowork) {
    const { CoworkMirrorError, GitHubBackendError } = await import('./install/cowork-mirror.js');
    const mirror = opts.coworkMirror ?? (await import('./install/cowork-mirror.js')).runCoworkMirror;
    try {
      await mirror({ dryRun, prompter });
      return 0;
    } catch (err) {
      if (err instanceof CoworkMirrorError || err instanceof GitHubBackendError) {
        out(err.message);
        return 1;
      }
      throw err;
    }
  }

  if (targets.desktop && detection.desktop === 'notSupported') {
    out('Claude Desktop is not supported on this platform. Skipping.');
    targets.desktop = false;
  }

  if (!targets.desktop && !targets.code && !targets.codex && !targets.copilot) {
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

  if (targets.codex) {
    try {
      const result = await addAffiliateCodexEntry({
        configPath: opts.codexConfigPathOverride ?? resolveCodexConfigPath(),
        dryRun,
      });
      printCodexResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`Codex: unexpected error — ${msg}`);
      return 1;
    }
  }

  if (targets.copilot) {
    try {
      const result = await addAffiliateCopilotEntry({
        configPath: opts.copilotConfigPathOverride ?? resolveCopilotConfigPath(),
        dryRun,
        forceOverwrite,
        onConflict: async () => {
          return prompter.confirm(
            "GitHub Copilot already has a different 'affiliate' entry. Overwrite?",
            { defaultYes: true },
          );
        },
      });
      printCopilotResult(result);
    } catch (err) {
      if (err instanceof MalformedCopilotConfigError) {
        out(`GitHub Copilot: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        out(`GitHub Copilot: unexpected error — ${msg}`);
      }
      return 1;
    }
  }

  if (!opts.quiet) {
    out('');
    if (didDesktop && didRestart) {
      out('Restart Claude Desktop for changes to take effect.');
    }
    if (targets.copilot) {
      out('In VS Code, reload the window, open the Copilot Chat view, switch to');
      out('Agent mode, then ask: "What affiliate networks do you have access to?"');
    } else if (targets.codex) {
      out('Open Codex, run /mcp, then ask: "What affiliate networks do you have access to?"');
    } else {
      out('Then ask Claude: "What affiliate networks do you have access to?"');
    }
  }
  return 0;
}

export async function runUninstall(opts: InstallOptions = {}): Promise<number> {
  const prompter = opts.prompter ?? getPrompter();
  const target = opts.target ?? 'auto';
  const dryRun = opts.dryRun ?? false;

  out('');
  out('  affiliate-networks-mcp — disconnect from AI clients');
  out('  --------------------------------------------------');
  out('');

  const detection = opts.detection ?? (await detectClients());
  const targets = await resolveTargets(detection, target, prompter);
  if (!targets) return 0;

  if (targets.cowork) {
    // We can't remove a plugin from someone's Cowork org marketplace from out
    // here, so we hand back the manual steps rather than pretend to act.
    out('To remove from Cowork: Organization settings → Plugins → find');
    out("'affiliate-networks-mcp' → Remove.");
    out('If you no longer need it, you can also delete the private mirror repo');
    out('from GitHub.');
    return 0;
  }

  if (targets.desktop && detection.desktop === 'notSupported') {
    targets.desktop = false;
  }

  if (!targets.desktop && !targets.code && !targets.codex && !targets.copilot) {
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

  if (targets.codex) {
    try {
      const result = await removeAffiliateCodexEntry({
        configPath: opts.codexConfigPathOverride ?? resolveCodexConfigPath(),
        dryRun,
      });
      printCodexResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`Codex: ${msg}`);
      return 1;
    }
  }

  if (targets.copilot) {
    try {
      const result = await removeAffiliateCopilotEntry({
        configPath: opts.copilotConfigPathOverride ?? resolveCopilotConfigPath(),
        dryRun,
      });
      printCopilotResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`GitHub Copilot: ${msg}`);
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

function printCodexResult(result: CodexEditResult): void {
  const path = result.path;
  switch (result.action) {
    case 'created':
      out(`Codex: created ${path}`);
      break;
    case 'added':
      out(`Codex: added 'affiliate' to ${path}`);
      break;
    case 'updated':
      out(`Codex: updated 'affiliate' in ${path}`);
      break;
    case 'unchanged':
      out(`Codex: 'affiliate' already configured in ${path} — no change`);
      break;
    case 'removed':
      out(`Codex: removed 'affiliate' from ${path}`);
      break;
    case 'absent':
      out(`Codex: 'affiliate' was not present in ${path}`);
      break;
    case 'would-create':
      out(`Codex (dry-run): would create ${path}`);
      break;
    case 'would-add':
      out(`Codex (dry-run): would add 'affiliate' to ${path}`);
      break;
    case 'would-update':
      out(`Codex (dry-run): would update 'affiliate' in ${path}`);
      break;
    case 'would-remove':
      out(`Codex (dry-run): would remove 'affiliate' from ${path}`);
      break;
  }
  if (result.backupPath) {
    out(`  Backup: ${result.backupPath}`);
  }
}

function printCopilotResult(result: CopilotEditResult): void {
  const path = result.path;
  switch (result.action) {
    case 'created':
      out(`GitHub Copilot: created ${path}`);
      break;
    case 'added':
      out(`GitHub Copilot: added 'affiliate' to ${path}`);
      break;
    case 'updated':
      out(`GitHub Copilot: updated 'affiliate' in ${path}`);
      break;
    case 'unchanged':
      out(`GitHub Copilot: 'affiliate' already configured in ${path} — no change`);
      break;
    case 'removed':
      out(`GitHub Copilot: removed 'affiliate' from ${path}`);
      break;
    case 'absent':
      out(`GitHub Copilot: 'affiliate' was not present in ${path}`);
      break;
    case 'would-create':
      out(`GitHub Copilot (dry-run): would create ${path}`);
      break;
    case 'would-add':
      out(`GitHub Copilot (dry-run): would add 'affiliate' to ${path}`);
      break;
    case 'would-update':
      out(`GitHub Copilot (dry-run): would update 'affiliate' in ${path}`);
      break;
    case 'would-remove':
      out(`GitHub Copilot (dry-run): would remove 'affiliate' from ${path}`);
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
