/**
 * package.json + brand-name acceptance tests.
 *
 * The npm name `affiliate-mcp` is owned by an unrelated publisher. We publish
 * under `affiliate-networks-mcp` so `npx affiliate-networks-mcp setup` works.
 * These tests pin that contract so a future rename or quick-start typo cannot
 * land silently.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples');

interface PackageJson {
  name: string;
  version?: string;
  bin?: Record<string, string> | string;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageJson;
}

describe('package.json brand surface', () => {
  it('name is `affiliate-networks-mcp`', () => {
    const pkg = readPackageJson();
    expect(pkg.name).toBe('affiliate-networks-mcp');
  });

  it('bin map has an `affiliate-networks-mcp` entry', () => {
    const pkg = readPackageJson();
    expect(pkg.bin).toBeTypeOf('object');
    expect(pkg.bin && Object.keys(pkg.bin)).toContain('affiliate-networks-mcp');
  });

  it('does NOT expose a legacy `affiliate-mcp` bin (it would shadow HLOS)', () => {
    const pkg = readPackageJson();
    if (pkg.bin && typeof pkg.bin === 'object') {
      expect(Object.keys(pkg.bin)).not.toContain('affiliate-mcp');
    }
  });

  it('keeps the telemetry package version aligned with package.json', async () => {
    const pkg = readPackageJson();
    const { PACKAGE_VERSION } = await import('../../src/shared/telemetry.js');
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe('README quick-start brand', () => {
  it('does not contain the squatted `npx affiliate-mcp` invocation', () => {
    const body = readFileSync(README_PATH, 'utf8');
    expect(body).not.toMatch(/\bnpx affiliate-mcp\b/);
  });

  it('does not contain the squatted `npm install -g affiliate-mcp`', () => {
    const body = readFileSync(README_PATH, 'utf8');
    expect(body).not.toMatch(/\bnpm install -g affiliate-mcp\b/);
  });
});

describe('examples/*.json reference the brand-visible bin', () => {
  it('every example JSON file uses `affiliate-networks-mcp`, not `affiliate-mcp`, as the npx target', () => {
    const entries = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const full = path.join(EXAMPLES_DIR, entry);
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, 'utf8');
      // Walk top-level mcpServers and check each "args" array for the binary name.
      const parsed = JSON.parse(body) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      const servers = parsed.mcpServers ?? {};
      for (const [serverKey, server] of Object.entries(servers)) {
        const args = server.args ?? [];
        // If invoked via npx, the first arg is the package name.
        if (server.command === 'npx' && args.length > 0) {
          expect(
            args[0],
            `${entry}#mcpServers.${serverKey}.args[0] should be the brand-visible npm name`,
          ).toBe('affiliate-networks-mcp');
          expect(args[0]).not.toBe('affiliate-mcp');
        }
      }
    }
  });
});
