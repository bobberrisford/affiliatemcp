/**
 * Atomic JSON write + timestamped backup helpers.
 *
 * Used by the Claude Desktop installer to edit `claude_desktop_config.json`
 * without ever leaving the user's file half-written. The user's config may
 * have other MCP servers in it, so a torn write would be a real bug.
 *
 * Convention: write to a sibling tempfile, then `renameSync` over the target.
 * `rename` is atomic on POSIX and on Windows when the destination exists,
 * which is the only case that matters here.
 */

import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function atomicWriteJSON(targetPath: string, value: unknown): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `${base}.tmp.${process.pid}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, body, { encoding: 'utf8' });
  renameSync(tmp, targetPath);
}

/**
 * Copy the file at `targetPath` to a sibling named
 * `<base>.bak.<YYYYMMDD-HHMMSS>` and return the backup path. Caller is
 * responsible for verifying that `targetPath` exists; we don't pretend it
 * does and create an empty backup.
 */
export function timestampedBackup(targetPath: string, now: Date = new Date()): string {
  if (!existsSync(targetPath)) {
    throw new Error(`Cannot back up ${targetPath}: file does not exist.`);
  }
  const stamp = formatStamp(now);
  const backupPath = `${targetPath}.bak.${stamp}`;
  copyFileSync(targetPath, backupPath);
  return backupPath;
}

function formatStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
