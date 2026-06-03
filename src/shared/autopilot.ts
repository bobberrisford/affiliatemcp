/**
 * autopilot — local-first run-state + client-intent store for the agency
 * autopilot loop.
 *
 * Lives under `$AFFILIATE_MCP_CONFIG_DIR` (default `~/.affiliate-mcp`), the same
 * root as `.env` and `brands.json`. Mirrors `src/shared/brands.ts` deliberately:
 * fresh read on every call (tests mutate the env var between cases), atomic
 * temp-write + rename at mode 0600, dir mode 0700.
 *
 * Two kinds of state are stored, kept in separate subtrees on purpose:
 *
 *   clients/<slug>/strategy.md   INTENT — prose, human-authored, slow-changing
 *   clients/<slug>/kpi.md        INTENT — prose + one fenced threshold block
 *   autopilot/<loop>/state.json  RUN-STATE — machine-authored, rewritten each run
 *   autopilot/<loop>/digest.md   the last digest the loop rendered
 *
 * This module is intentionally dumb: it persists and returns. It does NOT
 * compute anomalies, deltas, or the alert lifecycle — that lives in the
 * `autopilot-run` skill, which is where the rest of the project keeps its
 * analysis (model-computed, from typed tool output). The store just gives the
 * skill somewhere durable to read last run's numbers from and write this run's
 * numbers to.
 *
 * This is the first server-side code that WRITES under the config dir (every
 * other write today is the CLI wizard). Writes are confined to the `autopilot/`
 * and `clients/` subtrees; `.env` and `brands.json` are never touched here.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { loadBrands } from './brands.js';

/** Loop and slug identifiers double as path segments, so they are strict. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ClientIntent {
  slug: string;
  /** Raw prose from strategy.md; '' when absent. The model reads this verbatim. */
  strategyMd: string;
  /** Raw prose from kpi.md; '' when absent. */
  kpiMd: string;
  /** Thresholds parsed from kpi.md's fenced block; {} when none. */
  thresholds: Record<string, number | string>;
}

export interface BookBinding {
  brand: string;
  network: string;
  networkBrandId: string;
}

export interface AutopilotState {
  version: 1;
  loop: string;
  updatedAt: string; // ISO
  /**
   * The snapshot the `autopilot-run` skill computed. Opaque to this module —
   * typically per-binding metrics and the open findings with their lifecycle
   * state, so the next run can diff against it.
   */
  data: unknown;
}

export interface AutopilotContext {
  loop: string;
  /** One row per (brand, network) pair from brands.json. */
  bindings: BookBinding[];
  /** One entry per distinct brand in the book — including brands with no intent yet. */
  clients: ClientIntent[];
  /** The previous run's snapshot, or null on the first run. */
  lastState: AutopilotState | null;
}

// ---------------------------------------------------------------------------
// Path resolution — honours AFFILIATE_MCP_CONFIG_DIR, read on every call.
// ---------------------------------------------------------------------------

function configDir(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  return override && override.trim() !== ''
    ? override
    : path.join(homedir(), '.affiliate-mcp');
}

function assertId(kind: 'loop' | 'brand slug', value: string): void {
  if (!ID_RE.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}". Use lowercase letters, digits, and hyphens only ` +
        `(must start with a letter or digit).`,
    );
  }
}

export function resolveStateFile(loop: string): string {
  assertId('loop', loop);
  return path.join(configDir(), 'autopilot', loop, 'state.json');
}

export function resolveDigestFile(loop: string): string {
  assertId('loop', loop);
  return path.join(configDir(), 'autopilot', loop, 'digest.md');
}

export function resolveStrategyFile(slug: string): string {
  assertId('brand slug', slug);
  return path.join(configDir(), 'clients', slug, 'strategy.md');
}

export function resolveKpiFile(slug: string): string {
  assertId('brand slug', slug);
  return path.join(configDir(), 'clients', slug, 'kpi.md');
}

// ---------------------------------------------------------------------------
// Threshold parsing
// ---------------------------------------------------------------------------

/**
 * Extract the machine-readable thresholds from a kpi.md document.
 *
 * The contract is one block introduced by a marker line `# affiliate-mcp:thresholds`
 * (typically inside a fenced code block), followed by simple `key: value` lines.
 * Values that look numeric become numbers; everything else stays a string.
 * Comment lines (`#…`), blank lines, and a closing code fence end the block.
 *
 * Prose around the block is ignored — the model reads that; this only feeds the
 * deterministic threshold checks.
 */
export function parseKpiThresholds(md: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!md) return out;
  const lines = md.split('\n');
  const markerIdx = lines.findIndex((l) => l.trim() === '# affiliate-mcp:thresholds');
  if (markerIdx === -1) return out;

  for (let i = markerIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '') break; // blank line ends the block
    if (line.startsWith('```')) break; // closing fence ends the block
    if (line.startsWith('#')) continue; // comment within the block
    const m = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
    const key = m?.[1];
    if (!key) continue;
    let value = (m[2] ?? '').trim();
    // Strip a trailing inline comment and surrounding quotes.
    value = value.replace(/\s+#.*$/, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
    } else {
      out[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readFileOr(filePath: string, fallback: string): string {
  if (!existsSync(filePath)) return fallback;
  return readFileSync(filePath, 'utf8');
}

/** Load one client's intent. Missing files yield empty prose and no thresholds. */
export function loadClientIntent(slug: string): ClientIntent {
  const strategyMd = readFileOr(resolveStrategyFile(slug), '');
  const kpiMd = readFileOr(resolveKpiFile(slug), '');
  return { slug, strategyMd, kpiMd, thresholds: parseKpiThresholds(kpiMd) };
}

/** Load a loop's last run-state snapshot, or null if it has never run. */
export function loadAutopilotState(loop: string): AutopilotState | null {
  const file = resolveStateFile(loop);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`autopilot state at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isAutopilotState(parsed)) {
    throw new Error(`autopilot state at ${file} has an unrecognised shape (expected version 1).`);
  }
  return parsed;
}

/**
 * Load everything a run needs in one call: the book, each client's intent, and
 * the last snapshot. Brands with no intent file still appear in `clients` (with
 * empty prose / no thresholds) so the digest can prompt the operator to record
 * targets — the "digest drives capture" UX.
 */
export function loadAutopilotContext(loop: string): AutopilotContext {
  assertId('loop', loop);
  const book = loadBrands();
  const bindings: BookBinding[] = [];
  for (const [brand, list] of Object.entries(book.brands)) {
    for (const b of list) {
      bindings.push({ brand, network: b.network, networkBrandId: b.networkBrandId });
    }
  }
  const slugs = [...new Set(bindings.map((b) => b.brand))].sort();
  const clients = slugs.map(loadClientIntent);
  return { loop, bindings, clients, lastState: loadAutopilotState(loop) };
}

// ---------------------------------------------------------------------------
// Writes — atomic temp + rename, mode 0600 (mirrors saveBrands).
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, body: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

/**
 * Persist this run's snapshot (and optionally the rendered digest). `data` is
 * whatever the skill computed — stored verbatim under `state.data`.
 */
export function saveAutopilotState(loop: string, data: unknown, digestMd?: string): void {
  const state: AutopilotState = {
    version: 1,
    loop,
    updatedAt: new Date().toISOString(),
    data,
  };
  atomicWrite(resolveStateFile(loop), JSON.stringify(state, null, 2) + '\n');
  if (digestMd !== undefined) {
    atomicWrite(resolveDigestFile(loop), digestMd.endsWith('\n') ? digestMd : digestMd + '\n');
  }
}

/**
 * Persist a client's intent. Either file may be omitted to leave it untouched;
 * passing a value (including '') rewrites that file.
 */
export function saveClientIntent(
  slug: string,
  intent: { strategyMd?: string; kpiMd?: string },
): void {
  assertId('brand slug', slug);
  if (intent.strategyMd !== undefined) {
    const body = intent.strategyMd.endsWith('\n') ? intent.strategyMd : intent.strategyMd + '\n';
    atomicWrite(resolveStrategyFile(slug), body);
  }
  if (intent.kpiMd !== undefined) {
    const body = intent.kpiMd.endsWith('\n') ? intent.kpiMd : intent.kpiMd + '\n';
    atomicWrite(resolveKpiFile(slug), body);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isAutopilotState(value: unknown): value is AutopilotState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v['version'] === 1 && typeof v['loop'] === 'string' && typeof v['updatedAt'] === 'string';
}
