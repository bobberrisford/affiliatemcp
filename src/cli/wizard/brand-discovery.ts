/**
 * Brand-discovery sub-flow for the setup wizard.
 *
 * Invoked from `runSetup` after a multi-brand advertiser-side adapter's
 * credentials have been captured and `verifyAuth()` has passed. The sub-flow:
 *
 *   1. Calls `adapter.listBrands()` to enumerate every brand the credential
 *      set can address.
 *   2. Renders the list with `apiEnabled: true` ticked by default.
 *   3. Prompts the operator for the logical slug to bind each one to
 *      (default: the displayName slugified).
 *   4. Writes the selected bindings to `brands.json` via `registerBrand`.
 *
 * Side-effect-free apart from the disk write — testable in isolation by
 * passing in a fake adapter and a `FakePrompter`.
 *
 * No publisher-side or single-brand adapter ever enters this flow.
 */

import { isValidBrandSlug, registerBrand, suggestSlug } from '../../shared/brands.js';
import { assertMultiBrandAdapter } from '../../shared/brand-resolver.js';
import type { DiscoveredBrand, NetworkAdapter } from '../../shared/types.js';
import type { Prompter } from './prompts.js';

export interface BrandDiscoveryOutcome {
  /** Brands the adapter reported (before any user filtering). */
  discovered: DiscoveredBrand[];
  /** Bindings actually written to brands.json. */
  registered: Array<{ slug: string; networkBrandId: string }>;
  /** Brands skipped because the user untocked them or the slug was invalid. */
  skipped: Array<{ networkBrandId: string; reason: string }>;
}

export interface BrandDiscoveryOptions {
  /** Capture writes here instead of the file system (tests). */
  writer?: (slug: string, network: string, credentialId: string, networkBrandId: string) => void;
  /** Credential set id to record in brands.json. Defaults to 'default'. */
  credentialId?: string;
  /** Per-line output sink; defaults to process.stdout.write. */
  out?: (line: string) => void;
}

export async function runBrandDiscovery(
  adapter: NetworkAdapter,
  prompter: Prompter,
  opts: BrandDiscoveryOptions = {},
): Promise<BrandDiscoveryOutcome> {
  assertMultiBrandAdapter(adapter);

  const writer =
    opts.writer ??
    ((slug, network, credentialId, networkBrandId) =>
      registerBrand(slug, network, credentialId, networkBrandId));
  const credentialId = opts.credentialId ?? 'default';
  const out =
    opts.out ?? ((line) => process.stdout.write(line.endsWith('\n') ? line : `${line}\n`));

  // listBrands is required at runtime for multi-brand adapters; the assertion
  // above proves the method exists. The non-null assertion is safe here.
  const discovered = await adapter.listBrands!();

  if (discovered.length === 0) {
    out(`${adapter.name}: the credential set returned no brands. Nothing to register.`);
    return { discovered: [], registered: [], skipped: [] };
  }

  out('');
  out(`${adapter.name}: ${discovered.length} brand(s) found.`);
  for (const b of discovered) {
    const flag = b.apiEnabled ? '' : ' (API disabled)';
    out(`  - ${b.displayName} [${b.networkBrandId}]${flag}`);
  }

  // Default selection: every brand whose apiEnabled is true.
  const defaultKeys = discovered.filter((b) => b.apiEnabled).map((b) => b.networkBrandId);
  const choices = discovered.map((b) => ({
    key: b.networkBrandId,
    label: `${b.displayName} [${b.networkBrandId}]${b.apiEnabled ? '' : ' (API disabled)'}`,
  }));

  const selectedKeys = defaultKeys.length === 0
    ? await prompter.selectMany('Which brands would you like to register?', choices)
    : await prompter.selectMany(
        `Which brands would you like to register? (default: ${defaultKeys.length} api-enabled)`,
        choices,
      );

  const selected = new Set(selectedKeys.length > 0 ? selectedKeys : defaultKeys);

  const registered: Array<{ slug: string; networkBrandId: string }> = [];
  const skipped: Array<{ networkBrandId: string; reason: string }> = [];

  for (const b of discovered) {
    if (!selected.has(b.networkBrandId)) {
      skipped.push({ networkBrandId: b.networkBrandId, reason: 'unticked by operator' });
      continue;
    }
    const suggested = suggestSlug(b.displayName);
    const entered = await prompter.text(
      `Local slug for ${b.displayName}`,
      suggested ? { defaultValue: suggested } : {},
    );
    const slug = (entered || suggested).trim();
    if (!isValidBrandSlug(slug)) {
      out(
        `Skipping ${b.displayName}: "${slug}" is not a valid brand slug ` +
          `(use lowercase letters, digits, and hyphens only).`,
      );
      skipped.push({ networkBrandId: b.networkBrandId, reason: `invalid slug "${slug}"` });
      continue;
    }
    writer(slug, adapter.slug, credentialId, b.networkBrandId);
    registered.push({ slug, networkBrandId: b.networkBrandId });
    out(`Registered ${slug} -> ${adapter.slug}:${b.networkBrandId}.`);
  }

  return { discovered, registered, skipped };
}
