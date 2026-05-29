/**
 * `affiliate-networks-mcp cowork-mirror` — create (or refresh) a PRIVATE GitHub
 * mirror of this repo so it can be added to a Claude Cowork organization
 * marketplace.
 *
 * Why a mirror at all: Cowork syncs plugins from GitHub but blocks *public*
 * repos from org marketplaces, and GitHub forks of a public repo can't be made
 * private — so we mirror-clone the upstream and push it into a fresh private
 * repo in the user's own account.
 *
 * This is the TypeScript successor to `scripts/fork-for-cowork.sh`. The GitHub
 * access (identify user / create repo / authenticate push) goes through a
 * pluggable `GitHubBackend`, so it works with the `gh` CLI when present and
 * falls back to a pasted token otherwise — no clone, no bash, one command.
 *
 * Output channel: stdout (same precedent as install/setup/test — JSON-RPC is
 * not active for these commands). Both `spawn` and `fetch` are injectable so
 * tests never touch the network or a real subprocess.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveConfigPaths } from '../wizard/paths.js';
import { mergeEnv, readEnv, writeEnv } from '../wizard/envfile.js';
import { getPrompter, type Prompter } from '../wizard/prompts.js';
import {
  GITHUB_TOKEN_ENV,
  GitHubBackendError,
  defaultSpawn,
  resolveBackend,
  type GitHubBackend,
  type SpawnFn,
} from './github-backend.js';

/** The public repo we mirror. Hardcoded (matching the old bash script) — the
 * build doesn't copy package.json into dist, so we don't read it from there. */
export const UPSTREAM_SLUG = 'bobberrisford/affiliatemcp';
export const DEFAULT_REPO_NAME = 'affiliatemcp-internal';

export class CoworkMirrorError extends Error {
  constructor(whileDoing: string, detail: string) {
    super(`Couldn't ${whileDoing}: ${detail.trim() || '<no output>'}`);
    this.name = 'CoworkMirrorError';
  }
}

export interface CoworkMirrorOptions {
  repoName?: string;
  /** Re-mirror into an existing private repo instead of creating a new one. */
  sync?: boolean;
  /** Validate the create/sync matrix and report, but make no GitHub changes. */
  dryRun?: boolean;
  /** Force a backend. From --use-gh / --use-pat. */
  prefer?: 'gh' | 'pat';
  /** CI / scripted: never prompt. Requires gh or a stored/env token. */
  nonInteractive?: boolean;
  spawn?: SpawnFn;
  fetchImpl?: typeof fetch;
  /** Test override: report whether gh is present + authenticated. */
  probeGh?: (spawn: SpawnFn) => Promise<boolean>;
  prompter?: Prompter;
  /** Output sink (defaults to stdout). */
  out?: (line?: string) => void;
  /** Credential source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Where to persist a saved token (defaults to ~/.affiliate-mcp/.env). */
  envFilePath?: string;
}

export interface CoworkMirrorResult {
  action: 'created' | 'synced' | 'dry-run';
  backend: 'gh' | 'pat';
  targetFullName: string;
  targetUrl: string;
  upstream: string;
}

export async function runCoworkMirror(opts: CoworkMirrorOptions = {}): Promise<CoworkMirrorResult> {
  const out = opts.out ?? ((line = '') => process.stdout.write(line.endsWith('\n') ? line : `${line}\n`));
  const spawn = opts.spawn ?? defaultSpawn;
  const env = opts.env ?? process.env;
  const repoName = opts.repoName ?? DEFAULT_REPO_NAME;
  const sync = opts.sync ?? false;
  const dryRun = opts.dryRun ?? false;
  const interactive = !opts.nonInteractive;
  const prompter = interactive ? (opts.prompter ?? getPrompter()) : opts.prompter;

  // The token path: print verbatim instructions, then prompt. Only wired up
  // when we're interactive — otherwise resolveBackend throws an actionable
  // "set AFFILIATE_MCP_GITHUB_TOKEN or run gh auth login" error.
  let capturedToken: string | undefined;
  const tokenProvider =
    interactive && prompter
      ? async (): Promise<string | undefined> => {
          out();
          out("No GitHub CLI detected — we'll use a token instead.");
          out('In your browser:');
          out('  1. GitHub → Settings → Developer settings → Personal access tokens →');
          out('     Tokens (classic) → Generate new token (classic)');
          out('  2. Tick the "repo" scope, generate, and copy the token.');
          out();
          const token = (await prompter.password('Paste your GitHub token')).trim();
          capturedToken = token || undefined;
          return capturedToken;
        }
      : undefined;

  const backend: GitHubBackend = await resolveBackend({
    spawn,
    env,
    ...(opts.prefer ? { prefer: opts.prefer } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.probeGh ? { probeGh: opts.probeGh } : {}),
    ...(tokenProvider ? { tokenProvider } : {}),
  });

  // First real call — also validates auth (bad token / unauthenticated gh
  // surfaces here, in the same moment the user supplied the credential).
  const login = await backend.getViewerLogin();
  out(`Authenticated as ${login}.`);

  // If the user pasted a token, offer to save it for next time. Opt-in only.
  if (capturedToken && interactive && prompter) {
    const save = await prompter.confirm("Save this token so you don't re-enter it next time?", {
      defaultYes: false,
    });
    if (save) {
      const envFile = opts.envFilePath ?? resolveConfigPaths().envFile;
      writeEnv(envFile, mergeEnv(readEnv(envFile), { [GITHUB_TOKEN_ENV]: capturedToken }));
      out(`Saved to ${envFile} (owner-only, 0600).`);
    }
  }

  const targetFullName = `${login}/${repoName}`;
  const targetUrl = `https://github.com/${targetFullName}.git`;
  const exists = await backend.repoExists(targetFullName);

  // create/sync matrix — mirrors the old bash script's guards.
  if (exists && !sync) {
    throw new CoworkMirrorError(
      'mirror the repo',
      `${targetFullName} already exists. Re-run with --sync to refresh it, or pass a different repo name.`,
    );
  }
  if (!exists && sync) {
    throw new CoworkMirrorError(
      'sync the repo',
      `--sync needs ${targetFullName} to exist already, but it doesn't. Drop --sync to create it.`,
    );
  }

  if (dryRun) {
    out('');
    out(
      exists
        ? `[dry-run] Would re-mirror upstream into existing ${targetFullName}.`
        : `[dry-run] Would create private repo ${targetFullName} and mirror upstream into it.`,
    );
    return { action: 'dry-run', backend: backend.kind, targetFullName, targetUrl, upstream: UPSTREAM_SLUG };
  }

  if (!exists) {
    if (interactive && prompter) {
      const go = await prompter.confirm(`Create private repo ${targetFullName}?`, { defaultYes: true });
      if (!go) {
        out('Cancelled — no changes made.');
        throw new CoworkMirrorError('create the repo', 'cancelled by user');
      }
    }
    out(`Creating private repo ${targetFullName} ...`);
    await backend.createPrivateRepo(
      repoName,
      `Private mirror of ${UPSTREAM_SLUG} for Claude Cowork org marketplace`,
    );
  } else {
    out(`Re-mirroring upstream into existing ${targetFullName} ...`);
  }

  await mirrorPush(spawn, backend, targetUrl, out);

  printNextSteps(out, targetFullName, repoName);

  return {
    action: exists ? 'synced' : 'created',
    backend: backend.kind,
    targetFullName,
    targetUrl,
    upstream: UPSTREAM_SLUG,
  };
}

/** Bare-clone the (public) upstream into a temp dir and push --mirror to target. */
async function mirrorPush(
  spawn: SpawnFn,
  backend: GitHubBackend,
  targetUrl: string,
  out: (line?: string) => void,
): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), 'affmcp-mirror-'));
  const mirrorDir = path.join(work, 'mirror.git');
  try {
    out(`Cloning ${UPSTREAM_SLUG} ...`);
    const clone = await spawn('git', [
      'clone',
      '--quiet',
      '--bare',
      `https://github.com/${UPSTREAM_SLUG}.git`,
      mirrorDir,
    ]);
    if (clone.code !== 0) {
      throw new CoworkMirrorError('clone the upstream repo', clone.stderr || clone.stdout);
    }

    out('Pushing mirror ...');
    const push = await spawn('git', [
      '-C',
      mirrorDir,
      ...backend.gitAuthArgs(),
      'push',
      '--mirror',
      '--quiet',
      targetUrl,
    ]);
    if (push.code !== 0) {
      throw new CoworkMirrorError('push the mirror', push.stderr || push.stdout);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function printNextSteps(out: (line?: string) => void, targetFullName: string, repoName: string): void {
  out('');
  out(`Done. Private mirror: https://github.com/${targetFullName}`);
  out('');
  out('Next steps in Claude Cowork desktop (needs org-admin access):');
  out('  1. Organization settings → Plugins → Add plugin');
  out('  2. Choose GitHub as the source');
  out(`  3. Enter: ${targetFullName}`);
  out('  4. Once synced, install: affiliate-networks-mcp');
  out('');
  const nameArg = repoName === DEFAULT_REPO_NAME ? '' : ` ${repoName}`;
  out(`To refresh later: npx affiliate-networks-mcp cowork-mirror --sync${nameArg}`);
}

// Re-export so callers (index.ts) can catch both error types from one import.
export { GitHubBackendError };
