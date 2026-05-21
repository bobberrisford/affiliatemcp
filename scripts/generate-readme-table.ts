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

const OP_COUNT = REPORTED_OPERATIONS.length;

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
 * Replace (or insert) the table block in the README content. Pure function;
 * the IO is at the CLI boundary.
 */
export function applyReadmeTable(readmeContent: string, tableMarkdown: string): string {
  const block = `${TABLE_START_MARKER}\n${tableMarkdown}\n${TABLE_END_MARKER}`;
  const hasStart = readmeContent.includes(TABLE_START_MARKER);
  const hasEnd = readmeContent.includes(TABLE_END_MARKER);

  if (hasStart && hasEnd) {
    const startIdx = readmeContent.indexOf(TABLE_START_MARKER);
    const endIdx = readmeContent.indexOf(TABLE_END_MARKER) + TABLE_END_MARKER.length;
    return readmeContent.slice(0, startIdx) + block + readmeContent.slice(endIdx);
  }

  // Markers absent — append at end with a single trailing newline.
  const trimmed = readmeContent.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

async function runCli(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = loadReportData({ repoRoot });
  const tableMarkdown = renderReadmeTable(data);

  const readmePath = path.join(repoRoot, 'README.md');
  const existing = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const updated = applyReadmeTable(existing, tableMarkdown);
  writeFileSync(readmePath, updated, 'utf8');
  process.stderr.write(`Updated ${readmePath} (table region replaced).\n`);
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
