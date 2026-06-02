/**
 * `affiliate-networks-mcp consent` — manage doing-layer consent grants.
 *
 * Three actions:
 *   consent grant   --subject <slug|self> --network <slug|*> --action <domain.verb>
 *                   [--mode standing|deny] [--max-per-day N] [--expires <ISO>]
 *                   [--max-magnitude N] [--note <text>]
 *   consent revoke  --subject <slug|self> --network <slug|*> --action <domain.verb>
 *   consent list    [--subject <slug>]
 *
 * Output: human-readable text to stdout. Logging goes to stderr via pino.
 * See docs/product/doing-layer.md.
 */

import { createLogger } from '../shared/logging.js';
import {
  grantConsent,
  isValidActionClass,
  listGrants,
  revokeConsent,
  type ConsentBounds,
  type ConsentGrant,
  type ConsentMode,
} from '../shared/consent.js';
import { isValidBrandSlug } from '../shared/brands.js';

const log = createLogger('consent-cli');

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ConsentCommandOptions {
  action: 'grant' | 'revoke' | 'list';
  /** Brand slug or `'self'`. Required for grant and revoke. */
  subject?: string;
  /** Network slug or `'*'`. Required for grant and revoke. */
  network?: string;
  /** Action class (domain.verb). Required for grant and revoke. */
  actionClass?: string;
  /** `standing` (default) or `deny`. Used by grant. */
  mode?: ConsentMode;
  /** Maximum applied actions per UTC calendar day. Used by grant. */
  maxPerDay?: number;
  /** ISO 8601 expiry datetime. Used by grant. */
  expires?: string;
  /** Maximum magnitude. Used by grant. */
  maxMagnitude?: number;
  /** Free-text note. Used by grant. */
  note?: string;
}

/**
 * Run the consent subcommand. Returns an exit code: 0 on success, 1 on error,
 * 2 on bad arguments.
 */
export async function runConsent(opts: ConsentCommandOptions): Promise<number> {
  log.debug({ action: opts.action }, 'consent command');

  switch (opts.action) {
    case 'grant':
      return runGrant(opts);
    case 'revoke':
      return runRevoke(opts);
    case 'list':
      return runList(opts);
  }
}

// ---------------------------------------------------------------------------
// Parse CLI argv into ConsentCommandOptions
// ---------------------------------------------------------------------------

/**
 * Parse the argument list for the consent subcommand. The first element is the
 * action (`grant`, `revoke`, `list`).
 */
export function parseConsentArgs(args: string[]): ConsentCommandOptions {
  const [action, ...rest] = args;

  if (action !== 'grant' && action !== 'revoke' && action !== 'list') {
    throw new Error(`Unknown consent action "${action ?? ''}". Expected: grant, revoke, list.`);
  }

  const opts: ConsentCommandOptions = { action };

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = rest[i + 1];

    switch (flag) {
      case '--subject':
        opts.subject = requireValue(flag, next);
        i++;
        break;
      case '--network':
        opts.network = requireValue(flag, next);
        i++;
        break;
      case '--action':
        opts.actionClass = requireValue(flag, next);
        i++;
        break;
      case '--mode': {
        const m = requireValue(flag, next);
        if (m !== 'standing' && m !== 'deny') {
          throw new Error(`--mode must be "standing" or "deny", got "${m}".`);
        }
        opts.mode = m;
        i++;
        break;
      }
      case '--max-per-day': {
        const n = parseInt(requireValue(flag, next), 10);
        if (isNaN(n) || n < 1) throw new Error('--max-per-day must be a positive integer.');
        opts.maxPerDay = n;
        i++;
        break;
      }
      case '--expires':
        opts.expires = requireValue(flag, next);
        i++;
        break;
      case '--max-magnitude': {
        const n = Number(requireValue(flag, next));
        if (isNaN(n) || n < 0) throw new Error('--max-magnitude must be a non-negative number.');
        opts.maxMagnitude = n;
        i++;
        break;
      }
      case '--note':
        opts.note = requireValue(flag, next);
        i++;
        break;
      default:
        throw new Error(`Unknown flag "${flag ?? ''}".`);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function runGrant(opts: ConsentCommandOptions): number {
  const { subject, network, actionClass } = opts;

  if (!subject) return argError('--subject is required for grant.');
  if (!network) return argError('--network is required for grant.');
  if (!actionClass) return argError('--action is required for grant.');

  if (subject !== 'self' && !isValidBrandSlug(subject)) {
    return argError(
      `Invalid subject "${subject}". Use a brand slug (lowercase letters, digits, hyphens) or "self".`,
    );
  }
  if (network !== '*' && !isValidBrandSlug(network)) {
    return argError(`Invalid network "${network}". Use a network slug or "*".`);
  }
  if (!isValidActionClass(actionClass)) {
    return argError(
      `Invalid action class "${actionClass}". Expected format: domain.verb (e.g. publisher.approve).`,
    );
  }
  if (opts.expires !== undefined && isNaN(new Date(opts.expires).getTime())) {
    return argError(`Invalid --expires value "${opts.expires}". Expected an ISO 8601 datetime.`);
  }

  // Bounds nest under `bounds` in the consent model; the CLI flags are flat.
  const bounds: ConsentBounds = {};
  if (opts.maxPerDay !== undefined) bounds.maxPerDay = opts.maxPerDay;
  if (opts.expires !== undefined) bounds.expiresAt = opts.expires;
  if (opts.maxMagnitude !== undefined) bounds.maxMagnitude = opts.maxMagnitude;

  const grant: ConsentGrant = {
    subject,
    network,
    actionClass,
    mode: opts.mode ?? 'standing',
    ...(Object.keys(bounds).length > 0 && { bounds }),
    ...(opts.note !== undefined && { note: opts.note }),
  };

  try {
    grantConsent(grant);
  } catch (err) {
    process.stderr.write(`consent grant failed: ${(err as Error).message}\n`);
    return 1;
  }

  out(
    `Consent ${grant.mode} grant recorded: subject="${subject}" network="${network}" action="${actionClass}".`,
  );
  return 0;
}

function runRevoke(opts: ConsentCommandOptions): number {
  const { subject, network, actionClass } = opts;

  if (!subject) return argError('--subject is required for revoke.');
  if (!network) return argError('--network is required for revoke.');
  if (!actionClass) return argError('--action is required for revoke.');

  let removed: number;
  try {
    removed = revokeConsent(subject, network, actionClass);
  } catch (err) {
    process.stderr.write(`consent revoke failed: ${(err as Error).message}\n`);
    return 1;
  }

  if (removed === 0) {
    out(
      `No matching consent grant found for subject="${subject}" network="${network}" action="${actionClass}".`,
    );
  } else {
    out(`Removed ${removed} consent grant${removed === 1 ? '' : 's'}.`);
  }
  return 0;
}

function runList(opts: ConsentCommandOptions): number {
  let grants: ConsentGrant[];
  try {
    grants = listGrants(opts.subject ? { subject: opts.subject } : {});
  } catch (err) {
    process.stderr.write(`consent list failed: ${(err as Error).message}\n`);
    return 1;
  }

  if (grants.length === 0) {
    out('No consent grants recorded.');
    return 0;
  }

  out(`${'Subject'.padEnd(16)}  ${'Network'.padEnd(16)}  ${'Action'.padEnd(24)}  ${'Mode'.padEnd(8)}  Extras`);
  out('-'.repeat(90));
  for (const g of grants) {
    const extras: string[] = [];
    if (g.bounds?.expiresAt) extras.push(`expires=${g.bounds.expiresAt}`);
    if (g.bounds?.maxPerDay !== undefined) extras.push(`max-per-day=${g.bounds.maxPerDay}`);
    if (g.bounds?.maxMagnitude !== undefined) extras.push(`max-magnitude=${g.bounds.maxMagnitude}`);
    if (g.note) extras.push(`note=${g.note}`);
    out(
      `${g.subject.padEnd(16)}  ${g.network.padEnd(16)}  ${g.actionClass.padEnd(24)}  ${g.mode.padEnd(8)}  ${extras.join(', ')}`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function argError(msg: string): number {
  process.stderr.write(`${msg}\n`);
  return 2;
}
