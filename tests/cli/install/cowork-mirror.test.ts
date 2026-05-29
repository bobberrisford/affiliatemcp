import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakePrompter } from '../fakes.js';
import { readEnv } from '../../../src/cli/wizard/envfile.js';
import {
  CoworkMirrorError,
  DEFAULT_REPO_NAME,
  runCoworkMirror,
} from '../../../src/cli/install/cowork-mirror.js';
import {
  GITHUB_TOKEN_ENV,
  type SpawnFn,
  type SpawnResult,
} from '../../../src/cli/install/github-backend.js';

const LOGIN = 'octocat';
const TARGET = `${LOGIN}/${DEFAULT_REPO_NAME}`;

function ok(stdout = '', stderr = ''): SpawnResult {
  return { code: 0, stdout, stderr };
}
function fail(stderr = 'boom', code = 1): SpawnResult {
  return { code, stdout: '', stderr };
}

interface SpawnCall {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function routeSpawn(handler: (cmd: string, args: string[]) => SpawnResult): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
    return handler(cmd, args);
  };
  return { spawn, calls };
}

/** gh backend command router. `repoPresent` toggles the `repo view` result. */
function ghHandler(repoPresent: boolean): (cmd: string, args: string[]) => SpawnResult {
  return (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return ok(`${LOGIN}\n`);
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return repoPresent ? ok() : fail();
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'create') return ok();
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') return ok('gh-oauth-token\n');
    if (cmd === 'git' && args[0] === 'clone') return ok();
    if (cmd === 'git' && args.includes('push')) return ok();
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
}

type FetchInit = Parameters<typeof fetch>[1];
function patFetch(repoPresent: boolean): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: FetchInit }>;
} {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return { status: 200, ok: true, json: async () => ({ login: LOGIN }) } as Response;
    }
    if (url.includes('/repos/') && method === 'GET') {
      return { status: repoPresent ? 200 : 404, ok: repoPresent, json: async () => ({}) } as Response;
    }
    if (url.endsWith('/user/repos') && method === 'POST') {
      return { status: 201, ok: true, json: async () => ({}) } as Response;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ghUp = async () => true;
const ghDown = async () => false;

function sink(): { out: (line?: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line = '') => lines.push(line), lines };
}

// ===========================================================================
// gh backend
// ===========================================================================

describe('runCoworkMirror — gh backend', () => {
  it('creates the mirror when the repo does not exist (non-interactive)', async () => {
    const { spawn, calls } = routeSpawn(ghHandler(false));
    const { out, lines } = sink();
    const result = await runCoworkMirror({
      spawn,
      out,
      env: {},
      nonInteractive: true,
      probeGh: ghUp,
    });
    expect(result.action).toBe('created');
    expect(result.backend).toBe('gh');
    expect(result.targetFullName).toBe(TARGET);
    const verbs = calls.map(({ cmd, args }) => {
      if (cmd === 'git') return args.includes('push') ? 'git push' : `git ${args[0]}`;
      return `${cmd} ${args[0]} ${args[1]}`;
    });
    expect(verbs).toEqual([
      'gh api user',
      'gh repo view',
      'gh repo create',
      'git clone',
      'gh auth token',
      'git push',
    ]);
    expect(lines.join('\n')).toContain(`Enter: ${TARGET}`);
  });

  it('syncs an existing repo without creating it', async () => {
    const { spawn, calls } = routeSpawn(ghHandler(true));
    const { out } = sink();
    const result = await runCoworkMirror({
      spawn,
      out,
      env: {},
      sync: true,
      nonInteractive: true,
      probeGh: ghUp,
    });
    expect(result.action).toBe('synced');
    expect(calls.some(({ cmd, args }) => cmd === 'gh' && args[1] === 'create')).toBe(false);
  });

  it('refuses to clobber an existing repo without --sync', async () => {
    const { spawn } = routeSpawn(ghHandler(true));
    const { out } = sink();
    await expect(
      runCoworkMirror({
        spawn,
        out,
        env: {},
        nonInteractive: true,
        probeGh: ghUp,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('errors when --sync is given but the repo is missing', async () => {
    const { spawn } = routeSpawn(ghHandler(false));
    const { out } = sink();
    await expect(
      runCoworkMirror({
        spawn,
        out,
        env: {},
        sync: true,
        nonInteractive: true,
        probeGh: ghUp,
      }),
    ).rejects.toBeInstanceOf(CoworkMirrorError);
  });

  it('dry-run makes no GitHub changes', async () => {
    const { spawn, calls } = routeSpawn(ghHandler(false));
    const { out, lines } = sink();
    const result = await runCoworkMirror({
      spawn,
      out,
      env: {},
      dryRun: true,
      nonInteractive: true,
      probeGh: ghUp,
    });
    expect(result.action).toBe('dry-run');
    expect(calls.some(({ cmd, args }) => cmd === 'gh' && args[1] === 'create')).toBe(false);
    expect(calls.some(({ cmd }) => cmd === 'git')).toBe(false);
    expect(lines.join('\n')).toMatch(/\[dry-run] Would create/);
  });
});

// ===========================================================================
// PAT backend
// ===========================================================================

describe('runCoworkMirror — PAT backend', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'affmcp-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prompts for a token, mirrors, and saves the token when asked', async () => {
    const { spawn, calls } = routeSpawn(ghHandler(false)); // git clone/push reused
    const { fetchImpl } = patFetch(false);
    const { out } = sink();
    const envFile = path.join(dir, '.env');
    // prompter answers, in call order: password(token), confirm(save?), confirm(create?)
    const prompter = new FakePrompter(['ghp_testtoken', true, true]);

    const result = await runCoworkMirror({
      spawn,
      fetchImpl,
      out,
      env: {},
      prompter,
      envFilePath: envFile,
      probeGh: ghDown,
    });

    expect(result.backend).toBe('pat');
    expect(result.action).toBe('created');
    // token persisted
    expect(readEnv(envFile)[GITHUB_TOKEN_ENV]).toBe('ghp_testtoken');
    // push authenticated via http header in the env, not argv or the URL
    const pushCall = calls.find(({ cmd, args }) => cmd === 'git' && args.includes('push'));
    expect(pushCall?.args.join(' ')).not.toContain('extraheader');
    expect(pushCall?.env?.['GIT_CONFIG_VALUE_0']).toContain('AUTHORIZATION: basic');
    const expectedBasic = Buffer.from('x-access-token:ghp_testtoken').toString('base64');
    expect(pushCall?.env?.['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${expectedBasic}`);
  });

  it('does not save the token when the user declines', async () => {
    const { spawn } = routeSpawn(ghHandler(false));
    const { fetchImpl } = patFetch(false);
    const { out } = sink();
    const envFile = path.join(dir, '.env');
    const prompter = new FakePrompter(['ghp_testtoken', false, true]);

    await runCoworkMirror({
      spawn,
      fetchImpl,
      out,
      env: {},
      prompter,
      envFilePath: envFile,
      probeGh: ghDown,
    });
    expect(readEnv(envFile)[GITHUB_TOKEN_ENV]).toBeUndefined();
  });

  it('never writes the pasted token to disk on a dry run', async () => {
    const { spawn, calls } = routeSpawn(ghHandler(false));
    const { fetchImpl } = patFetch(false);
    const { out } = sink();
    const envFile = path.join(dir, '.env');
    // Only the token prompt should be reached — the save prompt is skipped on
    // a dry run, so a stray `true` here would also (incorrectly) save it.
    const prompter = new FakePrompter(['ghp_drytoken', true, true]);

    const result = await runCoworkMirror({
      spawn,
      fetchImpl,
      out,
      env: {},
      prompter,
      envFilePath: envFile,
      dryRun: true,
      probeGh: ghDown,
    });

    expect(result.action).toBe('dry-run');
    // Nothing written to disk, and no git ran.
    expect(readEnv(envFile)[GITHUB_TOKEN_ENV]).toBeUndefined();
    expect(calls.some(({ cmd }) => cmd === 'git')).toBe(false);
  });

  it('uses a stored env token without prompting', async () => {
    const { spawn } = routeSpawn(ghHandler(false));
    const { fetchImpl } = patFetch(false);
    const { out } = sink();
    const prompter = new FakePrompter([true]); // only the create confirm
    const result = await runCoworkMirror({
      spawn,
      fetchImpl,
      out,
      env: { [GITHUB_TOKEN_ENV]: 'env-token' },
      prompter,
      probeGh: ghDown,
    });
    expect(result.backend).toBe('pat');
  });

  it('errors clearly in non-interactive mode with no credentials', async () => {
    const { spawn } = routeSpawn(ghHandler(false));
    const { out } = sink();
    await expect(
      runCoworkMirror({
        spawn,
        out,
        env: {},
        nonInteractive: true,
        probeGh: ghDown,
      }),
    ).rejects.toThrow(new RegExp(GITHUB_TOKEN_ENV));
  });
});
