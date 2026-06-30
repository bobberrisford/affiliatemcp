/**
 * `affiliate-networks-mcp update` — update awareness and application.
 *
 *   update              Apply an available update now (npm/npx surface), or
 *                       report the upgrade path on host-owned surfaces.
 *   update check        Report current-vs-latest without applying.
 *   update enable       Turn on silent auto-apply on launch (opt-in).
 *   update disable      Turn off silent auto-apply.
 *   update status       Show the auto-apply preference and current-vs-latest.
 *
 * User-facing text goes to stderr (stdout is reserved for the MCP transport when
 * the server runs); the exit code reflects the outcome so scripts can branch.
 */

import {
  applyUpdate,
  autoUpdateEnabled,
  checkForUpdate,
  formatUpdateNotice,
  setAutoUpdate,
  updateCheckEnabled,
  updateInstructionForSurface,
} from '../shared/update-check.js';

function write(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

/** Report current-vs-latest. Exit 0 when checked, 1 when it could not run. */
async function checkOnly(): Promise<number> {
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

/** Apply an available update now (explicit user action — bypasses the soak window). */
async function applyNow(): Promise<number> {
  if (!updateCheckEnabled()) {
    write('Update check is disabled (AFFILIATE_MCP_UPDATE_CHECK is off).');
    return 1;
  }
  const result = await applyUpdate({ force: true, ignoreSoak: true });
  switch (result.reason) {
    case 'applied':
      write(`Updated affiliate-networks-mcp ${result.current} → ${result.latest}. Restart to run the new version.`);
      return 0;
    case 'up_to_date':
      write(`affiliate-networks-mcp is up to date (${result.current}).`);
      return 0;
    case 'host_managed':
      write(
        `A newer version is available (${result.current} → ${result.latest}). ${updateInstructionForSurface(result.surface)}`,
      );
      return 0;
    case 'command_failed':
      write(`Update to ${result.latest} failed. ${result.detail ?? ''}`.trim());
      write(updateInstructionForSurface(result.surface));
      return 1;
    case 'unknown_latest':
    default:
      write('Could not determine the latest version (registry unreachable or offline).');
      return 1;
  }
}

async function showStatus(): Promise<number> {
  write(`Silent auto-apply is ${autoUpdateEnabled() ? 'enabled' : 'disabled'}.`);
  return await checkOnly();
}

export async function runUpdate(subcommand?: string): Promise<number> {
  switch (subcommand) {
    case 'check':
      return await checkOnly();
    case 'enable':
      setAutoUpdate(true);
      write('Silent auto-apply enabled. The server will update itself on launch when a newer release has soaked.');
      return 0;
    case 'disable':
      setAutoUpdate(false);
      write('Silent auto-apply disabled. The server will only notify you when an update is available.');
      return 0;
    case 'status':
      return await showStatus();
    case undefined:
      return await applyNow();
    default:
      write(`Unknown update subcommand: ${subcommand}`);
      write('Usage: affiliate-networks-mcp update [check|enable|disable|status]');
      return 2;
  }
}
