/**
 * `affiliate-mcp doctor [slug]` — verbose diagnostic.
 *
 * Same data as `test` but JSON, plus environment context (Node version,
 * platform, config path + presence, masked variable list, per-operation
 * resilience config). Designed for users to paste into a GitHub issue.
 *
 * Critical: variable VALUES must never be printed. Only NAMES and presence.
 * The Pino redactor protects logs; this surface enforces the same rule
 * explicitly because it dumps JSON to stdout for human consumption.
 */

import { existsSync, readFileSync } from 'node:fs';

import { runDiagnostic } from '../shared/diagnostic.js';
import { getAdapter, getAdapters } from '../shared/registry.js';
import { resolveConfigPaths } from './wizard/paths.js';
import { parseEnvFile } from '../shared/config.js';
import { listBrandsForNetwork } from '../shared/brands.js';
import { listClientStrategies } from '../shared/client-strategy.js';
import type { NetworkAdapter, ResilienceConfigMap } from '../shared/types.js';

function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

export interface DoctorOptions {
  slug?: string;
}

export interface DoctorReport {
  generatedAt: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    affiliateMcpVersion: string;
  };
  config: {
    path: string;
    present: boolean;
    /** Names only — never values. */
    keys: string[];
  };
  adapters: Array<{
    slug: string;
    name: string;
    claimStatus: string;
    knownLimitations: string[];
    resilience: ResilienceConfigMap;
    /**
     * Present only for advertiser-side adapters. Lists the logical brands
     * the operator has bound to this network in brands.json. Empty array
     * when nothing is registered yet.
     */
    brands?: Array<{ slug: string; networkBrandId: string; credentialId: string }>;
  }>;
  /**
   * Advisory client-strategy health. `missing` lists registered brands with no
   * strategy recorded (the gap the onboarding skill fills); `orphans` lists
   * clients/<slug>/ directories whose slug has no brand binding. Orphans are
   * reported, not deleted; cleanup is manual (remove the directory), matching
   * the brands.json no-compaction stance.
   */
  clientStrategies: {
    recorded: number;
    missing: string[];
    orphans: string[];
  };
  diagnostic: Awaited<ReturnType<typeof runDiagnostic>>;
}

export async function buildReport(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = resolveConfigPaths();
  const present = existsSync(paths.envFile);
  let keys: string[] = [];
  if (present) {
    try {
      const text = readFileSync(paths.envFile, 'utf8');
      keys = Object.keys(parseEnvFile(text)).sort();
    } catch {
      keys = [];
    }
  }

  const targets: NetworkAdapter[] = opts.slug
    ? [getAdapter(opts.slug)].filter((a): a is NetworkAdapter => Boolean(a))
    : getAdapters();

  const diagnostic = await runDiagnostic(opts.slug);

  // Advisory client-strategy health is book-level (network-agnostic), so it is
  // reported whether or not a single network slug was requested.
  let clientStrategies = { recorded: 0, missing: [] as string[], orphans: [] as string[] };
  try {
    const rows = listClientStrategies();
    clientStrategies = {
      recorded: rows.filter((r) => r.hasStrategy || r.hasKpi).length,
      missing: rows.filter((r) => r.registered && !r.hasStrategy && !r.hasKpi).map((r) => r.slug),
      orphans: rows.filter((r) => r.orphan).map((r) => r.slug),
    };
  } catch {
    // brands.json or the clients dir unreadable: surface gracefully as empty.
  }

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      affiliateMcpVersion: readPackageVersion(),
    },
    config: {
      path: paths.envFile,
      present,
      keys,
    },
    adapters: targets.map((a) => {
      const base = {
        slug: a.slug,
        name: a.name,
        claimStatus: a.meta.claimStatus,
        knownLimitations: a.meta.knownLimitations,
        resilience: a.resilienceConfig,
      };
      if (a.meta.side !== 'advertiser') return base;
      let brands: Array<{ slug: string; networkBrandId: string; credentialId: string }> = [];
      try {
        brands = listBrandsForNetwork(a.slug);
      } catch {
        // brands.json missing or malformed — surface gracefully as empty.
        brands = [];
      }
      return { ...base, brands };
    }),
    clientStrategies,
    diagnostic,
  };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const report = await buildReport(opts);
  out(JSON.stringify(report, null, 2));

  // Exit code: 0 if every diagnostic result has capabilities (no error) and
  // every supported op is actually supported; 1 otherwise.
  const anyError = report.diagnostic.results.some((r) => r.error);
  return anyError ? 1 : 0;
}

function readPackageVersion(): string {
  // Best-effort. We don't import package.json directly because the rootDir
  // is `src` and the build would not copy it into dist. Use AFFILIATE_MCP_VERSION
  // if the launcher set it; otherwise "unknown".
  return process.env['AFFILIATE_MCP_VERSION'] ?? 'unknown';
}
