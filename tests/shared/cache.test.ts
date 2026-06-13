import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cacheDir,
  cacheEnabled,
  cacheKey,
  clearCache,
  credentialHashFor,
  pickTtl,
  sweepExpiredEntries,
  withCache,
} from '../../src/shared/cache.js';

const originalCacheSetting = process.env['AFFILIATE_MCP_CACHE'];

beforeEach(() => {
  process.env['AFFILIATE_MCP_CACHE'] = 'on';
});

afterEach(() => {
  if (originalCacheSetting === undefined) delete process.env['AFFILIATE_MCP_CACHE'];
  else process.env['AFFILIATE_MCP_CACHE'] = originalCacheSetting;
});

describe('cacheDir honours AFFILIATE_MCP_CONFIG_DIR', () => {
  let tmp: string;
  let original: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-cache-dir-'));
    original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lives under the override dir', () => {
    expect(cacheDir()).toBe(path.join(tmp, 'cache'));
  });
});

describe('cacheKey + credentialHashFor', () => {
  const original = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in original)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(original)) process.env[k] = v;
  });

  it('produces the same key for equivalent argument shapes (key order independent)', () => {
    const a = cacheKey({
      network: 'awin',
      operation: 'listTransactions',
      args: { from: '2025-01-01', to: '2025-01-31' },
      adapterVersion: '1.0.0',
      credentialHash: 'abc',
    });
    const b = cacheKey({
      network: 'awin',
      operation: 'listTransactions',
      args: { to: '2025-01-31', from: '2025-01-01' },
      adapterVersion: '1.0.0',
      credentialHash: 'abc',
    });
    expect(a).toBe(b);
  });

  it('produces a different key when the credential hash differs', () => {
    const a = cacheKey({ network: 'awin', operation: 'listProgrammes', args: {}, adapterVersion: '1.0.0', credentialHash: 'x' });
    const b = cacheKey({ network: 'awin', operation: 'listProgrammes', args: {}, adapterVersion: '1.0.0', credentialHash: 'y' });
    expect(a).not.toBe(b);
  });

  it('produces a different key when the adapter version differs', () => {
    const input = {
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      credentialHash: 'x',
    };
    expect(cacheKey({ ...input, adapterVersion: '1.0.0' })).not.toBe(
      cacheKey({ ...input, adapterVersion: '1.1.0' }),
    );
  });

  it('credentialHashFor changes when a credential value changes', () => {
    process.env['AWIN_API_TOKEN'] = 'one';
    const before = credentialHashFor('awin');
    process.env['AWIN_API_TOKEN'] = 'two';
    const after = credentialHashFor('awin');
    expect(before).not.toBe(after);
  });

  it('credentialHashFor only considers env vars prefixed with the slug', () => {
    process.env['AWIN_API_TOKEN'] = 'awin-token';
    const before = credentialHashFor('awin');
    process.env['CJ_API_TOKEN'] = 'cj-token-mutated';
    const after = credentialHashFor('awin');
    expect(before).toBe(after);
  });
});

describe('pickTtl', () => {
  it('returns 0 (no cache) for verifyAuth and generateTrackingLink', () => {
    expect(pickTtl('verifyAuth', {})).toBe(0);
    expect(pickTtl('generateTrackingLink', { programmeId: '1', destinationUrl: 'x' })).toBe(0);
  });

  it('caches programme inventory for 24h', () => {
    expect(pickTtl('listProgrammes', {})).toBe(24 * 60 * 60);
    expect(pickTtl('getProgramme', { programmeId: '1' })).toBe(24 * 60 * 60);
  });

  it('explicitly refuses to cache advertiser-side operations', () => {
    expect(pickTtl('listProgrammes', {}, new Date(), true)).toBe(0);
    expect(pickTtl('listTransactions', { to: '2020-01-01' }, new Date(), true)).toBe(0);
  });

  it('refuses to cache a transactions call with no `to` (window includes now)', () => {
    expect(pickTtl('listTransactions', { from: '2025-01-01' })).toBe(0);
  });

  it('refuses to cache a transactions call whose `to` is within 48h of now', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const justNow = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(pickTtl('listTransactions', { from: '2025-05-01', to: justNow }, now)).toBe(0);
  });

  it('caches a closed past window for 30 days', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const longAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(pickTtl('listTransactions', { from: '2025-05-01', to: longAgo }, now)).toBe(30 * 24 * 60 * 60);
    expect(pickTtl('getEarningsSummary', { from: '2025-05-01', to: longAgo }, now)).toBe(30 * 24 * 60 * 60);
    expect(pickTtl('listClicks', { from: '2025-05-01', to: longAgo }, now)).toBe(30 * 24 * 60 * 60);
  });
});

describe('withCache round-trip', () => {
  let tmp: string;
  let original: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-cache-rt-'));
    original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('invokes the fetcher once per key within the TTL', async () => {
    const fetcher = vi.fn(async () => ({ value: 42 }));
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    const a = await withCache(key, 3600, fetcher);
    const b = await withCache(key, 3600, fetcher);
    expect(a).toEqual({ value: 42 });
    expect(b).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not read or write cache unless explicitly enabled', async () => {
    delete process.env['AFFILIATE_MCP_CACHE'];
    expect(cacheEnabled()).toBe(false);
    const fetcher = vi.fn(async () => ({ value: 42 }));
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    await withCache(key, 3600, fetcher);
    await withCache(key, 3600, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(tmp, 'cache'))).toBe(false);
  });

  it('skips the cache when ttlSeconds is 0', async () => {
    const fetcher = vi.fn(async () => ({ value: 'fresh' }));
    const key = cacheKey({
      network: 'awin',
      operation: 'verifyAuth',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    await withCache(key, 0, fetcher);
    await withCache(key, 0, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // And nothing was written.
    expect(existsSync(path.join(tmp, 'cache'))).toBe(false);
  });

  it('re-fetches once the TTL elapses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: { search: 'x' },
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    // 0-second TTL after the write — effectively expired on next read.
    await withCache(key, 1, fetcher);
    // Tamper with system time: easier to just await briefly then assert.
    // Instead, write an entry with a TTL of -1 by going through withCache
    // (impossible here — withCache rejects 0/negative). Verify behaviour
    // by exhausting TTL via vi.useFakeTimers.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 2000));
    const second = await withCache(key, 1, fetcher);
    vi.useRealTimers();
    expect(second).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache fetcher errors', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream boom'))
      .mockResolvedValueOnce({ v: 'recovered' });
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    await expect(withCache(key, 3600, fetcher)).rejects.toThrow('upstream boom');
    const second = await withCache(key, 3600, fetcher);
    expect(second).toEqual({ v: 'recovered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('writes cache files with 0600 permissions and dir 0700', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    await withCache(key, 3600, fetcher);
    const dir = path.join(tmp, 'cache');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    if (process.platform !== 'win32') {
      const dirMode = statSync(dir).mode & 0o777;
      const fileMode = statSync(path.join(dir, files[0]!)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
  });

  it('opportunistically deletes every expired entry', async () => {
    const dir = path.join(tmp, 'cache');
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const key = cacheKey({
      network: 'awin',
      operation: 'listProgrammes',
      args: {},
      adapterVersion: '1.0.0',
      credentialHash: 'h',
    });
    await withCache(key, 3600, fetcher);
    writeFileSync(
      path.join(dir, `${'a'.repeat(64)}.json`),
      JSON.stringify({ fetchedAt: '2020-01-01T00:00:00.000Z', ttlSeconds: 1, result: {} }),
    );
    expect(sweepExpiredEntries(new Date('2030-01-01T00:00:00.000Z'))).toBe(2);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('clearCache', () => {
  let tmp: string;
  let original: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-cache-clear-'));
    original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 0 removed when the cache dir does not exist', () => {
    expect(clearCache().removed).toBe(0);
  });

  it('removes cache-owned JSON entries but preserves the directory and unrelated files', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    for (const op of ['listProgrammes', 'getProgramme']) {
      await withCache(
        cacheKey({ network: 'awin', operation: op, args: { op }, adapterVersion: '1.0.0', credentialHash: 'h' }),
        3600,
        fetcher,
      );
    }
    const dir = path.join(tmp, 'cache');
    writeFileSync(path.join(dir, 'notes.json'), '{"keep":true}');
    expect(readdirSync(dir)).toHaveLength(3);
    const { removed } = clearCache();
    expect(removed).toBe(2);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(['notes.json']);
  });
});
