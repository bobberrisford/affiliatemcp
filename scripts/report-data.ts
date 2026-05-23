/**
 * Shared data-loading utilities for the report + README generators.
 *
 * Inputs:
 * - `src/networks/<slug>/network.json` — static manifests (the source of truth
 *   for setup time, approval, claim status, known limitations, adapter version,
 *   last verified date).
 * - `docs/findings/<slug>.md` — qualitative findings prose written by the
 *   adapter author. Embedded verbatim in REPORT.md.
 * - Optional: `runDiagnostic()` output when live credentials are present. If
 *   absent, the loader falls back to "live data unavailable" so the report is
 *   still buildable from static data alone.
 *
 * The generators (`scripts/generate-report.ts`,
 * `scripts/generate-readme-table.ts`, `scripts/generate-report-image.ts`) all
 * consume `loadReportData()`.
 *
 * Deterministic: networks are sorted alphabetically by slug so re-running the
 * generators against the same inputs always produces byte-identical output.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type {
  AnyOperation,
  NetworkCapabilities,
  AdapterOperation,
} from '../src/shared/types.js';

// ---------------------------------------------------------------------------
// Manifest shape (mirrors scripts/validate-network-json.ts but kept local so
// the generators do not depend on the validator's strict zod schema — that
// schema rejects unknown fields and the generators should be permissive).
// ---------------------------------------------------------------------------

export interface NetworkManifest {
  slug: string;
  name: string;
  base_url: string;
  auth_model: 'bearer' | 'oauth2' | 'basic' | 'custom';
  env_vars: string[];
  setup_time_estimate_minutes: number;
  setup_requires_approval: boolean;
  setup_approval_days_typical?: number;
  known_limitations: string[];
  claim_status: 'production' | 'partial' | 'experimental' | 'unsupported';
  adapter_version: string;
  last_verified: string;
  supports_brand_ops: boolean;
  side: 'publisher' | 'advertiser';
  credential_scope: 'single-brand' | 'multi-brand';
  docs_url?: string;
}

export interface NetworkReportEntry {
  manifest: NetworkManifest;
  findings: string;
  /** Live capabilities, if available. Falls back to undefined when no creds. */
  capabilities?: NetworkCapabilities;
}

export interface ReportData {
  /** Sorted alphabetically by slug. */
  networks: NetworkReportEntry[];
  /** True when live diagnostic data was collected, false when static only. */
  liveDataAvailable: boolean;
  /** Note rendered into the report when live data was unavailable. */
  liveDataNote: string;
  /** ISO timestamp of generation (used in tests with a fixed clock). */
  generatedAt: string;
}

/**
 * The seven canonical publisher operations rendered in each per-network
 * capability table, plus listClicks (already in the canonical set). Kept
 * here for the generators so the table column order stays deterministic.
 */
export const REPORTED_OPERATIONS: ReadonlyArray<AdapterOperation> = [
  'listProgrammes',
  'getProgramme',
  'listTransactions',
  'getEarningsSummary',
  'listClicks',
  'generateTrackingLink',
  'verifyAuth',
];

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export interface LoadReportDataOptions {
  /** Absolute path to the repo root. Defaults to one level above this script. */
  repoRoot?: string;
  /**
   * Optional injection point. When provided, the loader uses these results
   * verbatim and reports `liveDataAvailable = true`.
   */
  capabilities?: Record<string, NetworkCapabilities>;
  /** Optional fixed clock for deterministic tests. */
  now?: Date;
}

export function loadReportData(options: LoadReportDataOptions = {}): ReportData {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const networksDir = path.join(repoRoot, 'src', 'networks');
  const findingsDir = path.join(repoRoot, 'docs', 'findings');

  const slugs = readdirSync(networksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((slug) => existsSync(path.join(networksDir, slug, 'network.json')))
    .sort((a, b) => a.localeCompare(b));

  const networks: NetworkReportEntry[] = slugs.map((slug) => {
    const manifest = readManifest(path.join(networksDir, slug, 'network.json'));
    const findings = readFindings(path.join(findingsDir, `${slug}.md`));
    const capabilities = options.capabilities?.[slug];
    return capabilities ? { manifest, findings, capabilities } : { manifest, findings };
  });

  const liveDataAvailable = options.capabilities !== undefined;

  return {
    networks,
    liveDataAvailable,
    liveDataNote: liveDataAvailable
      ? 'Live diagnostic data was collected against the configured credentials at the time of generation.'
      : 'Live diagnostic data was not collected because no credentials were configured. The figures below are from each adapter\'s static manifest and the per-network findings document; live latency and sample-size figures are therefore omitted.',
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

function readManifest(filePath: string): NetworkManifest {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as NetworkManifest;
  return raw;
}

function readFindings(filePath: string): string {
  if (!existsSync(filePath)) {
    return `_No findings document was supplied at \`docs/findings/${path.basename(filePath)}\`._\n`;
  }
  return readFileSync(filePath, 'utf8');
}

function defaultRepoRoot(): string {
  // This file lives at <repoRoot>/scripts/report-data.ts; one level up.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
}

// ---------------------------------------------------------------------------
// Live-credentials probe
// ---------------------------------------------------------------------------

/**
 * Returns true when at least one network has all of its declared `env_vars`
 * present in the environment. The diagnostic engine should only be invoked
 * in that case — otherwise it would fire authentication calls that always
 * fail and waste time.
 */
export function anyLiveCredentialsConfigured(networks: NetworkReportEntry[]): boolean {
  for (const n of networks) {
    if (n.manifest.env_vars.every((v) => process.env[v])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers — pure formatters used by every generator
// ---------------------------------------------------------------------------

export function supportedOperationCount(entry: NetworkReportEntry): number {
  // Without live data, fall back to "all canonical ops are 'claim_status' away
  // from supported, minus anything mentioned in known_limitations as
  // throwing NotImplementedError". This is a coarse signal — the per-network
  // section in the report is the authoritative breakdown.
  const ops = entry.capabilities?.operations;
  if (ops) {
    return REPORTED_OPERATIONS.filter((op) => ops[op]?.supported === true).length;
  }
  return countOpsFromManifest(entry.manifest);
}

function countOpsFromManifest(m: NetworkManifest): number {
  let count = REPORTED_OPERATIONS.length;
  for (const limitation of m.known_limitations) {
    const lower = limitation.toLowerCase();
    if (lower.includes('listclicks') && (lower.includes('unsupported') || lower.includes('notimplemented'))) {
      count -= 1;
    }
  }
  return Math.max(0, count);
}

export function notesSummary(entry: NetworkReportEntry): string {
  const limitations = entry.manifest.known_limitations;
  if (limitations.length === 0) return 'fully supported';
  // Pick a short, non-snarky one-or-two-word summary keyed on patterns.
  const text = limitations.join(' ').toLowerCase();
  if (text.includes('listclicks') && text.includes('paid')) return 'clicks gated';
  if (text.includes('listclicks')) return 'no clicks';
  if (text.includes('5xx') || text.includes('flak')) return 'upstream variability';
  if (text.includes('pagination')) return 'pagination quirks';
  return 'see notes';
}

export function approvalCell(m: NetworkManifest): string {
  if (!m.setup_requires_approval) return 'no';
  if (m.setup_approval_days_typical) {
    return `yes (~${m.setup_approval_days_typical} days)`;
  }
  return 'yes';
}

export function operationSupportFlag(
  entry: NetworkReportEntry,
  op: AnyOperation,
): { supported: boolean; latencyMs?: number; note?: string } {
  const live = entry.capabilities?.operations?.[op];
  if (live) {
    return {
      supported: live.supported,
      latencyMs: live.latencyMs,
      note: live.note,
    };
  }
  // Fall back to the manifest's known_limitations text. The default is "yes"
  // because every adapter implements every canonical op unless it has a
  // limitation note that says otherwise.
  const lower = entry.manifest.known_limitations.join(' ').toLowerCase();
  if (op === 'listClicks' && (lower.includes('not exposed') || lower.includes('not supported') || lower.includes('notimplementederror') || lower.includes('gated') || lower.includes('throws') || lower.includes('paid tier'))) {
    return { supported: false };
  }
  return { supported: true };
}
