import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getCredential,
  isFirstRun,
  isPlaceholderCredential,
  parseEnvFile,
  resolveConfigEnvFile,
  setupInstructionForSurface,
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

describe('placeholder / example credential recognition', () => {
  const NAME = 'TEST_PLACEHOLDER_CREDENTIAL';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('recognises an unresolved Claude Desktop bundle placeholder', () => {
    expect(isPlaceholderCredential('${user_config.awin_api_token}')).toBe(true);
    expect(isPlaceholderCredential('${user_config.awin_publisher_id}')).toBe(true);
  });

  it('recognises an unedited example sentinel in either separator style', () => {
    expect(isPlaceholderCredential('your-token-here')).toBe(true);
    expect(isPlaceholderCredential('your-id-here')).toBe(true);
    expect(isPlaceholderCredential('YOUR-PUBLISHER-ID-HERE')).toBe(true);
    // Underscore-style sentinels also appear in the network docs.
    expect(isPlaceholderCredential('your_secret_key_here')).toBe(true);
    expect(isPlaceholderCredential('your_bearer_token_here')).toBe(true);
  });

  it('treats real-looking values as configured', () => {
    expect(isPlaceholderCredential('abc123-def456')).toBe(false);
    expect(isPlaceholderCredential('123456')).toBe(false);
    // A real token that merely contains the word "your" is not a sentinel.
    expect(isPlaceholderCredential('your_actual_token_value')).toBe(false);
  });

  it('getCredential returns undefined for a placeholder value', () => {
    process.env[NAME] = '${user_config.awin_api_token}';
    expect(getCredential(NAME)).toBeUndefined();
  });

  it('getCredential returns undefined for an example sentinel', () => {
    process.env[NAME] = 'your-token-here';
    expect(getCredential(NAME)).toBeUndefined();
  });

  it('getCredential returns the value for a real credential', () => {
    process.env[NAME] = 'a-real-token';
    expect(getCredential(NAME)).toBe('a-real-token');
  });
});

describe('setupInstructionForSurface', () => {
  it('points Desktop bundle users at the extension settings', () => {
    const hint = setupInstructionForSurface('AWIN_API_TOKEN', 'mcpb');
    expect(hint).toContain('Extensions');
    expect(hint).toContain('AWIN_API_TOKEN');
    expect(hint).not.toContain('affiliate-networks-mcp setup');
  });

  it('points npm/CLI users at the setup wizard', () => {
    const hint = setupInstructionForSurface('AWIN_API_TOKEN', 'npm');
    expect(hint).toContain('affiliate-networks-mcp setup');
    expect(hint).toContain('AWIN_API_TOKEN');
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
