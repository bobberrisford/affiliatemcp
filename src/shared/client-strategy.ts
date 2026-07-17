/**
 * clients/<slug>/ — per-client advisory strategy and KPI files.
 *
 * Lives under `$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/` (default base
 * `~/.affiliate-mcp`), one directory per logical brand slug from `brands.json`.
 * Each client may have a `Strategy.md` (free prose) and a `KPI.md` (free prose
 * plus a single fenced ```kpi block the reader parses).
 *
 * The files are advisory context for reporting and proposals; they never
 * authorise a network write. See:
 *   - docs/decisions/2026-06-12-client-strategy-recording.md
 *   - docs/decisions/2026-06-16-client-strategy-kpi-grammar-and-tools.md
 *
 * Conventions mirror `src/shared/brands.ts`:
 *   - every public function reads the file fresh on each call (tests mutate
 *     `AFFILIATE_MCP_CONFIG_DIR` between cases);
 *   - writes are atomic (temp + rename) at mode 0600, dirs at 0700;
 *   - a missing file is the empty/absent state, never an error. Only an
 *     unreadable file throws.
 *
 * The KPI parser never throws on malformed input: bad lines are returned as
 * `errors`, so a reader can report them and exclude them from verdicts rather
 * than guess their meaning or crash the call.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { isValidBrandSlug, loadBrands } from './brands.js';
import type {
  ClientStrategy,
  ClientStrategyFile,
  KpiComparator,
  KpiMetric,
  KpiParseError,
  KpiParseResult,
  KpiPeriod,
  KpiTarget,
} from './types.js';

const STRATEGY_FILENAME = 'Strategy.md';
const KPI_FILENAME = 'KPI.md';

const KPI_METRICS: ReadonlySet<KpiMetric> = new Set<KpiMetric>([
  'revenue',
  'conversions',
  'commission',
  'epc',
  'aov',
  'reversal_rate',
  'approval_rate',
]);
const MONETARY_METRICS: ReadonlySet<KpiMetric> = new Set<KpiMetric>([
  'revenue',
  'commission',
  'epc',
  'aov',
]);
const RATE_METRICS: ReadonlySet<KpiMetric> = new Set<KpiMetric>(['reversal_rate', 'approval_rate']);
const KPI_PERIODS: ReadonlySet<KpiPeriod> = new Set<KpiPeriod>([
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);
const COMPARATORS: ReadonlySet<KpiComparator> = new Set<KpiComparator>(['>=', '<=', '>', '<', '=']);

/** The auto-written header that documents the line shape for direct editors. */
export const KPI_BLOCK_HEADER = '# targets: metric: comparator value [unit] [per period]';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Base config dir. Honours `AFFILIATE_MCP_CONFIG_DIR`; falls back to `~/.affiliate-mcp`. */
function resolveConfigDir(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  return override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
}

/** `$CONFIG_DIR/clients`. */
export function resolveClientsDir(): string {
  return path.join(resolveConfigDir(), 'clients');
}

/** `$CONFIG_DIR/clients/<slug>`. */
export function resolveClientDir(slug: string): string {
  ensureValidSlug(slug);
  return path.join(resolveClientsDir(), slug);
}

/** `$CONFIG_DIR/clients/<slug>/Strategy.md`. */
export function resolveStrategyFile(slug: string): string {
  return path.join(resolveClientDir(slug), STRATEGY_FILENAME);
}

/** `$CONFIG_DIR/clients/<slug>/KPI.md`. */
export function resolveKpiFile(slug: string): string {
  return path.join(resolveClientDir(slug), KPI_FILENAME);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function loadFile(file: string): ClientStrategyFile {
  if (!existsSync(file)) return { present: false };
  return { present: true, markdown: readFileSync(file, 'utf8') };
}

/** Load `Strategy.md` for a client. A missing file is `{ present: false }`. */
export function loadStrategy(slug: string): ClientStrategyFile {
  return loadFile(resolveStrategyFile(slug));
}

/**
 * Load `KPI.md` for a client and parse its fenced block. A missing file is
 * `{ present: false }`; when present, `parsed` carries the targets and any
 * parse errors.
 */
export function loadKpi(slug: string): ClientStrategyFile & { parsed?: KpiParseResult } {
  const f = loadFile(resolveKpiFile(slug));
  if (!f.present || f.markdown === undefined) return f;
  return { ...f, parsed: parseKpiBlock(f.markdown) };
}

function ensureValidSlug(slug: string): void {
  if (!isValidBrandSlug(slug)) {
    throw new Error(
      `Client slug "${slug}" is invalid. Use lowercase letters, digits, and hyphens only.`,
    );
  }
}

/** Atomic write at mode 0600, creating the client dir at 0700 if needed. */
function writeAtomic(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

/** Write `Strategy.md` for a client. */
export function saveStrategy(slug: string, markdown: string): void {
  ensureValidSlug(slug);
  writeAtomic(resolveStrategyFile(slug), ensureTrailingNewline(markdown));
}

/** Write `KPI.md` for a client. */
export function saveKpi(slug: string, markdown: string): void {
  ensureValidSlug(slug);
  writeAtomic(resolveKpiFile(slug), ensureTrailingNewline(markdown));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

// ---------------------------------------------------------------------------
// Combined load + orphan detection
// ---------------------------------------------------------------------------

/**
 * True when a `clients/<slug>/` directory exists but `slug` has no binding in
 * `brands.json`. `brands.json` is the source of truth for which clients exist;
 * an orphan directory is a leftover the reader skills flag and never invent
 * network data for.
 */
export function isOrphan(slug: string): boolean {
  if (!existsSync(resolveClientDir(slug))) return false;
  const brands = loadBrands();
  return brands.brands[slug] === undefined;
}

/** Load the full advisory strategy context for one client. */
export function loadClientStrategy(slug: string): ClientStrategy {
  return {
    brand: slug,
    orphan: isOrphan(slug),
    strategy: loadStrategy(slug),
    kpi: loadKpi(slug),
  };
}

/** One row of `listClientStrategies`. */
export interface ClientStrategySummary {
  slug: string;
  hasStrategy: boolean;
  hasKpi: boolean;
  /** Bound in brands.json. */
  registered: boolean;
  /** Has a clients/<slug>/ dir but no brand binding. */
  orphan: boolean;
}

/**
 * Enumerate which clients have strategy recorded. Covers the union of brands in
 * `brands.json` and any `clients/<slug>/` directory on disk, so both
 * "registered but no strategy" (the gap prompt) and "strategy but no binding"
 * (orphan) are visible.
 */
export function listClientStrategies(): ClientStrategySummary[] {
  const registered = new Set(Object.keys(loadBrands().brands));
  const onDisk = new Set<string>();
  const dir = resolveClientsDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!isValidBrandSlug(entry)) continue;
      if (statSync(path.join(dir, entry)).isDirectory()) onDisk.add(entry);
    }
  }
  const slugs = [...new Set([...registered, ...onDisk])].sort();
  return slugs.map((slug) => ({
    slug,
    hasStrategy: existsSync(resolveStrategyFile(slug)),
    hasKpi: existsSync(resolveKpiFile(slug)),
    registered: registered.has(slug),
    orphan: onDisk.has(slug) && !registered.has(slug),
  }));
}

// ---------------------------------------------------------------------------
// KPI grammar parser
// ---------------------------------------------------------------------------

const KPI_BLOCK_RE = /```kpi[^\n]*\n([\s\S]*?)```/g;
const VERSION_RE = /^version\s*:\s*(\d+)\s*$/;
const TARGET_RE =
  /^([a-z_]+)\s*:\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%]+)?\s*(?:per\s+([a-z]+))?\s*$/;

/**
 * Parse the single fenced ```kpi block from a `KPI.md` body.
 *
 * Never throws. Malformed lines, unknown metrics, missing/multiple blocks, or a
 * missing or unsupported `version:` marker are returned as `errors`; only
 * well-formed lines become `targets`. Comments (`#`) and blank lines are
 * ignored.
 */
export function parseKpiBlock(markdown: string): KpiParseResult {
  const errors: KpiParseError[] = [];
  const targets: KpiTarget[] = [];

  const blocks = [...markdown.matchAll(KPI_BLOCK_RE)];
  if (blocks.length === 0) {
    return { targets, errors: [{ line: 0, text: '', reason: 'no fenced ```kpi block found' }] };
  }
  if (blocks.length > 1) {
    const secondBlockLine = markdown.slice(0, blocks[1]?.index ?? 0).split('\n').length;
    return {
      targets,
      errors: [
        {
          line: secondBlockLine,
          text: '```kpi',
          reason: `expected exactly one fenced \`\`\`kpi block (found ${blocks.length})`,
        },
      ],
    };
  }

  const match = blocks[0];
  if (!match) {
    return { targets, errors: [{ line: 0, text: '', reason: 'no fenced ```kpi block found' }] };
  }

  // 1-based file line number of the opening ```kpi fence; the first body line
  // sits one below it.
  const fenceLine = markdown.slice(0, match.index ?? 0).split('\n').length;
  const body = match[1] ?? '';
  const lines = body.split('\n');

  let versionSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lineNo = fenceLine + 1 + i;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!versionSeen) {
      const vm = VERSION_RE.exec(trimmed);
      if (!vm) {
        return {
          targets: [],
          errors: [
            {
              line: lineNo,
              text: trimmed,
              reason: 'first entry must be `version: 1`',
            },
          ],
        };
      }
      const version = Number(vm[1]);
      if (version !== 1) {
        return {
          version,
          targets: [],
          errors: [{ line: lineNo, text: trimmed, reason: `unsupported kpi version ${version}` }],
        };
      }
      versionSeen = true;
      continue;
    }

    const parsed = parseTargetLine(trimmed, lineNo);
    if ('error' in parsed) errors.push(parsed.error);
    else targets.push(parsed.target);
  }

  if (!versionSeen) {
    return {
      targets: [],
      errors: [
        {
          line: fenceLine + 1,
          text: '',
          reason: 'first entry must be `version: 1`',
        },
      ],
    };
  }

  return { version: 1, targets, errors };
}

function parseTargetLine(
  line: string,
  lineNo: number,
): { target: KpiTarget } | { error: KpiParseError } {
  const m = TARGET_RE.exec(line);
  if (!m) {
    return {
      error: { line: lineNo, text: line, reason: 'malformed target line' },
    };
  }
  const [, metricRaw, comparatorRaw, valueRaw, unitRaw, periodRaw] = m;

  if (!KPI_METRICS.has(metricRaw as KpiMetric)) {
    return { error: { line: lineNo, text: line, reason: `unknown metric "${metricRaw}"` } };
  }
  const metric = metricRaw as KpiMetric;
  const comparator = comparatorRaw as KpiComparator;
  if (!COMPARATORS.has(comparator)) {
    return { error: { line: lineNo, text: line, reason: `unknown comparator "${comparatorRaw}"` } };
  }
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) {
    return { error: { line: lineNo, text: line, reason: `unparseable value "${valueRaw ?? ''}"` } };
  }

  let unit: string | undefined;
  if (unitRaw !== undefined) {
    const unitErr = validateUnit(metric, unitRaw, line, lineNo);
    if (unitErr) return { error: unitErr };
    unit = unitRaw === '%' ? '%' : unitRaw.toUpperCase();
  }

  let period: KpiPeriod | undefined;
  if (periodRaw !== undefined) {
    if (!KPI_PERIODS.has(periodRaw as KpiPeriod)) {
      return { error: { line: lineNo, text: line, reason: `unknown period "${periodRaw}"` } };
    }
    period = periodRaw as KpiPeriod;
  }

  return { target: { metric, comparator, value, ...(unit ? { unit } : {}), ...(period ? { period } : {}) } };
}

function validateUnit(
  metric: KpiMetric,
  unit: string,
  line: string,
  lineNo: number,
): KpiParseError | null {
  if (RATE_METRICS.has(metric)) {
    if (unit !== '%') {
      return { line: lineNo, text: line, reason: `${metric} unit must be % (got "${unit}")` };
    }
    return null;
  }
  if (MONETARY_METRICS.has(metric)) {
    if (!/^[A-Za-z]{3}$/.test(unit)) {
      return {
        line: lineNo,
        text: line,
        reason: `${metric} unit must be a 3-letter currency code (got "${unit}")`,
      };
    }
    return null;
  }
  // conversions (count): no unit permitted
  return { line: lineNo, text: line, reason: `${metric} takes no unit (got "${unit}")` };
}
