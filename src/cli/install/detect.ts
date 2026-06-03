/**
 * Detect which Claude and Codex clients are installed on this machine.
 *
 * Claude Desktop is detected by either the config file or the app bundle
 * existing — we accept either signal because the config file is only created
 * on first launch, but a freshly-installed-but-never-launched app should
 * still count.
 *
 * Claude Code is detected by `claude --version` succeeding. We can't rely
 * on a `which`-style probe alone because shims or wrappers may pass it but
 * fail to exec; running the binary is the real test.
 *
 * Codex is detected by either an existing `~/.codex` config directory or
 * `codex --version` succeeding. The installer still supports `--codex` when
 * this probe says absent; detection is only for auto-mode prompts.
 *
 * GitHub Copilot (VS Code) is detected by either the VS Code user config
 * directory existing or `code --version` succeeding. As with Codex, `--copilot`
 * still works when this probe says absent.
 *
 * Linux Desktop is reported as `notSupported` rather than `absent` so the
 * orchestrator can tell the user why it's skipping rather than silently
 * doing nothing.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveDesktopConfigPath } from './claude-desktop.js';
import { resolveCodexConfigPath } from './codex.js';
import { resolveCopilotUserDir } from './copilot.js';

export type DesktopState = 'present' | 'absent' | 'notSupported';
export type CodeState = 'present' | 'absent';
export type CodexState = 'present' | 'absent';
export type CopilotState = 'present' | 'absent';

export interface DetectionResult {
  desktop: DesktopState;
  desktopConfigPath: string | null;
  code: CodeState;
  codex?: CodexState;
  copilot?: CopilotState;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Override for tests. Resolves to true if Claude Code appears installed. */
  probeClaudeCode?: () => Promise<boolean>;
  /** Override for tests. Resolves to true if Claude Desktop app bundle exists. */
  probeDesktopBundle?: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => boolean;
  /** Override for tests. Resolves to true if Codex appears installed. */
  probeCodex?: () => Promise<boolean>;
  /** Override for tests. Resolves to true if VS Code (Copilot) appears installed. */
  probeCopilot?: () => Promise<boolean>;
}

export async function detectClients(opts: DetectOptions = {}): Promise<DetectionResult> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const probeCode = opts.probeClaudeCode ?? defaultProbeClaudeCode;
  const probeBundle = opts.probeDesktopBundle ?? defaultProbeDesktopBundle;
  const probeCodex = opts.probeCodex ?? (() => defaultProbeCodex(env));
  const probeCopilot = opts.probeCopilot ?? (() => defaultProbeCopilot(platform, env));

  const desktopConfigPath = resolveDesktopConfigPath(platform, env);
  let desktop: DesktopState;
  if (desktopConfigPath === null) {
    desktop = 'notSupported';
  } else if (existsSync(desktopConfigPath) || probeBundle(platform, env)) {
    desktop = 'present';
  } else {
    desktop = 'absent';
  }

  const code: CodeState = (await probeCode()) ? 'present' : 'absent';
  const codex: CodexState = (await probeCodex()) ? 'present' : 'absent';
  const copilot: CopilotState = (await probeCopilot()) ? 'present' : 'absent';

  return { desktop, desktopConfigPath, code, codex, copilot };
}

function defaultProbeDesktopBundle(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'darwin') {
    // System-wide install or a per-user one under ~/Applications — Claude
    // Desktop can live in either, so a missing /Applications copy alone must
    // not be read as "not installed".
    return (
      existsSync('/Applications/Claude.app') ||
      existsSync(path.join(homedir(), 'Applications', 'Claude.app'))
    );
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (!localAppData) return false;
    return existsSync(`${localAppData}\\Programs\\claude`);
  }
  return false;
}

async function defaultProbeClaudeCode(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function defaultProbeCodex(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (existsSync(path.dirname(resolveCodexConfigPath(env)))) return true;
  return new Promise<boolean>((resolve) => {
    const child = spawn('codex', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function defaultProbeCopilot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (existsSync(resolveCopilotUserDir(platform, env))) return true;
  return new Promise<boolean>((resolve) => {
    const child = spawn('code', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
