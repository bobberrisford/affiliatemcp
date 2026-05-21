#!/usr/bin/env tsx
/**
 * network.json schema + validator.
 *
 * Each network adapter ships a `network.json` manifest beside its source. This
 * script enforces the shared schema and (when an adapter is registered for the
 * slug) runs the diagnostic suite from `src/shared/diagnostic.ts`.
 *
 * CLI: `npm run validate:network -- <slug>` — validates the manifest at
 * `src/networks/<slug>/network.json`. At v0.1, no adapters are registered, so
 * only the schema check runs; live validation lights up in chunks 2/3/5/6.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { validateNetwork } from '../src/shared/diagnostic.js';
import { getAdapter } from '../src/shared/registry.js';

// Side-effect import: populates the registry so the live diagnostic short-circuit
// (`getAdapter(slug)`) below actually finds adapters at runtime.
import '../src/networks/index.js';

export const NetworkJsonSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, kebab-case'),
    name: z.string().min(1),
    base_url: z.string().url(),
    auth_model: z.enum(['bearer', 'oauth2', 'basic', 'custom']),
    env_vars: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).nonempty(),
    setup_time_estimate_minutes: z.number().int().positive(),
    setup_requires_approval: z.boolean(),
    setup_approval_days_typical: z.number().int().positive().optional(),
    known_limitations: z.array(z.string()),
    claim_status: z.enum(['production', 'partial', 'experimental', 'unsupported']),
    adapter_version: z.string().regex(/^\d+\.\d+\.\d+/),
    last_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    supports_brand_ops: z.boolean(),
    docs_url: z.string().url().optional(),
  })
  .strict();

export type NetworkJson = z.infer<typeof NetworkJsonSchema>;

export interface SchemaValidationOutcome {
  ok: boolean;
  manifestPath: string;
  errors?: string[];
  manifest?: NetworkJson;
}

export function validateManifest(manifestPath: string): SchemaValidationOutcome {
  if (!existsSync(manifestPath)) {
    return { ok: false, manifestPath, errors: [`network.json not found at ${manifestPath}`] };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      manifestPath,
      errors: [`network.json is not valid JSON: ${(err as Error).message}`],
    };
  }
  const result = NetworkJsonSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      manifestPath,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, manifestPath, manifest: result.data };
}

async function runCli(slug: string): Promise<number> {
  const manifestPath = path.resolve(process.cwd(), 'src', 'networks', slug, 'network.json');
  const outcome = validateManifest(manifestPath);
  process.stderr.write(`\nnetwork.json validation for "${slug}"\n`);
  process.stderr.write(`  path: ${outcome.manifestPath}\n`);
  if (!outcome.ok) {
    process.stderr.write('  status: FAIL\n');
    for (const e of outcome.errors ?? []) process.stderr.write(`    - ${e}\n`);
    return 1;
  }
  process.stderr.write('  status: OK\n');
  if (outcome.manifest) {
    process.stderr.write(`  adapter_version: ${outcome.manifest.adapter_version}\n`);
    process.stderr.write(`  claim_status: ${outcome.manifest.claim_status}\n`);
    process.stderr.write(`  last_verified: ${outcome.manifest.last_verified}\n`);
  }

  // If an adapter is registered, run the live diagnostic too.
  if (getAdapter(slug)) {
    process.stderr.write('\nlive diagnostic\n');
    const r = await validateNetwork(slug);
    for (const c of r.checks) {
      process.stderr.write(
        `  - ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ` :: ${c.detail}` : ''}\n`,
      );
    }
    return r.ok ? 0 : 1;
  }
  process.stderr.write('\n(no adapter registered for this slug; live diagnostic skipped)\n');
  return 0;
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-network-json.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  const slug = process.argv[2];
  if (!slug) {
    process.stderr.write('Usage: validate-network-json <slug>\n');
    process.exit(2);
  }
  runCli(slug).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`validate-network-json fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}

// Re-export for use by other tooling.
export { runCli };
// Silence lint when fileURLToPath isn't otherwise used.
void fileURLToPath;
