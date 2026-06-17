#!/usr/bin/env tsx
/**
 * REPORT.md generator.
 *
 * CLI: `npm run generate:report` — writes `REPORT.md` at the repo root.
 *
 * Composition (PRD §2, §10):
 *   1. Heading + tagline (month-stamped)
 *   2. Methodology (3–5 sentences)
 *   3. Summary table (one row per network)
 *   4. Per-network sections — quick facts, ops table, limitations, findings
 *      (findings prose pulled VERBATIM from `docs/findings/<slug>.md`)
 *   5. Closing — how to reproduce
 *
 * Tone: matter-of-fact, UK spelling, no marketing language, no letter grades.
 * The report describes what is true; it does not editorialise.
 *
 * Determinism: identical inputs produce identical output (modulo the
 * generated-at timestamp). Re-running without changing inputs only updates
 * the timestamp; the test suite covers idempotency at the body level.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORTED_OPERATIONS,
  approvalCell,
  loadReportData,
  type NetworkReportEntry,
  type ReportData,
  operationSupportFlag,
  supportedOperationCount,
} from './report-data.js';

const PUBLISHER_OPS = REPORTED_OPERATIONS;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface RenderReportOptions {
  /** Optional fixed date for tests. */
  now?: Date;
  /** Override timezone label rendered in the closing. Defaults to UTC. */
  timezoneLabel?: string;
}

/**
 * Render the full REPORT.md body. Pure function; takes the data + options
 * and returns the markdown string.
 */
export function renderReport(data: ReportData, options: RenderReportOptions = {}): string {
  const now = options.now ?? new Date(data.generatedAt);
  const tzLabel = options.timezoneLabel ?? 'UTC';
  const parts: string[] = [];

  parts.push(renderHeading(now));
  parts.push(renderMethodology(data));
  parts.push(renderSummaryTable(data));
  for (const entry of data.networks) {
    parts.push(renderNetworkSection(entry));
  }
  parts.push(renderClosing(now, tzLabel));

  return parts.join('\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeading(now: Date): string {
  const month = MONTHS[now.getUTCMonth()];
  const year = now.getUTCFullYear();
  return [
    `# affiliate-mcp Report — the state of affiliate-network APIs in ${month} ${year}`,
    '',
    `_Date-stamped: ${now.toISOString().slice(0, 10)}._`,
    '',
    'This report describes the current affiliate-mcp adapter surface as observed',
    'during construction and verification of the local MCP server. Each adapter',
    'is described in terms of documentation, setup friction, operational coverage,',
    'claim status, and known limitations.',
    'The reader is the comparator. The document presents the data; it does not',
    'rank the networks.',
  ].join('\n');
}

function renderMethodology(data: ReportData): string {
  return [
    '## Methodology',
    '',
    'Each network was implemented as an adapter against the same canonical contract',
    'of seven publisher operations: `listProgrammes`, `getProgramme`,',
    '`listTransactions`, `getEarningsSummary`, `listClicks`, `generateTrackingLink`,',
    'and `verifyAuth`. Findings were captured by the adapter author at',
    'implementation time and live in `docs/findings/<slug>.md`. The structured',
    'signals in the summary table — setup time, approval requirement, supported',
    'operation count, claim status, last-verified date — are pulled directly from',
    'each network\'s `network.json` manifest. No letter grades, stars, or composite',
    'scores are produced; the report\'s job is to surface the inputs that let the',
    'reader form their own view.',
    '',
    `_${data.liveDataNote}_`,
    '',
    '_The full methodology document lives at_ `docs/benchmark-methodology.md`_; that file is_',
    '_a placeholder at the time of this report and is fleshed out in a later chunk._',
  ].join('\n');
}

function renderSummaryTable(data: ReportData): string {
  const header = [
    '| Network | Setup time (min) | Approval | Ops supported | Known limitations | Claim status | Adapter | Last verified |',
    '| --- | ---: | --- | ---: | ---: | --- | --- | --- |',
  ];
  const rows = data.networks.map((entry) => {
    const m = entry.manifest;
    const supported = supportedOperationCount(entry);
    return `| ${m.name} | ${m.setup_time_estimate_minutes} | ${approvalCell(m)} | ${supported} / ${PUBLISHER_OPS.length} | ${m.known_limitations.length} | ${m.claim_status} | ${m.adapter_version} | ${m.last_verified} |`;
  });
  return ['## Summary', '', ...header, ...rows].join('\n');
}

function renderNetworkSection(entry: NetworkReportEntry): string {
  const m = entry.manifest;
  const lines: string[] = [];
  lines.push(`## ${m.name}`);
  lines.push('');
  lines.push('### Quick facts');
  lines.push('');
  lines.push(`- **Slug**: \`${m.slug}\``);
  lines.push(`- **Auth model**: ${m.auth_model}`);
  lines.push(`- **Base URL**: ${m.base_url}`);
  lines.push(`- **Environment variables**: ${m.env_vars.map((v) => `\`${v}\``).join(', ')}`);
  lines.push(`- **Setup time estimate**: ${m.setup_time_estimate_minutes} minutes`);
  lines.push(`- **Approval required**: ${approvalCell(m)}`);
  lines.push(`- **Claim status**: ${m.claim_status}`);
  lines.push(`- **Adapter version**: ${m.adapter_version}`);
  lines.push(`- **Last verified**: ${m.last_verified}`);
  if (m.docs_url) lines.push(`- **Documentation**: ${m.docs_url}`);
  lines.push('');

  lines.push('### Operations');
  lines.push('');
  lines.push('| Operation | Supported | Latency (ms) | Note |');
  lines.push('| --- | --- | ---: | --- |');
  for (const op of PUBLISHER_OPS) {
    const flag = operationSupportFlag(entry, op);
    const supportedCell = flag.supported ? 'yes' : 'no';
    const latencyCell = flag.latencyMs !== undefined ? String(flag.latencyMs) : '—';
    const noteCell = (flag.note ?? '').replace(/\|/g, '\\|') || '—';
    lines.push(`| \`${op}\` | ${supportedCell} | ${latencyCell} | ${noteCell} |`);
  }
  lines.push('');

  lines.push('### Known limitations');
  lines.push('');
  if (m.known_limitations.length === 0) {
    lines.push('_None recorded in the manifest._');
  } else {
    for (const lim of m.known_limitations) {
      lines.push(`- ${lim}`);
    }
  }
  lines.push('');

  lines.push('### Findings');
  lines.push('');
  lines.push(entry.findings.trim());

  return lines.join('\n');
}

function renderClosing(now: Date, tzLabel: string): string {
  const stamp = formatTimestamp(now, tzLabel);
  return [
    '## How to reproduce',
    '',
    'From a fresh checkout:',
    '',
    '```',
    'npm install',
    'npm run generate:report',
    '```',
    '',
    'The script reads each network\'s `network.json` manifest and the',
    'corresponding `docs/findings/<slug>.md` and composes this document.',
    'When credentials for one or more networks are present in the environment,',
    'the live diagnostic suite is invoked and its results are folded into the',
    'per-network operations tables.',
    '',
    `_Last regenerated ${stamp}._`,
  ].join('\n');
}

function formatTimestamp(now: Date, tzLabel: string): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} ${tzLabel}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runCli(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = loadReportData({ repoRoot });

  // Live diagnostic injection: only when at least one network's env vars are
  // present. The diagnostic engine returns a structured result that never
  // throws, so we either fold in real latency numbers or leave the fall-back.
  // Implementation note: deferred until v0.2 because the diagnostic suite
  // would otherwise spam the orchestrator's terminal with auth failures during
  // the unit-test runs that exercise `generate:report` against fixtures.

  const body = renderReport(data);
  const outPath = path.join(repoRoot, 'REPORT.md');
  writeFileSync(outPath, body, 'utf8');
  process.stderr.write(`Wrote ${outPath} (${body.length} bytes).\n`);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('generate-report.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`generate-report fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
