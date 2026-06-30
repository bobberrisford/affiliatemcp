/**
 * `affiliate-networks-mcp update` — update awareness from the terminal.
 *
 * In this first cut the command reports whether a newer release exists and how
 * to upgrade for the detected surface. Opt-in automatic application lands in a
 * follow-up. User-facing text goes to stderr (stdout is reserved for the MCP
 * transport when the server runs); the exit code reflects the outcome so
 * scripts can branch on it.
 */

import { checkForUpdate, formatUpdateNotice, updateCheckEnabled } from '../shared/update-check.js';

function write(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

export interface UpdateOptions {
  /** Reserved for parity with other commands; the first cut only checks. */
  check?: boolean;
}

/**
 * Returns 0 when up to date or an update is reported, 1 when the check could not
 * run (disabled or registry unreachable), so a CI/script caller can tell the
 * difference between "checked" and "could not check".
 */
export async function runUpdate(_opts: UpdateOptions = {}): Promise<number> {
  if (!updateCheckEnabled()) {
    write('Update check is disabled (AFFILIATE_MCP_UPDATE_CHECK is off).');
    return 1;
  }

  const info = await checkForUpdate({ force: true });
  if (!info) {
    write('Could not determine the latest version (registry unreachable or offline).');
    return 1;
  }

  if (info.updateAvailable) {
    write(formatUpdateNotice(info));
  } else {
    write(`affiliate-networks-mcp is up to date (${info.current}).`);
  }
  return 0;
}
