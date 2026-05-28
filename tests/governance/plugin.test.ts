/**
 * Plugin / marketplace manifest acceptance tests.
 *
 * This repo doubles as a single-plugin Claude Code marketplace
 * (`/plugin marketplace add bobberrisford/affiliatemcp`). The two manifests
 * under `.claude-plugin/` are part of the user-visible install surface, so
 * we pin their contract here.
 *
 * Skills are auto-discovered from `skills/` by plugin.json, so we also
 * assert each subdirectory is well-formed.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_JSON_PATH = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const MARKETPLACE_JSON_PATH = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

interface PluginJson {
  name?: string;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

interface MarketplaceJson {
  name?: string;
  plugins?: Array<{ name?: string; source?: string }>;
}

describe('.claude-plugin/plugin.json', () => {
  it('exists and parses as JSON', () => {
    expect(existsSync(PLUGIN_JSON_PATH)).toBe(true);
    const body = readFileSync(PLUGIN_JSON_PATH, 'utf8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('declares the `affiliate-networks-mcp` plugin name', () => {
    const pkg = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8')) as PluginJson;
    expect(pkg.name).toBe('affiliate-networks-mcp');
  });

  it('registers an `affiliate` MCP server that invokes the published bin', () => {
    const pkg = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8')) as PluginJson;
    const server = pkg.mcpServers?.affiliate;
    expect(server).toBeDefined();
    expect(server?.command).toBe('npx');
    // Args may include flags like `-y` ahead of the package name; the package
    // name must appear somewhere in the args array.
    expect(server?.args).toContain('affiliate-networks-mcp');
  });
});

describe('.claude-plugin/marketplace.json', () => {
  it('exists and parses as JSON', () => {
    expect(existsSync(MARKETPLACE_JSON_PATH)).toBe(true);
    const body = readFileSync(MARKETPLACE_JSON_PATH, 'utf8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('lists the `affiliate-networks-mcp` plugin', () => {
    const market = JSON.parse(readFileSync(MARKETPLACE_JSON_PATH, 'utf8')) as MarketplaceJson;
    expect(market.plugins).toBeDefined();
    const names = (market.plugins ?? []).map((p) => p.name);
    expect(names).toContain('affiliate-networks-mcp');
  });
});

describe('skills/ layout', () => {
  it('every subdirectory contains a SKILL.md', () => {
    const entries = readdirSync(SKILLS_DIR);
    const skillDirs = entries.filter((entry) => {
      const full = path.join(SKILLS_DIR, entry);
      return statSync(full).isDirectory();
    });
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const dir of skillDirs) {
      const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');
      expect(existsSync(skillMd), `skills/${dir}/SKILL.md should exist`).toBe(true);
    }
  });
});
