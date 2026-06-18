import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('CLI first-run banner', () => {
  it('prints the active AFFILIATE_MCP_CONFIG_DIR .env path', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'amcp-index-'));
    const tsxBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const result = spawnSync(tsxBin, ['src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AFFILIATE_MCP_CONFIG_DIR: tmp,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`No config file at ${path.join(tmp, '.env')}.`);
  });
});
