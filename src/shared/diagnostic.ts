/**
 * Diagnostic engine skeleton.
 *
 * `runDiagnostic` collects `NetworkCapabilities` for one or all registered
 * adapters by calling each adapter's `capabilitiesCheck()`. `validateNetwork`
 * orchestrates the broader validation suite used by `affiliate-mcp validate`
 * and `npm run validate:network`.
 *
 * Both functions are designed never to throw on adapter failure — failures
 * surface inside the returned structure so the caller (CLI, tool handler,
 * generator) renders them honestly.
 */

import type { NetworkAdapter, NetworkCapabilities, NetworkSlug } from './types.js';
import { getAdapter, getAdapters } from './registry.js';
import { createLogger } from './logging.js';
import { isErrorEnvelope, NetworkError } from './errors.js';

const log = createLogger('diagnostic');

export interface DiagnosticResult {
  generatedAt: string;
  results: Array<{
    network: NetworkSlug;
    capabilities?: NetworkCapabilities;
    error?: {
      message: string;
      detail?: unknown;
    };
  }>;
}

/**
 * Run `capabilitiesCheck()` for one or all adapters. When `slug` is provided
 * but unknown, the returned result includes a single error entry.
 */
export async function runDiagnostic(slug?: NetworkSlug): Promise<DiagnosticResult> {
  const generatedAt = new Date().toISOString();

  if (slug !== undefined) {
    const adapter = getAdapter(slug);
    if (!adapter) {
      return {
        generatedAt,
        results: [
          {
            network: slug,
            error: { message: `No adapter registered for network "${slug}".` },
          },
        ],
      };
    }
    return { generatedAt, results: [await checkOne(adapter)] };
  }

  const all = getAdapters();
  if (all.length === 0) {
    log.warn('no adapters registered — diagnostic will return an empty list');
  }
  const results = await Promise.all(all.map(checkOne));
  return { generatedAt, results };
}

async function checkOne(
  adapter: NetworkAdapter,
): Promise<DiagnosticResult['results'][number]> {
  try {
    const capabilities = await adapter.capabilitiesCheck();
    return { network: adapter.slug, capabilities };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { network: adapter.slug, error: { message: err.message, detail: err.envelope } };
    }
    if (isErrorEnvelope(err)) {
      return { network: adapter.slug, error: { message: err.message, detail: err } };
    }
    return {
      network: adapter.slug,
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    };
  }
}

// ---------------------------------------------------------------------------
// validateNetwork — used by CLI `validate` and by `scripts/validate-network-json.ts`.
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ValidationResult {
  network: NetworkSlug;
  generatedAt: string;
  checks: ValidationCheck[];
  ok: boolean;
}

/**
 * Orchestrate the full validation suite for a single network. At v0.1 the
 * adapter registry is empty, so this returns a not-registered failure. Once
 * Chunk 2+ adds adapters it exercises each of the seven publisher ops.
 */
export async function validateNetwork(slug: NetworkSlug): Promise<ValidationResult> {
  const generatedAt = new Date().toISOString();
  const checks: ValidationCheck[] = [];

  const adapter = getAdapter(slug);
  if (!adapter) {
    checks.push({
      name: 'registry',
      ok: false,
      detail: `No adapter registered for "${slug}". Validation can only run on a registered network.`,
    });
    return { network: slug, generatedAt, checks, ok: false };
  }
  checks.push({ name: 'registry', ok: true });

  // Auth verify.
  try {
    const r = await adapter.verifyAuth();
    checks.push({
      name: 'verifyAuth',
      ok: r.ok,
      detail: r.ok ? r.identity : r.reason,
    });
  } catch (err) {
    checks.push({
      name: 'verifyAuth',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Probe each publisher op (best-effort, swallow errors into the check list).
  const probes: Array<[string, () => Promise<unknown>]> = [
    ['listProgrammes', () => adapter.listProgrammes({ limit: 1 })],
    ['listTransactions', () => adapter.listTransactions({ limit: 1 })],
    ['getEarningsSummary', () => adapter.getEarningsSummary({ limit: 1 })],
    ['listClicks', () => adapter.listClicks({ limit: 1 })],
  ];
  for (const [name, fn] of probes) {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  return { network: slug, generatedAt, checks, ok };
}
