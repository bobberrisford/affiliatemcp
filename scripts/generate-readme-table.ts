#!/usr/bin/env tsx
/**
 * README network-table generator.
 *
 * CLI: `npm run generate:readme` — updates the network table inside `README.md`
 * between two HTML-comment markers:
 *
 *   <!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
 *   ... generated table ...
 *   <!-- AFFILIATE_MCP_NETWORK_TABLE_END -->
 *
 * If the markers do not exist, the script appends them (and a generated table)
 * at the end of the README. Only the marked region is regenerated; the rest of
 * the file is left intact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORTED_OPERATIONS,
  approvalCell,
  loadReportData,
  notesSummary,
  supportedOperationCount,
  type ReportData,
} from './report-data.js';

export const TABLE_START_MARKER = '<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->';
export const TABLE_END_MARKER = '<!-- AFFILIATE_MCP_NETWORK_TABLE_END -->';

export const WANTED_START_MARKER = '<!-- AFFILIATE_MCP_WANTED_TABLE_START -->';
export const WANTED_END_MARKER = '<!-- AFFILIATE_MCP_WANTED_TABLE_END -->';

const REPO_SLUG = 'bobberrisford/affiliatemcp';

const OP_COUNT = REPORTED_OPERATIONS.length;

export interface WantedNetwork {
  name: string;
  slug: string;
  side: 'publisher' | 'advertiser' | 'both';
  note: string;
  issue: number | null;
}

export function renderReadmeTable(data: ReportData): string {
  const header = [
    '| Network | Setup time | Approval required | Supported ops | Notes |',
    '| --- | ---: | --- | ---: | --- |',
  ];
  const rows = data.networks.map((entry) => {
    const m = entry.manifest;
    const supported = supportedOperationCount(entry);
    return `| ${m.name} | ${m.setup_time_estimate_minutes} min | ${approvalCell(m)} | ${supported} / ${OP_COUNT} | ${notesSummary(entry)} |`;
  });
  return [...header, ...rows].join('\n');
}

/**
 * Replace (or insert) a marked block in the README content. Pure function;
 * the IO is at the CLI boundary. Shared by the network table and the wanted
 * list so both behave identically.
 */
function applyMarkedBlock(
  readmeContent: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const block = `${startMarker}\n${body}\n${endMarker}`;
  const hasStart = readmeContent.includes(startMarker);
  const hasEnd = readmeContent.includes(endMarker);

  if (hasStart && hasEnd) {
    const startIdx = readmeContent.indexOf(startMarker);
    const endIdx = readmeContent.indexOf(endMarker) + endMarker.length;
    return readmeContent.slice(0, startIdx) + block + readmeContent.slice(endIdx);
  }

  // Markers absent — append at end with a single trailing newline.
  const trimmed = readmeContent.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

export function applyReadmeTable(readmeContent: string, tableMarkdown: string): string {
  return applyMarkedBlock(readmeContent, TABLE_START_MARKER, TABLE_END_MARKER, tableMarkdown);
}

export function applyWantedTable(readmeContent: string, tableMarkdown: string): string {
  return applyMarkedBlock(readmeContent, WANTED_START_MARKER, WANTED_END_MARKER, tableMarkdown);
}

const SIDE_LABEL: Record<WantedNetwork['side'], string> = {
  publisher: 'publisher',
  advertiser: 'advertiser',
  both: 'publisher + advertiser',
};

function wantedIssueCell(entry: WantedNetwork): string {
  if (typeof entry.issue === 'number') {
    return `[#${entry.issue}](https://github.com/${REPO_SLUG}/issues/${entry.issue})`;
  }
  const url = `https://github.com/${REPO_SLUG}/issues/new?template=new-network-request.yml&title=${encodeURIComponent(
    `Add ${entry.name}`,
  )}`;
  return `[open one](${url})`;
}

export function renderWantedTable(entries: WantedNetwork[]): string {
  const header = [
    '| Network | Side wanted | Notes | Tracking issue |',
    '| --- | --- | --- | --- |',
  ];
  const rows = entries.map(
    (e) => `| ${e.name} | ${SIDE_LABEL[e.side]} | ${e.note} | ${wantedIssueCell(e)} |`,
  );
  return [...header, ...rows].join('\n');
}

export function loadWantedNetworks(repoRoot: string): WantedNetwork[] {
  const file = path.join(repoRoot, 'docs', 'wanted-networks.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { wanted?: WantedNetwork[] };
  return parsed.wanted ?? [];
}

async function runCli(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = loadReportData({ repoRoot });
  const tableMarkdown = renderReadmeTable(data);
  const wantedMarkdown = renderWantedTable(loadWantedNetworks(repoRoot));

  const readmePath = path.join(repoRoot, 'README.md');
  const existing = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const updated = applyWantedTable(applyReadmeTable(existing, tableMarkdown), wantedMarkdown);
  writeFileSync(readmePath, updated, 'utf8');
  process.stderr.write(`Updated ${readmePath} (network + wanted regions replaced).\n`);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('generate-readme-table.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`generate-readme-table fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
