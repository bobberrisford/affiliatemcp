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
 *   - Local-first, no network at module load. Optional telemetry remains off
 *     until explicit consent. The ONLY load-time
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
import type {
  AdapterCallContext,
  Click,
  ClickQuery,
  CredentialValidationResult,
  EarningsSummary,
  NetworkAdapter,
  NetworkErrorEnvelope,
  NetworkSlug,
  ProgrammePerformanceQuery,
  ProgrammePerformanceRow,
  Transaction,
  TransactionQuery,
} from '../shared/types.js';
import { BrandNotRegistered, buildErrorEnvelope, toErrorEnvelope } from '../shared/errors.js';
import { cacheKey, credentialHashFor, pickTtl, withCache } from '../shared/cache.js';
import { getCredential, loadConfig } from '../shared/config.js';
import { CREDENTIAL_HELP } from './credential-help.js';
import {
  recordTelemetry,
  setTelemetryConsent,
  telemetryConsent,
} from '../shared/telemetry.js';

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

export function getTelemetryConsent(): 'enabled' | 'disabled' | 'unset' {
  return telemetryConsent();
}

export function saveTelemetryConsent(enabled: boolean): { ok: true; enabled: boolean } {
  setTelemetryConsent(enabled);
  if (enabled) recordTelemetry('lifecycle', 'desktop_consent_enabled', 'success');
  return { ok: true, enabled };
}

export function recordDesktopInstallComplete(): void {
  recordTelemetry('lifecycle', 'setup_complete', 'success');
  recordTelemetry('lifecycle', 'install_complete', 'success');
}

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

/**
 * The registered networks whose credentials are already present, i.e. the ones
 * a data read can actually authenticate against. Uses the same cheap,
 * network-free check as the cockpit (every setup-step field has a value) and
 * loads the stored `.env` first so it reflects a completed setup. Powers the
 * data-locker picker, so the GUI offers only networks the user can pull from
 * rather than the full registry.
 */
export function listConfiguredNetworks(): NetworkSummary[] {
  loadConfig();
  return listNetworks().filter((n) => {
    const adapter = getAdapter(n.slug);
    if (!adapter) return false;
    return adapter.setupSteps().every((step) => {
      const value = getCredential(step.field);
      return value !== undefined && value !== '';
    });
  });
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
 *
 * Rejects duplicate slugs within a single call: `registerBrand` keys a binding
 * by `(slug, network)`, so two selections sharing a nickname would have the
 * second overwrite the first while both still counted as writes — silently
 * losing a brand. Throwing instead makes the collision loud rather than letting
 * a `count` backstop report a success that actually dropped a binding.
 */
export async function saveBrands(
  network: string,
  selections: Array<{ networkBrandId: string; slug: string }>,
): Promise<{ ok: true; count: number }> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { slug } of selections) {
    if (!isValidBrandSlug(slug)) continue;
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate brand nickname(s) for ${network}: ${[...duplicates].join(', ')}. ` +
        'Each brand needs a unique nickname.',
    );
  }
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
 * `env` (e.g. `{ ELECTRON_RUN_AS_NODE: '1' }`) is attached to the bundled-runtime
 * entry so the COMPLETE entry — command, args, AND env — is written in one
 * atomic/backup pass. The desktop app no longer hand-patches the config after
 * the fact, so a failed write surfaces as a thrown error rather than silently
 * leaving an entry that launches the GUI instead of the MCP server.
 *
 * On platforms where Claude Desktop is not supported (`resolveDesktopConfigPath`
 * returns `null`, e.g. Linux), returns an `'absent'` result with the path nulled
 * out rather than writing a file no client will read.
 */
export async function connectClaudeDesktop(
  opts: {
    nodePath?: string;
    serverPath?: string;
    env?: Record<string, string>;
    forceOverwrite?: boolean;
  } = {},
): Promise<DesktopEditResult> {
  const configPath = resolveDesktopConfigPath();
  if (configPath === null) {
    return { path: '', action: 'absent' };
  }
  const entryOpts: { nodePath?: string; serverPath?: string; env?: Record<string, string> } = {};
  if (opts.nodePath !== undefined) entryOpts.nodePath = opts.nodePath;
  if (opts.serverPath !== undefined) entryOpts.serverPath = opts.serverPath;
  if (opts.env !== undefined) entryOpts.env = opts.env;
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

// ---------------------------------------------------------------------------
// Read-only performance data
// ---------------------------------------------------------------------------
//
// These power the desktop "data locker" (decision
// docs/decisions/2026-06-29-desktop-data-export.md): pull performance data,
// view it, export it. The app surfaces and exports data; it does NOT interpret
// it — analysis stays with Claude and the skills. So this facade is read-only
// and additive; it changes no existing signature and adds no MCP tool.
//
// It deliberately reuses the SAME shared primitives the MCP tools layer uses
// (src/tools/generate.ts): `pickTtl`/`cacheKey`/`credentialHashFor`/`withCache`
// for caching, `buildAdapterCallContext` for advertiser brand resolution, and
// `toErrorEnvelope` for Principle 4.1 error coercion. No domain logic is copied
// into this client — only thin glue over those primitives, so the desktop and
// Claude's server share one cache store and one error contract rather than
// drifting apart.

/**
 * Structured-clone-safe result for a read. The error branch carries a
 * `NetworkErrorEnvelope` (Principle 4.1) rather than throwing, so a failure
 * crosses the IPC boundary intact and is never faked into success. Mirrors the
 * discriminated-union style of `verifyAuth`/`validateField`.
 */
export type DataResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: NetworkErrorEnvelope };

type ReadOperation =
  | 'getEarningsSummary'
  | 'listTransactions'
  | 'listClicks'
  | 'getProgrammePerformance';

/**
 * Shared cached-read core for the four public reads below.
 *
 * Loads stored credentials into `process.env` (adapters authenticate from env,
 * exactly as they do under the MCP server), resolves the adapter, threads
 * advertiser brand context, applies the same TTL/cache policy as the tools
 * layer, and coerces any failure into a `NetworkErrorEnvelope`.
 */
async function readOperation<T>(
  slug: string,
  operation: ReadOperation,
  query: Record<string, unknown>,
  invoke: (adapter: NetworkAdapter, ctx?: AdapterCallContext) => Promise<T>,
  brand?: string,
): Promise<DataResult<T>> {
  // Idempotent and non-overwriting (`process.env` wins), so calling it per read
  // is safe: it makes the locker self-sufficient after setup without forcing
  // every caller to bootstrap env first.
  loadConfig();

  const adapter = getAdapter(slug);
  if (!adapter) {
    return {
      ok: false,
      error: buildErrorEnvelope({
        type: 'config_error',
        network: slug as NetworkSlug,
        operation,
        message: `No adapter registered for network "${slug}".`,
      }),
    };
  }
  const network = adapter.slug;
  const advertiserSide = adapter.meta.side === 'advertiser';

  try {
    let ctx: AdapterCallContext | undefined;
    let cacheArgs: Record<string, unknown> = query;

    if (advertiserSide) {
      if (!brand) {
        return {
          ok: false,
          error: buildErrorEnvelope({
            type: 'config_error',
            network,
            operation,
            message: `Network "${slug}" is advertiser-side; a brand is required to address the right account.`,
          }),
        };
      }
      // Resolves (brand, network) -> networkBrandId; throws BrandNotRegistered
      // BEFORE any network call, matching the tools layer. Dynamic import so
      // publisher-only use never loads the resolver.
      const { buildAdapterCallContext } = await import('../shared/brand-resolver.js');
      ctx = buildAdapterCallContext(brand, network);
      // Separate cache entries per brand under one credential set.
      cacheArgs = { ...query, __networkBrandId: ctx.networkBrandId };
    }

    const ttl = pickTtl(operation, query, new Date(), advertiserSide);
    const run = (): Promise<T> => invoke(adapter, ctx);
    if (ttl <= 0) {
      return { ok: true, data: await run() };
    }
    const key = cacheKey({
      network,
      operation,
      args: cacheArgs,
      adapterVersion: adapter.meta.adapterVersion,
      credentialHash: credentialHashFor(network),
    });
    return { ok: true, data: await withCache(key, ttl, run) };
  } catch (err) {
    // Brand resolution fails before any network call; surface it as the same
    // config_error the MCP layer reports rather than a generic API error.
    if (err instanceof BrandNotRegistered) {
      return {
        ok: false,
        error: buildErrorEnvelope({ type: 'config_error', network, operation, message: err.message }),
      };
    }
    return { ok: false, error: toErrorEnvelope(err, { network, operation }) };
  }
}

/**
 * Earnings summary for one network over a window, with by-programme and
 * by-status breakdowns. Pass `brand` for advertiser-side networks.
 */
export function getEarnings(
  slug: string,
  query: TransactionQuery = {},
  brand?: string,
): Promise<DataResult<EarningsSummary>> {
  return readOperation(
    slug,
    'getEarningsSummary',
    query as Record<string, unknown>,
    (a, ctx) => a.getEarningsSummary(query, ctx),
    brand,
  );
}

/**
 * Transactions for one network (the rows behind an export). Pass `brand` for
 * advertiser-side networks.
 */
export function listTransactions(
  slug: string,
  query: TransactionQuery = {},
  brand?: string,
): Promise<DataResult<Transaction[]>> {
  return readOperation(
    slug,
    'listTransactions',
    query as Record<string, unknown>,
    (a, ctx) => a.listTransactions(query, ctx),
    brand,
  );
}

/** Clicks for one network. Pass `brand` for advertiser-side networks. */
export function listClicks(
  slug: string,
  query: ClickQuery = {},
  brand?: string,
): Promise<DataResult<Click[]>> {
  return readOperation(
    slug,
    'listClicks',
    query as Record<string, unknown>,
    (a, ctx) => a.listClicks(query, ctx),
    brand,
  );
}

/**
 * Per-publisher performance rows for an advertiser-side network. `brand` is
 * required. Returns a `not_implemented` envelope for adapters (publisher-side,
 * or advertisers that do not expose it) that lack the operation.
 */
export function getProgrammePerformance(
  slug: string,
  query: ProgrammePerformanceQuery = {},
  brand?: string,
): Promise<DataResult<ProgrammePerformanceRow[]>> {
  return readOperation(
    slug,
    'getProgrammePerformance',
    query as Record<string, unknown>,
    (a, ctx) => {
      if (typeof a.getProgrammePerformance !== 'function') {
        throw new NotImplementedError(
          `Adapter "${a.slug}" does not implement getProgrammePerformance.`,
        );
      }
      return a.getProgrammePerformance(query, ctx);
    },
    brand,
  );
}
