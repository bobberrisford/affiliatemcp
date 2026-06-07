/**
 * affiliate-mcp — core facade.
 *
 * A prompter-free, IPC-safe programmatic API over the existing CLI/wizard
 * primitives. The desktop app (and any future GUI surface) drives onboarding
 * through these functions instead of shelling out to the CLI or forking wizard
 * logic — there is exactly one copy of the adapter core (D9), and this is the
 * thin wrapper around it.
 *
 * Design constraints honoured here:
 *   - Local-first, no telemetry, no network at module load. The ONLY load-time
 *     side-effect is importing `../networks/index.js` so the adapter registry
 *     is populated (it is empty until something triggers the registration
 *     side-effects). Every other function is lazy and explicit.
 *   - Nothing crosses an IPC boundary that cannot be structured-cloned: the
 *     `validateOnEntry` function on `SetupStep` is STRIPPED here.
 *   - Errors are surfaced, never faked into success (PRD §4.1).
 *   - UK spelling in any user-facing strings.
 */

import '../networks/index.js'; // side-effect: populate the adapter registry.

import { getAdapter, getAdapters } from '../shared/registry.js';
import { resolveConfigPaths } from '../cli/wizard/paths.js';
import { mergeEnv, readEnv, writeEnv } from '../cli/wizard/envfile.js';
import { isValidBrandSlug, registerBrand } from '../shared/brands.js';
import {
  AFFILIATE_ENTRY_VALUE,
  addAffiliateEntry,
  buildAffiliateEntryValue,
  resolveDesktopConfigPath,
  type DesktopEditResult,
} from '../cli/install/claude-desktop.js';
import { detectClients as detectClientsImpl } from '../cli/install/detect.js';
import { NotImplementedError } from '../shared/types.js';
import type { CredentialValidationResult } from '../shared/types.js';
import { CREDENTIAL_HELP } from './credential-help.js';

// ---------------------------------------------------------------------------
// Public DTOs — all plain, structured-clone-safe shapes (no functions).
// ---------------------------------------------------------------------------

export interface NetworkSummary {
  slug: string;
  name: string;
  /** `'brand'` for advertiser-side adapters, `'publisher'` otherwise. */
  side: 'publisher' | 'brand';
  setupMinutes: number;
  approval: boolean;
  multiBrand: boolean;
}

export interface EnrichedStep {
  field: string;
  label: string;
  description: string;
  type: 'text' | 'password' | 'number';
  example?: string;
  /** Deep-link to the exact dashboard page, from the credential-help sidecar. */
  deepLink?: string;
}

export interface DiscoveredBrandSummary {
  id: string;
  name: string;
  status: 'active' | 'pending';
}

export type VerifyAuthResult =
  | { ok: true; identity?: string }
  | { ok: false; reason: string };

// Re-export the install/detect surfaces the GUI consumes verbatim.
export { detectClientsImpl as detectClients };
export type { DesktopEditResult };

// ---------------------------------------------------------------------------
// listNetworks
// ---------------------------------------------------------------------------

/**
 * Every registered adapter, summarised for the network picker, sorted by name.
 */
export function listNetworks(): NetworkSummary[] {
  return getAdapters()
    .map((a): NetworkSummary => ({
      slug: a.slug,
      name: a.name,
      side: a.meta.side === 'advertiser' ? 'brand' : 'publisher',
      setupMinutes: a.meta.setupTimeEstimateMinutes,
      approval: a.meta.setupRequiresApproval,
      multiBrand: a.meta.credentialScope === 'multi-brand',
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

// ---------------------------------------------------------------------------
// setupSteps
// ---------------------------------------------------------------------------

/**
 * The adapter's setup steps, merged with the credential-help sidecar and with
 * `validateOnEntry` STRIPPED (a function cannot cross the IPC boundary — live
 * validation goes through `validateField` instead).
 *
 * Merge precedence: a sidecar `description` overrides the adapter's; a sidecar
 * `deepLink` is added; a sidecar `example` fills in only when the adapter step
 * had none. Networks with no sidecar entry fall back to the adapter's own copy.
 */
export function setupSteps(slug: string): EnrichedStep[] {
  const adapter = getAdapter(slug);
  if (!adapter) {
    throw new Error(`No adapter registered for network "${slug}".`);
  }
  const help = CREDENTIAL_HELP[slug] ?? {};
  return adapter.setupSteps().map((step): EnrichedStep => {
    const h = help[step.field];
    const enriched: EnrichedStep = {
      field: step.field,
      label: step.label,
      description: h?.description ?? step.description,
      type: step.type,
    };
    const example = step.example ?? h?.example;
    if (example !== undefined) enriched.example = example;
    if (h?.deepLink !== undefined) enriched.deepLink = h.deepLink;
    return enriched;
  });
}

// ---------------------------------------------------------------------------
// validateField
// ---------------------------------------------------------------------------

/**
 * Live, per-field validation. Delegates to the adapter's `validateCredential`.
 * A thrown error is normalised into a failed result rather than propagated, so
 * the GUI always gets a structured answer.
 */
export async function validateField(
  slug: string,
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  const adapter = getAdapter(slug);
  if (!adapter) {
    return { ok: false, message: `No adapter registered for network "${slug}".` };
  }
  try {
    return await adapter.validateCredential(field, value);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

/**
 * End-to-end auth verification. Stashes each supplied value into `process.env`
 * (mirroring `src/cli/setup.ts`, whose adapters read credentials from env) and
 * then calls the adapter's `verifyAuth()`, returning its result verbatim. A
 * thrown error becomes `{ ok: false, reason }`.
 */
export async function verifyAuth(
  slug: string,
  values: Record<string, string>,
): Promise<VerifyAuthResult> {
  const adapter = getAdapter(slug);
  if (!adapter) {
    return { ok: false, reason: `No adapter registered for network "${slug}".` };
  }
  for (const [field, value] of Object.entries(values)) {
    process.env[field] = value;
  }
  try {
    return await adapter.verifyAuth();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// discoverBrands
// ---------------------------------------------------------------------------

/**
 * Enumerate the brands a multi-brand adapter's credentials can address. Returns
 * `[]` for single-brand adapters, adapters without `listBrands`, or when the
 * adapter reports `NotImplementedError` (e.g. CJ has no enumeration endpoint) —
 * the GUI offers manual entry in those cases. Any other error propagates so the
 * caller can surface the real reason.
 */
export async function discoverBrands(slug: string): Promise<DiscoveredBrandSummary[]> {
  const adapter = getAdapter(slug);
  if (!adapter || typeof adapter.listBrands !== 'function') {
    return [];
  }
  try {
    const brands = await adapter.listBrands();
    return brands.map((b): DiscoveredBrandSummary => ({
      id: b.networkBrandId,
      name: b.displayName,
      status: b.apiEnabled ? 'active' : 'pending',
    }));
  } catch (err) {
    if (err instanceof NotImplementedError) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// saveEnv
// ---------------------------------------------------------------------------

/**
 * Merge `entries` over the existing `.env` and write it back at 0600. Returns
 * the absolute path written. Honours `AFFILIATE_MCP_CONFIG_DIR` via
 * `resolveConfigPaths`.
 */
export async function saveEnv(
  entries: Record<string, string>,
): Promise<{ ok: true; path: string }> {
  const { envFile } = resolveConfigPaths();
  const merged = mergeEnv(readEnv(envFile), entries);
  writeEnv(envFile, merged);
  return { ok: true, path: envFile };
}

// ---------------------------------------------------------------------------
// saveBrands
// ---------------------------------------------------------------------------

/**
 * Persist brand bindings to `brands.json`. Each selection binds a logical slug
 * to the network's own brand id under the `'default'` credential set. Invalid
 * slugs are skipped; the returned `count` is the number actually written.
 */
export async function saveBrands(
  network: string,
  selections: Array<{ networkBrandId: string; slug: string }>,
): Promise<{ ok: true; count: number }> {
  let count = 0;
  for (const { networkBrandId, slug } of selections) {
    if (!isValidBrandSlug(slug)) continue;
    registerBrand(slug, network, 'default', networkBrandId);
    count += 1;
  }
  return { ok: true, count };
}

// ---------------------------------------------------------------------------
// connectClaudeDesktop
// ---------------------------------------------------------------------------

/**
 * Wire this server into Claude Desktop's MCP config. When both `nodePath` and
 * `serverPath` are supplied, the config entry spawns that exact bundled runtime
 * (D9); otherwise it falls back to the `npx affiliate-networks-mcp` default.
 *
 * On platforms where Claude Desktop is not supported (`resolveDesktopConfigPath`
 * returns `null`, e.g. Linux), returns an `'absent'` result with the path nulled
 * out rather than writing a file no client will read.
 */
export async function connectClaudeDesktop(
  opts: { nodePath?: string; serverPath?: string; forceOverwrite?: boolean } = {},
): Promise<DesktopEditResult> {
  const configPath = resolveDesktopConfigPath();
  if (configPath === null) {
    return { path: '', action: 'absent' };
  }
  const entryOpts: { nodePath?: string; serverPath?: string } = {};
  if (opts.nodePath !== undefined) entryOpts.nodePath = opts.nodePath;
  if (opts.serverPath !== undefined) entryOpts.serverPath = opts.serverPath;
  const entryValue =
    opts.nodePath && opts.serverPath
      ? buildAffiliateEntryValue(entryOpts)
      : { command: AFFILIATE_ENTRY_VALUE.command, args: [...AFFILIATE_ENTRY_VALUE.args] };
  return addAffiliateEntry({
    configPath,
    forceOverwrite: opts.forceOverwrite ?? false,
    entryValue,
  });
}
