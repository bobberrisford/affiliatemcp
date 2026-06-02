import { describe, expect, it } from 'vitest';

import {
  GhBackend,
  GitHubBackendError,
  GITHUB_TOKEN_ENV,
  PatBackend,
  resolveBackend,
  type SpawnFn,
  type SpawnResult,
} from '../../../src/cli/install/github-backend.js';

// ---------------------------------------------------------------------------
// spawn fake (for gh / git)
// ---------------------------------------------------------------------------

function ok(stdout = '', stderr = ''): SpawnResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr = 'boom', code = 1): SpawnResult {
  return { code, stdout: '', stderr };
}

function recorder(scripted: SpawnResult[]): { spawn: SpawnFn; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  let i = 0;
  const spawn: SpawnFn = async (cmd, args) => {
    calls.push([cmd, args]);
    const next = scripted[i++];
    if (!next) throw new Error(`spawn called more times than scripted: ${cmd} ${args.join(' ')}`);
    return next;
  };
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// fetch fake (for the PAT backend)
// ---------------------------------------------------------------------------

interface FakeRoute {
  status: number;
  body?: unknown;
}

type FetchInit = Parameters<typeof fetch>[1];

function fakeFetch(routes: Record<string, FakeRoute>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: FetchInit }>;
} {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key] ?? routes[url];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ===========================================================================
// GhBackend
// ===========================================================================

describe('GhBackend', () => {
  it('returns the signed-in login', async () => {
    const { spawn, calls } = recorder([ok('octocat\n')]);
    const login = await new GhBackend(spawn).getViewerLogin();
    expect(login).toBe('octocat');
    expect(calls[0]).toEqual(['gh', ['api', 'user', '--jq', '.login']]);
  });

  it('throws when gh cannot identify the user', async () => {
    const { spawn } = recorder([fail('not logged in')]);
    await expect(new GhBackend(spawn).getViewerLogin()).rejects.toBeInstanceOf(GitHubBackendError);
  });

  it('reports repo existence from exit code', async () => {
    const present = recorder([ok()]);
    expect(await new GhBackend(present.spawn).repoExists('octocat/x')).toBe(true);
    const absent = recorder([fail('Could not resolve to a Repository')]);
    expect(await new GhBackend(absent.spawn).repoExists('octocat/x')).toBe(false);
  });

  it('creates a private repo', async () => {
    const { spawn, calls } = recorder([ok()]);
    await new GhBackend(spawn).createPrivateRepo('mirror', 'desc');
    expect(calls[0]).toEqual([
      'gh',
      ['repo', 'create', 'mirror', '--private', '--description', 'desc'],
    ]);
  });

  it('surfaces a create failure', async () => {
    const { spawn } = recorder([fail('name already exists')]);
    await expect(new GhBackend(spawn).createPrivateRepo('mirror', 'desc')).rejects.toBeInstanceOf(
      GitHubBackendError,
    );
  });

  it('mints a token via `gh auth token` and authenticates the push through env', async () => {
    const { spawn, calls } = recorder([ok('gh-oauth-token\n')]);
    const env = await new GhBackend(spawn).authEnv();
    expect(calls[0]).toEqual(['gh', ['auth', 'token']]);
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    const expected = Buffer.from('x-access-token:gh-oauth-token').toString('base64');
    expect(env['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${expected}`);
    // The raw token must never appear (only its base64 form).
    expect(JSON.stringify(env)).not.toContain('gh-oauth-token');
  });

  it('fails clearly when `gh auth token` yields nothing', async () => {
    const { spawn } = recorder([fail('not logged in')]);
    await expect(new GhBackend(spawn).authEnv()).rejects.toBeInstanceOf(GitHubBackendError);
  });
});

// ===========================================================================
// PatBackend
// ===========================================================================

describe('PatBackend', () => {
  it('returns the login from /user', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://api.github.com/user': { status: 200, body: { login: 'octocat' } },
    });
    const login = await new PatBackend('tok', fetchImpl).getViewerLogin();
    expect(login).toBe('octocat');
    expect(calls[0]?.url).toBe('https://api.github.com/user');
    const auth = (calls[0]?.init?.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe('Bearer tok');
  });

  it('maps 401 to a token-rejected error', async () => {
    const { fetchImpl } = fakeFetch({ 'https://api.github.com/user': { status: 401 } });
    await expect(new PatBackend('bad', fetchImpl).getViewerLogin()).rejects.toThrow(/rejected the token/);
  });

  it('reads repo existence (200 vs 404)', async () => {
    const present = fakeFetch({
      'https://api.github.com/repos/octocat/x': { status: 200, body: {} },
    });
    expect(await new PatBackend('t', present.fetchImpl).repoExists('octocat/x')).toBe(true);
    const absent = fakeFetch({ 'https://api.github.com/repos/octocat/x': { status: 404 } });
    expect(await new PatBackend('t', absent.fetchImpl).repoExists('octocat/x')).toBe(false);
  });

  it('throws on an unexpected status while checking existence', async () => {
    const { fetchImpl } = fakeFetch({ 'https://api.github.com/repos/octocat/x': { status: 500 } });
    await expect(new PatBackend('t', fetchImpl).repoExists('octocat/x')).rejects.toBeInstanceOf(
      GitHubBackendError,
    );
  });

  it('creates a private repo via POST /user/repos', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'POST https://api.github.com/user/repos': { status: 201, body: {} },
    });
    await new PatBackend('t', fetchImpl).createPrivateRepo('mirror', 'desc');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ name: 'mirror', private: true, description: 'desc' });
  });

  it('surfaces the GitHub message on a failed create', async () => {
    const { fetchImpl } = fakeFetch({
      'POST https://api.github.com/user/repos': {
        status: 422,
        body: { message: 'name already exists on this account' },
      },
    });
    await expect(new PatBackend('t', fetchImpl).createPrivateRepo('mirror', 'd')).rejects.toThrow(
      /name already exists/,
    );
  });

  it('authenticates the push via an http header in the env, never argv or the URL', async () => {
    const env = await new PatBackend('s3cr3t').authEnv();
    expect(env['GIT_CONFIG_COUNT']).toBe('1');
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    const expected = Buffer.from('x-access-token:s3cr3t').toString('base64');
    expect(env['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${expected}`);
    // The raw token must not appear (only its base64 form).
    expect(JSON.stringify(env)).not.toContain('s3cr3t');
  });
});

// ===========================================================================
// resolveBackend
// ===========================================================================

describe('resolveBackend', () => {
  const ghUp = async () => true;
  const ghDown = async () => false;

  it('uses gh when present and authed (auto)', async () => {
    const backend = await resolveBackend({ spawn: recorder([]).spawn, probeGh: ghUp, env: {} });
    expect(backend.kind).toBe('gh');
  });

  it('falls back to a PAT from env when gh is absent (auto)', async () => {
    const backend = await resolveBackend({
      probeGh: ghDown,
      env: { [GITHUB_TOKEN_ENV]: 'envtok' },
    });
    expect(backend.kind).toBe('pat');
  });

  it('prompts for a token when gh is absent and none is stored', async () => {
    let asked = false;
    const backend = await resolveBackend({
      probeGh: ghDown,
      env: {},
      tokenProvider: async () => {
        asked = true;
        return 'prompted-token';
      },
    });
    expect(asked).toBe(true);
    expect(backend.kind).toBe('pat');
  });

  it('prefers a stored env token over prompting', async () => {
    let asked = false;
    await resolveBackend({
      probeGh: ghDown,
      env: { [GITHUB_TOKEN_ENV]: 'envtok' },
      tokenProvider: async () => {
        asked = true;
        return 'should-not-be-used';
      },
    });
    expect(asked).toBe(false);
  });

  it('--use-gh errors clearly when gh is unusable', async () => {
    await expect(
      resolveBackend({ prefer: 'gh', probeGh: ghDown, env: {} }),
    ).rejects.toThrow(/gh is not installed or not signed in/);
  });

  it('--use-pat skips gh detection entirely', async () => {
    let probed = false;
    const backend = await resolveBackend({
      prefer: 'pat',
      env: { [GITHUB_TOKEN_ENV]: 'envtok' },
      probeGh: async () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
    expect(backend.kind).toBe('pat');
  });

  it('throws an actionable error in non-interactive mode with no credentials', async () => {
    await expect(resolveBackend({ probeGh: ghDown, env: {} })).rejects.toThrow(
      new RegExp(GITHUB_TOKEN_ENV),
    );
  });

  it('throws when the token provider returns nothing (user cancelled)', async () => {
    await expect(
      resolveBackend({ probeGh: ghDown, env: {}, tokenProvider: async () => undefined }),
    ).rejects.toBeInstanceOf(GitHubBackendError);
  });
});
