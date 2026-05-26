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
 * Failure modes:
 *   - `NotImplementedError` from `listBrands()` (CJ — no enumeration endpoint):
 *     print a plain-English explainer and drop into a manual-entry sub-flow.
 *   - Any other error from `listBrands()` (network / auth / etc.): surface the
 *     reason and offer the manual-entry sub-flow as a fallback.
 *   - Empty result list (credentials valid, but no brands linked yet): explain
 *     and offer the manual-entry sub-flow.
 *
 * The manual-entry sub-flow asks for a slug + network brand id pair (+ optional
 * display name) and writes via `registerBrand`, looping until the operator
 * declines to add more.
 *
 * Side-effect-free apart from the disk write — testable in isolation by
 * passing in a fake adapter and a `FakePrompter`.
 *
 * No publisher-side or single-brand adapter ever enters this flow.
 */

import { isValidBrandSlug, registerBrand, suggestSlug } from '../../shared/brands.js';
import { assertMultiBrandAdapter } from '../../shared/brand-resolver.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { DiscoveredBrand, NetworkAdapter } from '../../shared/types.js';
import type { Prompter } from './prompts.js';

export interface BrandDiscoveryOutcome {
  /** Brands the adapter reported (before any user filtering). */
  discovered: DiscoveredBrand[];
  /** Bindings actually written to brands.json. */
  registered: Array<{ slug: string; networkBrandId: string }>;
  /** Brands skipped because the user untocked them or the slug was invalid. */
  skipped: Array<{ networkBrandId: string; reason: string }>;
  /**
   * How discovery resolved. `'auto'` = listBrands succeeded with results,
   * `'manual'` = the user added entries via the manual-entry sub-flow,
   * `'mixed'` = both happened in one wizard run,
   * `'none'` = no brands were registered.
   */
  mode: 'auto' | 'manual' | 'mixed' | 'none';
}

export interface BrandDiscoveryOptions {
  /** Capture writes here instead of the file system (tests). */
  writer?: (slug: string, network: string, credentialId: string, networkBrandId: string) => void;
  /** Credential set id to record in brands.json. Defaults to 'default'. */
  credentialId?: string;
  /** Per-line output sink; defaults to process.stdout.write. */
  out?: (line: string) => void;
}

type Writer = (slug: string, network: string, credentialId: string, networkBrandId: string) => void;
type Out = (line: string) => void;

export async function runBrandDiscovery(
  adapter: NetworkAdapter,
  prompter: Prompter,
  opts: BrandDiscoveryOptions = {},
): Promise<BrandDiscoveryOutcome> {
  assertMultiBrandAdapter(adapter);

  const writer: Writer =
    opts.writer ??
    ((slug, network, credentialId, networkBrandId) =>
      registerBrand(slug, network, credentialId, networkBrandId));
  const credentialId = opts.credentialId ?? 'default';
  const out: Out =
    opts.out ?? ((line) => process.stdout.write(line.endsWith('\n') ? line : `${line}\n`));

  // listBrands is required at runtime for multi-brand adapters; the assertion
  // above proves the method exists. Guard with try/catch so the wizard can
  // explain and offer a manual fallback when the network or the adapter says
  // discovery isn't available.
  let discovered: DiscoveredBrand[];
  try {
    discovered = await adapter.listBrands!();
  } catch (err) {
    if (err instanceof NotImplementedError) {
      out(
        `${adapter.name}: this network's API doesn't expose brand discovery ` +
          `(this is normal for CJ). You'll need to add brands manually.`,
      );
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      out(
        `${adapter.name}: we couldn't reach the network to discover your brands. ` +
          `Reason: ${reason}. You can retry, or add brands manually.`,
      );
    }
    const manual = await runManualBrandEntry(adapter, prompter, {
      writer,
      credentialId,
      out,
    });
    return {
      discovered: [],
      registered: manual.registered,
      skipped: manual.skipped,
      mode: manual.registered.length > 0 ? 'manual' : 'none',
    };
  }

  if (discovered.length === 0) {
    out(
      `${adapter.name}: we reached the network but no brands are linked to these ` +
        `credentials yet. You can add brands manually if you know their IDs, or come ` +
        `back after the network grants access.`,
    );
    const offer = await prompter.confirm('Add a brand manually now?', { defaultYes: false });
    if (!offer) {
      return { discovered: [], registered: [], skipped: [], mode: 'none' };
    }
    const manual = await runManualBrandEntry(adapter, prompter, {
      writer,
      credentialId,
      out,
    });
    return {
      discovered: [],
      registered: manual.registered,
      skipped: manual.skipped,
      mode: manual.registered.length > 0 ? 'manual' : 'none',
    };
  }

  out('');
  out(`${adapter.name}: ${discovered.length} brand(s) found.`);
  for (const b of discovered) {
    const flag = b.apiEnabled
      ? ''
      : ' (found but not API-accessible — see your network plan)';
    out(`  - ${b.displayName} [${b.networkBrandId}]${flag}`);
  }

  // Default selection: every brand whose apiEnabled is true.
  const defaultKeys = discovered.filter((b) => b.apiEnabled).map((b) => b.networkBrandId);
  const choices = discovered.map((b) => ({
    key: b.networkBrandId,
    label: `${b.displayName} [${b.networkBrandId}]${b.apiEnabled ? '' : ' (not API-accessible)'}`,
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
    if (b.apiEnabled === false) {
      out(
        `Registered ${slug} -> ${adapter.slug}:${b.networkBrandId} ` +
          `(found but not API-accessible — calls will fail until the brand is upgraded).`,
      );
    } else {
      out(`Registered ${slug} -> ${adapter.slug}:${b.networkBrandId}.`);
    }
  }

  return {
    discovered,
    registered,
    skipped,
    mode: registered.length > 0 ? 'auto' : 'none',
  };
}

interface ManualEntryOptions {
  writer: Writer;
  credentialId: string;
  out: Out;
}

interface ManualEntryOutcome {
  registered: Array<{ slug: string; networkBrandId: string }>;
  skipped: Array<{ networkBrandId: string; reason: string }>;
}

/**
 * Manual brand-entry sub-flow. Loops collecting (slug, networkBrandId)
 * tuples until the operator declines another. Each tuple is validated
 * (slug must match `isValidBrandSlug`; networkBrandId must be non-empty);
 * invalid tuples are recorded in `skipped` and the loop continues.
 *
 * Exported for direct testing — the wizard goes through `runBrandDiscovery`
 * which delegates here on failure or empty discovery.
 */
export async function runManualBrandEntry(
  adapter: NetworkAdapter,
  prompter: Prompter,
  opts: ManualEntryOptions,
): Promise<ManualEntryOutcome> {
  const registered: Array<{ slug: string; networkBrandId: string }> = [];
  const skipped: Array<{ networkBrandId: string; reason: string }> = [];

  for (;;) {
    const slugRaw = (await prompter.text('Local brand slug', {})).trim();
    if (!slugRaw) {
      opts.out('Skipping: a slug is required.');
      skipped.push({ networkBrandId: '', reason: 'empty slug' });
    } else if (!isValidBrandSlug(slugRaw)) {
      opts.out(
        `Skipping: "${slugRaw}" is not a valid brand slug ` +
          `(use lowercase letters, digits, and hyphens only).`,
      );
      skipped.push({ networkBrandId: '', reason: `invalid slug "${slugRaw}"` });
    } else {
      const idRaw = (await prompter.text(`Network brand id for ${slugRaw}`, {})).trim();
      if (!idRaw) {
        opts.out('Skipping: a network brand id is required.');
        skipped.push({ networkBrandId: '', reason: 'empty networkBrandId' });
      } else {
        // Display name is optional; we capture it so future surface text
        // can use it, but at v0.1 brands.json doesn't persist the name —
        // the prompt exists for symmetry with the auto-discovery flow and
        // to give the operator a chance to confirm what they're binding.
        const displayRaw = (
          await prompter.text(`Display name for ${slugRaw}`, { defaultValue: slugRaw })
        ).trim();
        const _display = displayRaw || slugRaw;
        void _display;
        opts.writer(slugRaw, adapter.slug, opts.credentialId, idRaw);
        registered.push({ slug: slugRaw, networkBrandId: idRaw });
        opts.out(`Registered ${slugRaw} -> ${adapter.slug}:${idRaw}.`);
      }
    }

    const more = await prompter.confirm('Register another brand?', { defaultYes: false });
    if (!more) break;
  }

  return { registered, skipped };
}
