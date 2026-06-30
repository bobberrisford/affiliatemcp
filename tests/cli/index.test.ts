import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { shouldShowFirstRunBanner } from '../../src/cli/first-run.js';

const tsxBin = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

describe('first-run banner decision', () => {
  it('shows the banner only on an interactive first run', () => {
    expect(shouldShowFirstRunBanner({ firstRun: true, interactive: true })).toBe(true);
    expect(shouldShowFirstRunBanner({ firstRun: true, interactive: false })).toBe(false);
    expect(shouldShowFirstRunBanner({ firstRun: false, interactive: true })).toBe(false);
    expect(shouldShowFirstRunBanner({ firstRun: false, interactive: false })).toBe(false);
  });
});

describe('bare CLI launched by a client (non-TTY) when unconfigured', () => {
  it('starts the MCP server and answers initialize instead of exiting', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'amcp-index-'));

    // spawn() gives the child piped stdio, so process.stdin.isTTY is falsy —
    // the same shape an MCP client produces over stdio.
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, AFFILIATE_MCP_CONFIG_DIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    };

    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no initialize response within 20s')),
          20_000,
        );
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              clearTimeout(timer);
              resolve(parsed);
              return;
            } catch {
              // Partial / non-JSON line; keep reading.
            }
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited early with code ${code ?? 'null'}`));
        });
        child.stdin.write(`${JSON.stringify(initialize)}\n`);
      });

      const result = response['result'] as { serverInfo?: { name?: string } } | undefined;
      expect(result?.serverInfo?.name).toBe('affiliate-mcp');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});
