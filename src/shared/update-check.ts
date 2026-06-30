/**
 * Update awareness.
 *
 * Mirrors the telemetry module's infrastructure shape: a small, dependency-free
 * module that performs ONE anonymous, best-effort outbound call — here a read of
 * the package's latest published version from the npm registry — caches the
 * result under `~/.affiliate-mcp`, and never lets a failure affect the server.
 *
 * Why this lives beside telemetry rather than behind the per-network
 * `withResilience` client layer: that layer is the contract for *network
 * adapter* I/O (see AGENTS.md). Like telemetry, this is server infrastructure,
 * not an adapter, so it follows telemetry's precedent — a direct `fetch` with an
 * injectable `fetchFn`, a hard timeout, and silent failure.
 *
 * Privacy: the registry GET sends no credentials, account identifiers, or
 * affiliate data — only a standard HTTP request for a public package's version.
 * Default-on, opt-out via `AFFILIATE_MCP_UPDATE_CHECK=0`. See PRIVACY.md.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfigPaths } from '../cli/wizard/paths.js';
import { createLogger } from './logging.js';
import { PACKAGE_VERSION, telemetrySurface, type TelemetrySurface } from './telemetry.js';

const log = createLogger('update-check');

export const PACKAGE_NAME = 'affiliate-networks-mcp';

/** The registry endpoint for the package's `latest` dist-tag. Overridable for tests. */
export const REGISTRY_LATEST_URL =
  process.env['AFFILIATE_MCP_REGISTRY_URL'] ??
  `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

const FETCH_TIMEOUT_MS = 2_000;

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  surface: TelemetrySurface;
}

interface UpdateCheckState {
  /** UTC day (`YYYY-MM-DD`) of the last successful registry read. */
  lastCheckedDay?: string;
  /** Last `latest` version observed from the registry. */
  latestVersion?: string;
  /** ISO timestamp when `latestVersion` was first observed — the soak clock for auto-apply. */
  latestFirstSeen?: string;
  /** Persisted opt-in for silent auto-apply (env var overrides this). */
  autoUpdate?: boolean;
}

/**
 * Default-on. Disabled only by an explicit opt-out so a privacy-conscious user
 * (or a host that wants zero outbound checks) can turn it off. Mirrors the
 * telemetry env semantics in reverse: telemetry is opt-in, the check is opt-out.
 */
export function updateCheckEnabled(): boolean {
  const env = process.env['AFFILIATE_MCP_UPDATE_CHECK']?.trim().toLowerCase();
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

export function updateCheckFilePath(): string {
  return path.join(resolveConfigPaths().dir, 'update-check.json');
}

/**
 * Compare two version strings. Returns 1 when `a` is newer, -1 when older, 0
 * when equal or unparseable. Unparseable input returns 0 so a malformed version
 * never produces a false "update available" claim (Principle 4.1 — never invent).
 *
 * Core `major.minor.patch` segments are compared numerically. Prerelease tags
 * are compared lexicographically, not by semver's per-identifier numeric rules
 * (so `-beta.10` sorts before `-beta.2`). That only affects ordering between two
 * prereleases of the same core version and never yields a false update against a
 * released version, which is all this check needs; full semver prerelease
 * ordering is deliberately out of scope.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // Equal core: a final release outranks a prerelease of the same core.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

function parseVersion(v: string): { nums: number[]; pre: string } {
  const [core, ...pre] = v.trim().replace(/^v/, '').split('-');
  const nums = (core ?? '').split('.').map((n) => Number.parseInt(n, 10));
  return { nums, pre: pre.join('-') };
}

/** Best-effort registry read. Returns the `latest` version or undefined on any failure. */
export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (body && typeof body === 'object' && typeof (body as { version?: unknown }).version === 'string') {
      return (body as { version: string }).version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface CheckOptions {
  now?: Date;
  fetchFn?: typeof fetch;
  /** Skip the once-per-day cache and always hit the registry. Used by `update --check`. */
  force?: boolean;
}

/**
 * Resolve current-vs-latest. Hits the registry at most once per UTC day; reuses
 * the cached `latestVersion` otherwise (and as a fallback when the registry is
 * unreachable). Returns undefined when disabled or when no version is known.
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateInfo | undefined> {
  if (!updateCheckEnabled()) return undefined;
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const current = PACKAGE_VERSION;
  const surface = telemetrySurface();

  try {
    const state = readState() ?? {};
    const today = utcDay(now);

    let latest = state.latestVersion;
    if (opts.force || state.lastCheckedDay !== today || !latest) {
      const fetched = await fetchLatestVersion(fetchFn);
      if (fetched) {
        // Preserve the soak clock when the version is unchanged; reset it the
        // first time a new version appears so auto-apply can require a minimum age.
        const firstSeen =
          fetched === state.latestVersion && state.latestFirstSeen
            ? state.latestFirstSeen
            : now.toISOString();
        latest = fetched;
        writeState({ ...state, lastCheckedDay: today, latestVersion: fetched, latestFirstSeen: firstSeen });
      }
      // Note: on a failed fetch we deliberately do NOT advance lastCheckedDay,
      // so an offline session keeps retrying on subsequent launches (each bounded
      // by the 2s timeout and fired non-blocking) rather than going silent for a
      // day. We fall back to the cached version below if we have one.
    }

    if (!latest) return undefined;
    return { current, latest, updateAvailable: compareVersions(latest, current) > 0, surface };
  } catch {
    return undefined;
  }
}

/** The channel-appropriate manual upgrade instruction shown in the notice. */
export function updateInstructionForSurface(surface: TelemetrySurface): string {
  switch (surface) {
    case 'mcpb':
    case 'desktop-bundle':
      return 'Download the latest .mcpb from the GitHub releases page and re-install it via Claude Desktop → Settings → Extensions.';
    case 'npm':
    case 'unknown':
    default:
      return `Update with: npx -y ${PACKAGE_NAME}@latest (this refreshes a stale npx cache). For a Claude Code plugin install, re-run the plugin install; for a Cowork mirror, re-run cowork-mirror --sync.`;
  }
}

export function formatUpdateNotice(info: UpdateInfo): string {
  return `A newer ${PACKAGE_NAME} is available: ${info.current} → ${info.latest}. ${updateInstructionForSurface(info.surface)}`;
}

/**
 * Non-blocking startup notice. Fire-and-forget from the server bootstrap exactly
 * like `void flushTelemetry()` — it must never delay the stdio transport. The
 * notice goes to stderr (visible in the client's MCP/developer log panel).
 */
export async function notifyIfUpdateAvailable(opts: CheckOptions = {}): Promise<void> {
  try {
    const info = await checkForUpdate(opts);
    if (info?.updateAvailable) {
      log.warn(
        { current: info.current, latest: info.latest, surface: info.surface },
        formatUpdateNotice(info),
      );
    }
  } catch {
    // Update awareness must never affect package behaviour.
  }
}

// ---------------------------------------------------------------------------
// Opt-in silent auto-apply.
//
// Off by default. When enabled, the server applies an available update on launch
// for the channels it controls (npm/npx) by installing the latest globally, so
// the next launch runs it. It never blocks startup, never applies a release that
// has not passed a soak window, never self-applies on host-owned surfaces
// (.mcpb / desktop bundle), and falls back to the notice on any failure.
// ---------------------------------------------------------------------------

export type ApplyReason =
  | 'applied'
  | 'up_to_date'
  | 'disabled'
  | 'unknown_latest'
  | 'host_managed'
  | 'too_new'
  | 'command_failed';

export interface ApplyResult {
  applied: boolean;
  reason: ApplyReason;
  current: string;
  latest?: string;
  surface: TelemetrySurface;
  detail?: string;
}

/** A child-process runner, injectable so tests never shell out to npm. */
export interface CommandRunner {
  (command: string, args: string[]): Promise<{ ok: boolean; code: number | null; stderr: string }>;
}

export interface ApplyOptions extends CheckOptions {
  runner?: CommandRunner;
  /** Bypass the minimum-age soak — used by the explicit `update` CLI command. */
  ignoreSoak?: boolean;
}

/** Opt-in for silent auto-apply. Env var wins; otherwise the persisted preference; default off. */
export function autoUpdateEnabled(): boolean {
  const env = process.env['AFFILIATE_MCP_AUTO_UPDATE']?.trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'no' || env === 'off') return false;
  return readState()?.autoUpdate === true;
}

/** Persist the auto-apply preference (used by `update enable|disable`). */
export function setAutoUpdate(enabled: boolean): void {
  writeState({ ...(readState() ?? {}), autoUpdate: enabled });
}

/** Minimum hours a release must have been observed before auto-apply touches it. */
export function minReleaseAgeHours(): number {
  const raw = Number.parseInt(process.env['AFFILIATE_MCP_AUTO_UPDATE_MIN_AGE_HOURS'] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
}

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (err) => resolve({ ok: false, code: null, stderr: err.message }));
      child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));
    } catch (err) {
      resolve({ ok: false, code: null, stderr: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Apply an available update for the npm/npx surface by installing the latest
 * version globally. Returns a structured outcome; never throws. Does not apply
 * on host-owned surfaces or before the soak window (unless `ignoreSoak`).
 */
export async function applyUpdate(opts: ApplyOptions = {}): Promise<ApplyResult> {
  const current = PACKAGE_VERSION;
  const surface = telemetrySurface();
  const info = await checkForUpdate(opts);
  if (!info) {
    return { applied: false, reason: updateCheckEnabled() ? 'unknown_latest' : 'disabled', current, surface };
  }
  if (!info.updateAvailable) {
    return { applied: false, reason: 'up_to_date', current, latest: info.latest, surface };
  }
  if (surface === 'mcpb' || surface === 'desktop-bundle') {
    return { applied: false, reason: 'host_managed', current, latest: info.latest, surface };
  }
  if (!opts.ignoreSoak) {
    const ageHours = releaseAgeHours(opts.now ?? new Date());
    const min = minReleaseAgeHours();
    if (ageHours === undefined || ageHours < min) {
      const seen = ageHours === undefined ? 'not yet soaked' : `seen ${ageHours.toFixed(1)}h ago`;
      return { applied: false, reason: 'too_new', current, latest: info.latest, surface, detail: `${seen}; soak ${min}h` };
    }
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const runner = opts.runner ?? defaultRunner;
  const result = await runner(npmCmd, ['install', '-g', `${PACKAGE_NAME}@${info.latest}`]);
  if (result.ok) {
    return { applied: true, reason: 'applied', current, latest: info.latest, surface };
  }
  return { applied: false, reason: 'command_failed', current, latest: info.latest, surface, detail: result.stderr.slice(0, 500) };
}

function releaseAgeHours(now: Date): number | undefined {
  const seen = readState()?.latestFirstSeen;
  if (!seen) return undefined;
  const t = Date.parse(seen);
  if (Number.isNaN(t)) return undefined;
  return (now.getTime() - t) / 3_600_000;
}

/** Non-blocking auto-apply for the server bootstrap. Logs its outcome; never throws. */
export async function autoApplyOnLaunch(opts: ApplyOptions = {}): Promise<void> {
  try {
    if (!autoUpdateEnabled()) return;
    logApplyOutcome(await applyUpdate(opts));
  } catch {
    // Auto-update must never affect package behaviour.
  }
}

/**
 * The single startup entrypoint: auto-apply when enabled, otherwise just notify.
 * Wired fire-and-forget from `startServer` so it never delays the transport.
 */
export async function runStartupUpdateCheck(opts: ApplyOptions = {}): Promise<void> {
  if (autoUpdateEnabled()) {
    await autoApplyOnLaunch(opts);
  } else {
    await notifyIfUpdateAvailable(opts);
  }
}

function logApplyOutcome(result: ApplyResult): void {
  if (result.applied) {
    log.warn(
      { from: result.current, to: result.latest },
      `Updated ${PACKAGE_NAME} to ${result.latest}. Restart to run the new version.`,
    );
    return;
  }
  if (result.reason === 'too_new') {
    log.info(
      { latest: result.latest, detail: result.detail },
      `Holding back ${PACKAGE_NAME} ${result.latest ?? ''} until it passes the soak window.`,
    );
    return;
  }
  if (result.reason === 'host_managed' && result.latest) {
    log.warn(
      { latest: result.latest },
      formatUpdateNotice({ current: result.current, latest: result.latest, updateAvailable: true, surface: result.surface }),
    );
    return;
  }
  if (result.reason === 'command_failed') {
    log.warn(
      { latest: result.latest, detail: result.detail },
      `Auto-update to ${result.latest ?? 'latest'} failed; continuing on ${result.current}. ${updateInstructionForSurface(result.surface)}`,
    );
  }
  // up_to_date / disabled / unknown_latest: stay quiet on the startup path.
}

function readState(): UpdateCheckState | undefined {
  const file = updateCheckFilePath();
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    return value as UpdateCheckState;
  } catch {
    return undefined;
  }
}

function writeState(state: UpdateCheckState): void {
  const file = updateCheckFilePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Test-only: read raw cached state. */
export function _readUpdateCheckStateForTests(): UpdateCheckState | undefined {
  return readState();
}
