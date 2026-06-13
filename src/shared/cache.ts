/**
 * Result cache.
 *
 * Saves API responses to `~/.affiliate-mcp/cache/` so the same question
 * within a TTL window doesn't pay another round-trip. One JSON file per
 * cache entry, filename is sha256 of the cache format, adapter version,
 * network, operation, args, and credential hash.
 *
 * Scope (deliberately narrow):
 *   - No LRU, no size cap. Users delete the directory or run `cache clear`.
 *   - No stale-while-revalidate. A cache miss is a synchronous fetch.
 *   - Per-call TTL passed by the caller via `withCache(..., ttlSeconds, ...)`.
 *     `ttlSeconds === 0` means skip the cache entirely (read AND write).
 *   - Args are canonicalised by sorting object keys before hashing — so
 *     `{from, to}` and `{to, from}` produce the same key.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { createLogger } from './logging.js';

const log = createLogger('cache');
export const CACHE_FORMAT_VERSION = 1;

/** Persistent caching is explicitly opt-in. Missing or any other value means off. */
export function cacheEnabled(): boolean {
  return process.env['AFFILIATE_MCP_CACHE']?.trim().toLowerCase() === 'on';
}

/**
 * Resolve the cache directory, honouring `AFFILIATE_MCP_CONFIG_DIR` the same
 * way `src/shared/config.ts` resolves the env file location.
 *
 * Read every call rather than at module load — tests mutate the env var.
 */
export function cacheDir(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const base = override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
  return path.join(base, 'cache');
}

interface CacheEntry<T> {
  fetchedAt: string;
  ttlSeconds: number;
  result: T;
}

/**
 * Stable JSON: sort object keys recursively so equivalent argument shapes
 * hash to the same string. Arrays preserve order — order is meaningful for
 * lists like `categories`.
 */
function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalise((value as Record<string, unknown>)[key]);
  }
  return out;
}

export interface CacheKeyInput {
  network: string;
  operation: string;
  args: unknown;
  adapterVersion: string;
  /** Hash of the credentials in effect; rotates the cache when keys change. */
  credentialHash: string;
}

export function cacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify({
    v: CACHE_FORMAT_VERSION,
    av: input.adapterVersion,
    n: input.network,
    o: input.operation,
    a: canonicalise(input.args ?? {}),
    c: input.credentialHash,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Hash the env vars whose names start with `${SLUG.toUpperCase()}_`. This is
 * deliberately not the credential value itself — only a fingerprint that
 * changes when the credential changes. Used as a component of the cache key
 * so a key rotation invalidates the network's cache automatically.
 */
export function credentialHashFor(networkSlug: string): string {
  const prefix = `${networkSlug.toUpperCase()}_`;
  const relevant: string[] = [];
  for (const k of Object.keys(process.env).sort()) {
    if (k.startsWith(prefix)) {
      const v = process.env[k] ?? '';
      relevant.push(`${k}=${v}`);
    }
  }
  return createHash('sha256').update(relevant.join('\n')).digest('hex');
}

function entryPath(key: string): string {
  return path.join(cacheDir(), `${key}.json`);
}

function isCacheEntryName(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/.test(name);
}

function readEntry<T>(key: string): CacheEntry<T> | undefined {
  const file = entryPath(key);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (typeof parsed.fetchedAt !== 'string' || typeof parsed.ttlSeconds !== 'number') {
      return undefined;
    }
    return parsed;
  } catch (err) {
    log.debug({ err: (err as Error).message, file }, 'cache read failed; treating as miss');
    return undefined;
  }
}

function isFresh(entry: CacheEntry<unknown>, now: Date): boolean {
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetchedAt)) return false;
  return fetchedAt + entry.ttlSeconds * 1000 > now.getTime();
}

/** Best-effort retention sweep. Expired entries are deleted and never served. */
export function sweepExpiredEntries(now: Date = new Date()): number {
  const dir = cacheDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!isCacheEntryName(name)) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry<unknown>;
      if (!isFresh(parsed, now)) {
        rmSync(file);
        removed += 1;
      }
    } catch (err) {
      log.debug({ err: (err as Error).message, file }, 'cache expiry sweep skipped entry');
    }
  }
  return removed;
}

function writeEntry<T>(key: string, ttlSeconds: number, result: T, now: Date): void {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* mkdir errors are surfaced by the write below */
  }
  const entry: CacheEntry<T> = {
    fetchedAt: now.toISOString(),
    ttlSeconds,
    result,
  };
  try {
    writeFileSync(entryPath(key), JSON.stringify(entry), { mode: 0o600 });
  } catch (err) {
    // Best-effort: a cache write failure must never break the user-visible
    // call. Log and move on.
    log.warn({ err: (err as Error).message, key }, 'cache write failed');
  }
}

/**
 * Run `fetcher` with a result cache.
 *
 * - `ttlSeconds === 0` bypasses the cache entirely.
 * - On hit (entry exists and `fetchedAt + ttlSeconds > now`) returns the
 *   cached `result` without invoking `fetcher`.
 * - On miss, invokes `fetcher`, writes the result, and returns it. Errors
 *   from `fetcher` are NOT cached.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (!cacheEnabled() || ttlSeconds <= 0) return fetcher();
  const now = new Date();
  sweepExpiredEntries(now);
  const existing = readEntry<T>(key);
  if (existing && isFresh(existing, now)) {
    log.debug({ key }, 'cache hit');
    return existing.result;
  }
  const result = await fetcher();
  writeEntry(key, ttlSeconds, result, now);
  return result;
}

/**
 * Delete every cache file. Returns the number of files removed.
 *
 * Implementation note: we delete files individually rather than `rm -rf`
 * the dir so users who happen to have unrelated files in the dir (manually
 * placed) don't lose them. The dir itself is preserved.
 */
export function clearCache(): { removed: number; dir: string } {
  const dir = cacheDir();
  if (!existsSync(dir)) return { removed: 0, dir };
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!isCacheEntryName(name)) continue;
    try {
      rmSync(path.join(dir, name));
      removed += 1;
    } catch (err) {
      log.warn({ err: (err as Error).message, name }, 'failed to remove cache file');
    }
  }
  return { removed, dir };
}

// ---------------------------------------------------------------------------
// TTL policy
// ---------------------------------------------------------------------------

/**
 * Per-operation TTL in seconds. `0` means "do not cache".
 *
 * The transaction-shaped ops (`listTransactions`, `getEarningsSummary`,
 * `listClicks`) carry a date window in their args; we cache only when the
 * window's end is comfortably in the past — see `pickTtl`.
 */
const TTL_24H = 24 * 60 * 60;
const TTL_30D = 30 * 24 * 60 * 60;

/** Window must end this long ago before we trust it as immutable. */
const SETTLEMENT_MARGIN_HOURS = 48;

interface MaybeWindowed {
  to?: unknown;
}

function isClosedPastWindow(args: unknown, now: Date): boolean {
  if (!args || typeof args !== 'object') return false;
  const to = (args as MaybeWindowed).to;
  if (typeof to !== 'string' || to.trim() === '') return false;
  const ts = Date.parse(to);
  if (Number.isNaN(ts)) return false;
  const marginMs = SETTLEMENT_MARGIN_HOURS * 60 * 60 * 1000;
  return ts + marginMs <= now.getTime();
}

/**
 * Pick a TTL for a given operation + args.
 *
 * - verifyAuth, generateTrackingLink: never cache.
 * - listProgrammes, getProgramme: 24h. Inventory shifts slowly.
 * - listTransactions, getEarningsSummary, listClicks: 30d *only* if `to` is
 *   set and at least `SETTLEMENT_MARGIN_HOURS` ago. Otherwise no cache —
 *   the user is asking for current data and we must not lie about it.
 */
export function pickTtl(
  operation: string,
  args: unknown,
  now: Date = new Date(),
  advertiserSide = false,
): number {
  if (advertiserSide) return 0;
  switch (operation) {
    case 'listProgrammes':
    case 'getProgramme':
      return TTL_24H;
    case 'listTransactions':
    case 'getEarningsSummary':
    case 'listClicks':
      return isClosedPastWindow(args, now) ? TTL_30D : 0;
    case 'verifyAuth':
    case 'generateTrackingLink':
    default:
      return 0;
  }
}
