/**
 * GitHub access backend for the Cowork private-mirror flow.
 *
 * The mirror needs exactly three things from GitHub: identify the signed-in
 * user, create a private repo, and authenticate the `git push --mirror`. We
 * hide those behind one interface with two implementations:
 *
 *   - `GhBackend`  — shells out to the `gh` CLI. Used silently when `gh` is
 *                    installed and authenticated, so technical users get a
 *                    zero-friction path.
 *   - `PatBackend` — talks to api.github.com with a personal access token.
 *                    The fallback for non-technical users who don't have `gh`;
 *                    the token is captured via the wizard's existing
 *                    "paste a credential" pattern.
 *
 * Auth validity is checked implicitly by `getViewerLogin()` — the mirror flow
 * calls it first anyway, so a bad token / unauthenticated gh surfaces in the
 * same moment, matching the setup wizard's "you'll know in the same minute you
 * typed it" promise.
 *
 * Both `spawn` (for gh/git) and `fetch` (for the PAT REST calls) are injectable
 * so tests never touch the network or a real subprocess.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  /**
   * Extra environment for the child. When set it *replaces* the inherited
   * environment, so callers that only want to add a few vars must spread
   * `process.env` themselves. Used to pass credentials to `git` via env rather
   * than argv (argv is world-readable through `/proc/<pid>/cmdline` and `ps`).
   */
  env?: NodeJS.ProcessEnv;
}

/** Runs an arbitrary command. Differs from claude-code's `SpawnFn`, which is bound to `claude`. */
export type SpawnFn = (cmd: string, args: string[], opts?: SpawnOptions) => Promise<SpawnResult>;

export const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts?.env ? { env: opts.env } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

/** Env var (and stored-config key) holding a GitHub token for the PAT path. */
export const GITHUB_TOKEN_ENV = 'AFFILIATE_MCP_GITHUB_TOKEN';

const GITHUB_API = 'https://api.github.com';

export interface GitHubBackend {
  readonly kind: 'gh' | 'pat';
  /** The signed-in user's login. Doubles as the auth-validity check. */
  getViewerLogin(): Promise<string>;
  /** True if `owner/repo` already exists and is visible to this user. */
  repoExists(fullName: string): Promise<boolean>;
  /** Create a private repo under the signed-in user. `name` is the bare repo name. */
  createPrivateRepo(name: string, description: string): Promise<void>;
  /**
   * Environment variables to merge into the `git push` so it authenticates
   * without leaking the credential into argv (visible via `ps` /
   * `/proc/<pid>/cmdline`), the remote URL, or the reflog. Git reads the auth
   * header from `GIT_CONFIG_*`, which on Linux is only readable by the process
   * owner. Both backends mint a token and authenticate the push themselves, so
   * neither depends on the user's ambient git credential helper.
   */
  authEnv(): Promise<Record<string, string>>;
}

/**
 * Build the `GIT_CONFIG_*` env that injects an HTTP `AUTHORIZATION` header for
 * github.com pushes. `x-access-token:<token>` Basic auth is GitHub's documented
 * token scheme and works for both PATs and `gh`-minted OAuth tokens.
 */
function gitAuthHeaderEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export class GitHubBackendError extends Error {
  constructor(
    public readonly backend: 'gh' | 'pat',
    public readonly whileDoing: string,
    public readonly detail: string,
  ) {
    super(`Couldn't ${whileDoing} (${backend}): ${detail.trim() || '<no output>'}`);
    this.name = 'GitHubBackendError';
  }
}

// ---------------------------------------------------------------------------
// gh CLI backend
// ---------------------------------------------------------------------------

export class GhBackend implements GitHubBackend {
  readonly kind = 'gh' as const;

  constructor(private readonly spawn: SpawnFn) {}

  async getViewerLogin(): Promise<string> {
    const res = await this.spawn('gh', ['api', 'user', '--jq', '.login']);
    if (res.code !== 0) {
      throw new GitHubBackendError('gh', 'identify the signed-in user', res.stderr || res.stdout);
    }
    const login = res.stdout.trim();
    if (!login) {
      throw new GitHubBackendError('gh', 'identify the signed-in user', 'gh returned an empty login');
    }
    return login;
  }

  async repoExists(fullName: string): Promise<boolean> {
    // Matches the bash script's `gh repo view ... >/dev/null 2>&1` probe: any
    // non-zero is treated as "not there", and createPrivateRepo surfaces the
    // real error if something else was actually wrong.
    const res = await this.spawn('gh', ['repo', 'view', fullName]);
    return res.code === 0;
  }

  async createPrivateRepo(name: string, description: string): Promise<void> {
    const res = await this.spawn('gh', [
      'repo',
      'create',
      name,
      '--private',
      '--description',
      description,
    ]);
    if (res.code !== 0) {
      throw new GitHubBackendError('gh', `create private repo "${name}"`, res.stderr || res.stdout);
    }
  }

  async authEnv(): Promise<Record<string, string>> {
    // `gh auth status` passing does NOT guarantee HTTPS git pushes are
    // credentialed (the user may never have run `gh auth setup-git`). Rather
    // than depend on — or mutate — their global git config, mint a token from
    // gh and authenticate the push ourselves, exactly like the PAT path.
    const res = await this.spawn('gh', ['auth', 'token']);
    const token = res.stdout.trim();
    if (res.code !== 0 || !token) {
      throw new GitHubBackendError('gh', 'get a token for the mirror push', res.stderr || res.stdout);
    }
    return gitAuthHeaderEnv(token);
  }
}

// ---------------------------------------------------------------------------
// Personal-access-token backend
// ---------------------------------------------------------------------------

export class PatBackend implements GitHubBackend {
  readonly kind = 'pat' as const;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'affiliate-networks-mcp',
    };
  }

  async getViewerLogin(): Promise<string> {
    const res = await this.fetchImpl(`${GITHUB_API}/user`, { headers: this.headers() });
    if (res.status === 401) {
      throw new GitHubBackendError(
        'pat',
        'authenticate with your token',
        'GitHub rejected the token (401). Check it has not expired and includes the "repo" scope.',
      );
    }
    if (!res.ok) {
      throw new GitHubBackendError('pat', 'identify the signed-in user', `GitHub returned ${res.status}`);
    }
    const body = (await res.json()) as { login?: string };
    if (!body.login) {
      throw new GitHubBackendError('pat', 'identify the signed-in user', 'response contained no login');
    }
    return body.login;
  }

  async repoExists(fullName: string): Promise<boolean> {
    const res = await this.fetchImpl(`${GITHUB_API}/repos/${fullName}`, { headers: this.headers() });
    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new GitHubBackendError('pat', `check whether ${fullName} exists`, `GitHub returned ${res.status}`);
  }

  async createPrivateRepo(name: string, description: string): Promise<void> {
    const res = await this.fetchImpl(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true, description }),
    });
    if (!res.ok) {
      let detail = `GitHub returned ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // Non-JSON body — keep the status-code detail.
      }
      throw new GitHubBackendError('pat', `create private repo "${name}"`, detail);
    }
  }

  async authEnv(): Promise<Record<string, string>> {
    // Authenticate via an HTTP header passed through the environment (not argv),
    // so the token stays out of the remote URL, .git/config, the reflog, and
    // `ps` / `/proc/<pid>/cmdline`.
    return gitAuthHeaderEnv(this.token);
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ResolveBackendOptions {
  /** Force a backend. From `--use-gh` / `--use-pat`. Auto-detect when unset. */
  prefer?: 'gh' | 'pat';
  spawn?: SpawnFn;
  fetchImpl?: typeof fetch;
  /** Source for env / stored token (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test override: report whether gh is present and authenticated. */
  probeGh?: (spawn: SpawnFn) => Promise<boolean>;
  /**
   * Supplies a PAT interactively when gh is unavailable and no env token is
   * set. The caller owns instruction-printing and the prompt; returning a
   * falsy value (user cancelled) aborts. Kept here as a callback so this
   * module stays free of stdout/stderr writes and is fully testable.
   */
  tokenProvider?: () => Promise<string | undefined>;
}

/**
 * Pick a backend. Order:
 *   1. `prefer: 'gh'`  → require gh; error if unusable.
 *   2. `prefer: 'pat'` → skip gh detection, go straight to the token path.
 *   3. auto            → use gh when installed + authed, else the token path.
 *
 * The token path reads `AFFILIATE_MCP_GITHUB_TOKEN` first (env or stored
 * config), then falls back to `tokenProvider`. With neither available it
 * throws a clear, actionable error rather than hanging.
 */
export async function resolveBackend(opts: ResolveBackendOptions = {}): Promise<GitHubBackend> {
  const spawn = opts.spawn ?? defaultSpawn;
  const env = opts.env ?? process.env;

  if (opts.prefer === 'gh') {
    if (!(await ghAvailable(spawn, opts.probeGh))) {
      throw new GitHubBackendError(
        'gh',
        'use the GitHub CLI',
        'gh is not installed or not signed in. Run `gh auth login`, or drop --use-gh to paste a token instead.',
      );
    }
    return new GhBackend(spawn);
  }

  if (opts.prefer !== 'pat' && (await ghAvailable(spawn, opts.probeGh))) {
    return new GhBackend(spawn);
  }

  const token = await resolveToken(opts, env);
  return new PatBackend(token, opts.fetchImpl ?? fetch);
}

async function ghAvailable(spawn: SpawnFn, probe?: (s: SpawnFn) => Promise<boolean>): Promise<boolean> {
  if (probe) return probe(spawn);
  try {
    const res = await spawn('gh', ['auth', 'status']);
    return res.code === 0;
  } catch {
    // spawn rejects (ENOENT) when gh isn't installed.
    return false;
  }
}

async function resolveToken(opts: ResolveBackendOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env[GITHUB_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;

  if (opts.tokenProvider) {
    const token = (await opts.tokenProvider())?.trim();
    if (token) return token;
    throw new GitHubBackendError('pat', 'find GitHub credentials', 'no token provided');
  }

  throw new GitHubBackendError(
    'pat',
    'find GitHub credentials',
    `No GitHub CLI detected and no ${GITHUB_TOKEN_ENV} set. Sign in with \`gh auth login\`, or set ${GITHUB_TOKEN_ENV} to a token with the "repo" scope.`,
  );
}
