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
