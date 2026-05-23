/**
 * brands.json — agency-side mapping of logical brand slugs to network identifiers.
 *
 * Lives at `$AFFILIATE_MCP_CONFIG_DIR/brands.json` (default `~/.affiliate-mcp/brands.json`).
 * Owned by the setup wizard; consumed by the MCP server's brand-resolution
 * layer at request-dispatch time for advertiser-side tools.
 *
 * Every public function reads the file fresh on each call so tests can mutate
 * `AFFILIATE_MCP_CONFIG_DIR` between cases (mirrors the wizard's `paths.ts`
 * pattern — see `src/cli/wizard/paths.ts`).
 *
 * The file shape is intentionally minimal:
 *   - `version: 1` so we can evolve it later without ambiguity.
 *   - `brands: { <slug>: BrandBinding[] }` — one logical brand can fan out to
 *     several networks; that is how cross-network rollups are produced.
 *
 * Writes are atomic (temp + rename) at mode 0600. There is no compaction step —
 * deletes are an explicit future-work item.
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

import type { BrandBinding, BrandsFile, NetworkSlug } from './types.js';

const BRAND_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Resolve the active brands.json path. Honours `AFFILIATE_MCP_CONFIG_DIR`;
 * falls back to `~/.affiliate-mcp/brands.json`.
 *
 * Read on every call rather than at module load — tests mutate the env var
 * between cases.
 */
export function resolveBrandsFile(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const dir = override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
  return path.join(dir, 'brands.json');
}

/**
 * Load brands.json. Returns the default empty shape if the file is missing.
 * Throws if the file exists but is unreadable / unparseable — silent fallback
 * would hide a misconfiguration.
 */
export function loadBrands(): BrandsFile {
  const file = resolveBrandsFile();
  if (!existsSync(file)) return { version: 1, brands: {} };
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`brands.json at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isBrandsFile(parsed)) {
    throw new Error(`brands.json at ${file} has an unrecognised shape (expected version 1).`);
  }
  return parsed;
}

/**
 * Write brands.json atomically: write to a temp sibling, fsync-equivalent via
 * `writeFileSync`, then rename over the target. Mode 0600.
 */
export function saveBrands(brands: BrandsFile): void {
  const file = resolveBrandsFile();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(brands, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

/**
 * Look up the (credentialId, networkBrandId) binding for `brandSlug` on
 * `network`. Returns `null` when no binding exists — callers translate that
 * into a `BrandNotRegistered` error at the tool boundary.
 */
export function resolveBrand(
  brandSlug: string,
  network: NetworkSlug,
): { credentialId: string; networkBrandId: string } | null {
  const file = loadBrands();
  const bindings = file.brands[brandSlug];
  if (!bindings) return null;
  const match = bindings.find((b) => b.network === network);
  if (!match) return null;
  return { credentialId: match.credentialId, networkBrandId: match.networkBrandId };
}

/**
 * List every brand registered against `network`, in the order they appear in
 * the file. Useful for the doctor surface and the `affiliate_resolve_brand`
 * meta-tool.
 */
export function listBrandsForNetwork(
  network: NetworkSlug,
): Array<{ slug: string; credentialId: string; networkBrandId: string }> {
  const file = loadBrands();
  const out: Array<{ slug: string; credentialId: string; networkBrandId: string }> = [];
  for (const [slug, bindings] of Object.entries(file.brands)) {
    for (const b of bindings) {
      if (b.network === network) {
        out.push({ slug, credentialId: b.credentialId, networkBrandId: b.networkBrandId });
      }
    }
  }
  return out;
}

/**
 * Additive register: load, append (or replace the matching network entry on
 * the same slug), save. Idempotent on (slug, network) — a second call with
 * the same pair updates the credential/brand id in place rather than creating
 * a duplicate binding.
 */
export function registerBrand(
  slug: string,
  network: NetworkSlug,
  credentialId: string,
  networkBrandId: string,
): void {
  if (!BRAND_SLUG_RE.test(slug)) {
    throw new Error(
      `Brand slug "${slug}" is invalid. Use lowercase letters, digits, and hyphens only.`,
    );
  }
  if (!network) throw new Error('Network is required.');
  if (!credentialId) throw new Error('credentialId is required.');
  if (!networkBrandId) throw new Error('networkBrandId is required.');

  const file = loadBrands();
  const bindings = file.brands[slug] ?? [];
  const existingIdx = bindings.findIndex((b) => b.network === network);
  const next: BrandBinding = { network, credentialId, networkBrandId };
  if (existingIdx >= 0) {
    bindings[existingIdx] = next;
  } else {
    bindings.push(next);
  }
  file.brands[slug] = bindings;
  saveBrands(file);
}

/** Validate that a string conforms to the brand-slug rule. */
export function isValidBrandSlug(value: string): boolean {
  return BRAND_SLUG_RE.test(value);
}

/**
 * Suggest a sensible local slug for a discovered brand's display name.
 * Lowercases, strips non-permitted characters, collapses runs of hyphens.
 */
export function suggestSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isBrandsFile(value: unknown): value is BrandsFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) return false;
  if (!v['brands'] || typeof v['brands'] !== 'object') return false;
  for (const bindings of Object.values(v['brands'] as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) return false;
    for (const b of bindings) {
      if (!b || typeof b !== 'object') return false;
      const bb = b as Record<string, unknown>;
      if (typeof bb['network'] !== 'string') return false;
      if (typeof bb['credentialId'] !== 'string') return false;
      if (typeof bb['networkBrandId'] !== 'string') return false;
    }
  }
  return true;
}
