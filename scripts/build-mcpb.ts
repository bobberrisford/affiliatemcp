#!/usr/bin/env tsx
/**
 * Build the Claude Desktop MCP Bundle from the existing adapter/setup metadata.
 *
 * The bundle runs the complete server. Claude's flat extension-settings form
 * exposes the four launch networks with rich setup guidance; users of any
 * other adapter can keep using the shared ~/.affiliate-mcp/.env file until the
 * portable browser setup flow lands.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { setupSteps } from '../src/core/facade.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, '.artifacts', 'mcpb');
const SERVER_DIR = path.join(BUILD_DIR, 'server');
const OUTPUT_DIR = path.join(ROOT, '.artifacts');
const MCPB_CLI = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb',
);

export const MCPB_SETUP_NETWORKS = ['awin', 'cj', 'impact', 'partnerize'] as const;

interface PackageJson {
  version: string;
  description: string;
}

interface McpbUserConfig {
  type: 'string' | 'number' | 'boolean' | 'directory';
  title: string;
  description: string;
  sensitive?: boolean;
  required?: boolean;
}

interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  long_description: string;
  author: { name: string; url: string };
  repository: { type: string; url: string };
  homepage: string;
  documentation: string;
  support: string;
  icon: string;
  server: {
    type: 'node';
    entry_point: string;
    mcp_config: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
  tools_generated: boolean;
  prompts_generated: boolean;
  keywords: string[];
  license: string;
  privacy_policies: string[];
  compatibility: {
    platforms: string[];
    runtimes: { node: string };
  };
  user_config: Record<string, McpbUserConfig>;
}

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
}

function configKey(field: string): string {
  return field.toLowerCase();
}

function nativeTitle(title: string): string {
  return title.replace(/\s+\(auto-derived[^)]*\)/i, '');
}

function nativeDescription(network: string, title: string, description: string): string {
  if (!/auto-derived|normally (extracts|derives)/i.test(`${title} ${description}`)) {
    return description;
  }
  return (
    `Claude Desktop extension settings cannot auto-derive this value. Enter it when configuring ${network}. ` +
    description
  );
}

export function buildManifest(pkg: PackageJson = readPackage()): McpbManifest {
  const userConfig: Record<string, McpbUserConfig> = {
    anonymous_telemetry: {
      type: 'boolean',
      title: 'Share anonymous usage telemetry',
      description:
        'Optional and off by default. Sends once-daily counts by network, operation, coarse outcome, package version, and launch surface. Never sends credentials, affiliate data, prompts, arguments, results, or error text.',
      required: false,
    },
    existing_config_directory: {
      type: 'directory',
      title: 'Existing affiliate-mcp config directory',
      description:
        'Optional. Select the directory containing your existing .env file. Leave blank for ~/.affiliate-mcp.',
      required: false,
    },
  };
  const env: Record<string, string> = {
    AFFILIATE_MCP_CONFIG_DIR: '${user_config.existing_config_directory}',
    AFFILIATE_MCP_TELEMETRY: '${user_config.anonymous_telemetry}',
    AFFILIATE_MCP_SURFACE: 'mcpb',
  };

  for (const network of MCPB_SETUP_NETWORKS) {
    for (const step of setupSteps(network)) {
      const key = configKey(step.field);
      userConfig[key] = {
        type: step.type === 'number' ? 'number' : 'string',
        title: nativeTitle(step.label),
        description: nativeDescription(network, step.label, step.description),
        sensitive: step.type === 'password',
        required: false,
      };
      env[step.field] = `\${user_config.${key}}`;
    }
  }

  return {
    manifest_version: '0.3',
    name: 'affiliate-networks-mcp',
    display_name: 'Affiliate Networks',
    version: pkg.version,
    description: 'Bring affiliate-network data into Claude Desktop.',
    long_description:
      'A local-first MCP server for publisher and advertiser affiliate data. ' +
      'The extension runs locally, uses credentials you provide, and exposes the complete affiliate-mcp tool and prompt surface.',
    author: {
      name: 'affiliate-mcp contributors',
      url: 'https://github.com/bobberrisford/affiliatemcp',
    },
    repository: {
      type: 'git',
      url: 'https://github.com/bobberrisford/affiliatemcp.git',
    },
    homepage: 'https://github.com/bobberrisford/affiliatemcp',
    documentation: 'https://github.com/bobberrisford/affiliatemcp#readme',
    support: 'https://github.com/bobberrisford/affiliatemcp/issues',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server/index.cjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.cjs'],
        env,
      },
    },
    tools_generated: true,
    prompts_generated: true,
    keywords: ['affiliate', 'analytics', 'publisher', 'advertiser', 'local-first'],
    license: 'MIT',
    privacy_policies: ['https://github.com/bobberrisford/affiliatemcp/blob/main/PRIVACY.md'],
    compatibility: {
      platforms: ['darwin', 'win32'],
      runtimes: { node: '>=20.0.0' },
    },
    user_config: userConfig,
  };
}

export async function buildMcpb(): Promise<string> {
  const pkg = readPackage();
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(SERVER_DIR, { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, 'dist', 'mcpb-entry.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(SERVER_DIR, 'index.cjs'),
    sourcemap: false,
  });

  writeFileSync(
    path.join(BUILD_DIR, 'manifest.json'),
    `${JSON.stringify(buildManifest(pkg), null, 2)}\n`,
  );
  copyFileSync(path.join(ROOT, 'desktop', 'build', 'icon.png'), path.join(BUILD_DIR, 'icon.png'));
  copyFileSync(path.join(ROOT, 'mcpb', 'README.md'), path.join(BUILD_DIR, 'README.md'));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, `affiliate-networks-mcp-${pkg.version}.mcpb`);
  rmSync(output, { force: true });
  execFileSync(MCPB_CLI, ['validate', BUILD_DIR], { stdio: 'inherit' });
  execFileSync(MCPB_CLI, ['pack', BUILD_DIR, output], { stdio: 'inherit' });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildMcpb();
  process.stdout.write(`MCPB written to ${path.relative(ROOT, output)}\n`);
}
