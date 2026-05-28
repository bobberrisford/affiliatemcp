/**
 * Detect which Claude clients are installed on this machine.
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
 * Linux Desktop is reported as `notSupported` rather than `absent` so the
 * orchestrator can tell the user why it's skipping rather than silently
 * doing nothing.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { resolveDesktopConfigPath } from './claude-desktop.js';

export type DesktopState = 'present' | 'absent' | 'notSupported';
export type CodeState = 'present' | 'absent';

export interface DetectionResult {
  desktop: DesktopState;
  desktopConfigPath: string | null;
  code: CodeState;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Override for tests. Resolves to true if Claude Code appears installed. */
  probeClaudeCode?: () => Promise<boolean>;
  /** Override for tests. Resolves to true if Claude Desktop app bundle exists. */
  probeDesktopBundle?: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => boolean;
}

export async function detectClients(opts: DetectOptions = {}): Promise<DetectionResult> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const probeCode = opts.probeClaudeCode ?? defaultProbeClaudeCode;
  const probeBundle = opts.probeDesktopBundle ?? defaultProbeDesktopBundle;

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

  return { desktop, desktopConfigPath, code };
}

function defaultProbeDesktopBundle(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'darwin') {
    return existsSync('/Applications/Claude.app');
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
