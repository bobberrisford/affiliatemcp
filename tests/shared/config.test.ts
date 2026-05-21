import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isFirstRun,
  parseEnvFile,
  resolveConfigEnvFile,
} from '../../src/shared/config.js';

describe('config parser', () => {
  it('parses KEY=value pairs', () => {
    const out = parseEnvFile('FOO=bar\nBAZ=qux');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    const out = parseEnvFile('# a comment\n\nFOO=bar\n# trailing');
    expect(out).toEqual({ FOO: 'bar' });
  });

  it('strips matched single and double quotes', () => {
    const out = parseEnvFile(`A="hello"\nB='world'\nC=plain`);
    expect(out).toEqual({ A: 'hello', B: 'world', C: 'plain' });
  });
});

describe('AFFILIATE_MCP_CONFIG_DIR override (PRD §15.18, Polish Chunk 10)', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-config-'));
    originalEnv = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    } else {
      process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolveConfigEnvFile honours the override', () => {
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmpDir;
    expect(resolveConfigEnvFile()).toBe(path.join(tmpDir, '.env'));
  });

  it('isFirstRun honours the override and returns true when the file is absent', () => {
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmpDir;
    expect(isFirstRun()).toBe(true);
  });

  it('isFirstRun returns false once the override directory contains a .env', () => {
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmpDir;
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\n', { mode: 0o600 });
    expect(isFirstRun()).toBe(false);
  });
});
