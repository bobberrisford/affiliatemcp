/**
 * `affiliate-mcp setup` — interactive setup wizard.
 *
 * Per PRD §4.3, setup is part of the product, not a side activity. Every
 * surface here is user-facing copy. Errors name the network, name the field,
 * and surface the verbatim underlying reason. No retries hidden, no silent
 * fallbacks.
 *
 * Flow:
 *   1. Detect first-run vs existing config. First-run jumps straight into
 *      network selection; existing config offers setup / reset / add / quit.
 *   2. Pick networks (multi-select).
 *   3. For each picked network: walk `setupSteps()`, prompt per step, call
 *      `validateCredential` on entry where requested, run `verifyAuth()` at
 *      the end and merge any `derivedValues` from the underlying result.
 *   4. Write `~/.affiliate-mcp/.env` (or `$AFFILIATE_MCP_CONFIG_DIR/.env`),
 *      mode 0600. Reset replaces; add merges.
 *   5. Print the absolute path written and a pointer to `affiliate-mcp test`.
 *
 * Output channel: this module writes to STDOUT because the wizard is an
 * interactive surface — the JSON-RPC protocol is not active during `setup`.
 * The shared Pino logger continues to write to stderr only.
 */

import { existsSync } from 'node:fs';

import type { NetworkAdapter, SetupStep } from '../shared/types.js';
import { getAdapters } from '../shared/registry.js';
import { getPrompter, type Prompter } from './wizard/prompts.js';
import { resolveConfigPaths } from './wizard/paths.js';
import { filterOutKeys, mergeEnv, readEnv, writeEnv } from './wizard/envfile.js';
import { runBrandDiscovery } from './wizard/brand-discovery.js';

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function banner(): void {
  out('');
  out('  affiliate-mcp — setup wizard');
  out('  ----------------------------');
  out('  This wizard collects API credentials for each affiliate network you want');
  out('  to use and writes them to a single config file. Tokens are validated as');
  out('  you enter them so problems surface immediately, not at first call.');
  out('');
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** Override the prompter (tests). Falls back to the shared singleton. */
  prompter?: Prompter;
  /**
   * When true, skip the interactive top-level menu and go straight into
   * configuration. Used by tests and by future flags like `--add`.
   */
  mode?: 'auto' | 'setup' | 'reset' | 'add';
}

export async function runSetup(opts: SetupOptions = {}): Promise<number> {
  const prompter = opts.prompter ?? getPrompter();
  const paths = resolveConfigPaths();
  const hasConfig = existsSync(paths.envFile);

  banner();

  // Decide the top-level action.
  let mode = opts.mode ?? 'auto';
  if (mode === 'auto') {
    if (!hasConfig) {
      out(`No config file at ${paths.envFile}.`);
      out('');
      mode = 'setup';
    } else {
      out(`Existing config at ${paths.envFile}.`);
      const choice = await prompter.menu('What would you like to do?', [
        { key: 'add', label: 'add — configure an additional network' },
        { key: 'reset', label: 'reset — wipe and start over' },
        { key: 'quit', label: 'quit — exit without changes' },
      ]);
      if (choice === 'quit') {
        out('No changes made.');
        return 0;
      }
      mode = choice;
    }
  }

  const adapters = getAdapters();
  if (adapters.length === 0) {
    out('No network adapters are registered. This is a build problem, not a config one.');
    out('Reinstall affiliate-mcp or report this at https://github.com/atolls/affiliate-mcp.');
    return 1;
  }

  // Network picker.
  const selected = await pickNetworks(prompter, adapters);
  if (selected.length === 0) {
    out('No networks selected. No changes made.');
    return 0;
  }

  // Existing env — read once. Reset drops the chosen networks' keys; add keeps
  // every existing entry.
  let existing = readEnv(paths.envFile);
  if (mode === 'reset') {
    const drop: string[] = [];
    for (const adapter of selected) {
      for (const step of adapter.setupSteps()) drop.push(step.field);
    }
    existing = filterOutKeys(existing, drop);
  }

  // Walk each network.
  const newEntries: Record<string, string> = {};
  for (const adapter of selected) {
    out('');
    out(`Configuring ${adapter.name} (${adapter.slug})`);
    out('-'.repeat(`Configuring ${adapter.name} (${adapter.slug})`.length));
    if (adapter.meta.setupRequiresApproval) {
      const days = adapter.meta.setupApprovalDaysTypical ?? 0;
      out(
        `Note: ${adapter.name} requires partner approval before API access is granted.` +
          (days > 0 ? ` Typical turnaround is ~${days} business days.` : ''),
      );
    }
    const captured = await runNetworkSetup(prompter, adapter);
    Object.assign(newEntries, captured);
  }

  // Merge and write.
  const merged = mergeEnv(existing, newEntries);
  writeEnv(paths.envFile, merged);

  out('');
  out(`Wrote ${paths.envFile}.`);
  out('You are set up. Test with `affiliate-networks-mcp test`.');

  await offerConnectToClaude(prompter);
  return 0;
}

/**
 * Offer to wire this server up to whichever Claude clients are present. The
 * orchestrator prompts further (which clients, conflict handling), so we ask
 * a single yes/no here and delegate. Failures inside the install flow do not
 * fail setup — the credentials are still saved.
 */
async function offerConnectToClaude(prompter: Prompter): Promise<void> {
  out('');
  const yes = await prompter.confirm(
    'Connect this to Claude Desktop / Claude Code now?',
    { defaultYes: true },
  );
  if (!yes) {
    out('Skipped. Run `affiliate-networks-mcp install` later to connect.');
    return;
  }
  try {
    const { runInstall } = await import('./install.js');
    await runInstall({ prompter });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`Install step failed: ${msg}`);
    out('Your credentials are saved. Run `affiliate-networks-mcp install` to retry.');
  }
}

// ---------------------------------------------------------------------------
// Network picker
// ---------------------------------------------------------------------------

async function pickNetworks(
  prompter: Prompter,
  adapters: NetworkAdapter[],
): Promise<NetworkAdapter[]> {
  const choices = adapters.map((a) => {
    const minutes = a.meta.setupTimeEstimateMinutes;
    const approval = a.meta.setupRequiresApproval ? ', approval required' : '';
    return {
      key: a.slug,
      label: `${a.name} — ~${minutes} min${approval}`,
    };
  });
  const slugs = await prompter.selectMany('Which networks would you like to configure?', choices);
  const set = new Set(slugs);
  return adapters.filter((a) => set.has(a.slug));
}

// ---------------------------------------------------------------------------
// Per-network walk
// ---------------------------------------------------------------------------

/**
 * Drive a single network adapter through its steps. Returns the captured
 * field → value map. Calls `verifyAuth()` at the end and merges any
 * `derivedValues` from the underlying result.
 */
async function runNetworkSetup(
  prompter: Prompter,
  adapter: NetworkAdapter,
): Promise<Record<string, string>> {
  const captured: Record<string, string> = {};
  const steps = adapter.setupSteps();

  for (const step of steps) {
    const value = await runStep(prompter, adapter, step, captured);
    if (value === null) {
      out(`Skipped ${step.field}. You can edit it later in the config file.`);
      continue;
    }
    captured[step.field] = value;
    // Stash into process.env so the subsequent verifyAuth() picks it up.
    process.env[step.field] = value;
  }

  // End-to-end auth verify + derived values merge.
  out('');
  out(`Verifying ${adapter.name} credentials…`);
  try {
    const result = await adapter.verifyAuth();
    if (result.ok) {
      const id = 'identity' in result && result.identity ? ` (${result.identity})` : '';
      out(`Verified${id}.`);
      // Duck-type derivedValues — the public adapter interface does not
      // expose them, but the underlying auth module returns them. See the
      // wizard handoff for why this is an Option B duck-type rather than an
      // interface change.
      const derived = (result as unknown as { derivedValues?: Record<string, string> })
        .derivedValues;
      if (derived) {
        for (const [k, v] of Object.entries(derived)) {
          if (typeof v !== 'string' || v === '') continue;
          if (captured[k] && captured[k] === v) continue;
          captured[k] = v;
          process.env[k] = v;
          out(`Derived ${k} = ${v} from your credentials (no manual entry needed).`);
        }
      }
      // Brand discovery — only runs for multi-brand adapters. The check
      // here mirrors the runtime requirement in `brand-resolver.ts`:
      // adapters with `meta.credentialScope === 'multi-brand'` must
      // implement `listBrands()`. Failures inside the sub-flow are
      // surfaced verbatim; the env file still gets written.
      if (adapter.meta.credentialScope === 'multi-brand') {
        try {
          await runBrandDiscovery(adapter, prompter);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          out(`${adapter.name} brand discovery failed: ${msg}`);
          out('Credentials saved; you can re-run setup once the issue is fixed.');
        }
      }
    } else {
      out(
        `${adapter.name} verifyAuth failed: ${result.reason}`,
      );
      out('Credentials saved anyway so you can edit and re-run `affiliate-networks-mcp test`.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`${adapter.name} verifyAuth raised an error: ${msg}`);
    out('Credentials saved anyway so you can edit and re-run `affiliate-networks-mcp test`.');
  }

  return captured;
}

/**
 * Run a single step: render description verbatim, prompt for input, call
 * `validateOnEntry` if present, offer retry/edit/skip on failure.
 *
 * Returns the captured value, or null if the user skipped.
 */
async function runStep(
  prompter: Prompter,
  adapter: NetworkAdapter,
  step: SetupStep,
  _captured: Record<string, string>,
): Promise<string | null> {
  out('');
  // Verbatim description — written by the network's adapter author.
  for (const line of step.description.split('\n')) out(line);

  for (;;) {
    const value = await promptForStep(prompter, step);
    if (value === '') {
      out(`${step.field} is empty. Skipping is allowed; you can add it later.`);
      const skip = await prompter.confirm('Skip this field?');
      if (skip) return null;
      continue;
    }

    // validateOnEntry — if defined, run it and surface the verbatim reason.
    if (step.validateOnEntry) {
      let result;
      try {
        result = await step.validateOnEntry(value);
      } catch (err) {
        result = {
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (!result.ok) {
        // PRD §4.1: name the network, name the field, surface the reason.
        out(`${adapter.name} rejected ${step.field}: ${result.message ?? 'invalid value'}`);
        if (result.hint) out(`Hint: ${result.hint}`);
        const next = await prompter.menu('What next?', [
          { key: 'retry', label: 'retry — enter again' },
          { key: 'skip', label: 'skip — leave blank for now' },
        ]);
        if (next === 'skip') return null;
        continue;
      }
      if (result.message) out(`OK: ${result.message}`);
    }

    return value;
  }
}

async function promptForStep(prompter: Prompter, step: SetupStep): Promise<string> {
  const label = step.label;
  if (step.type === 'password') {
    return await prompter.password(label);
  }
  if (step.type === 'number') {
    const example = step.example;
    const n = await prompter.number(label, example ? { example } : undefined);
    return String(n);
  }
  const opts: { example?: string } = {};
  if (step.example) opts.example = step.example;
  return await prompter.text(label, opts);
}
