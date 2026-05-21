#!/usr/bin/env tsx
/**
 * REPORT.md summary-table → PNG renderer.
 *
 * CLI: `npm run generate:report-image` — renders the summary table from the
 * current `network.json` manifests into `docs/images/report-table.png` via
 * Playwright (PRD Appendix A — the chosen tool for image generation).
 *
 * If Playwright is not installed, the script exits non-zero with a clear
 * message rather than silently no-opping or fabricating an image. The HTML
 * composition is a pure function and is exercised in the test suite; the
 * Playwright rasterisation step is the only piece that can fail at runtime.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORTED_OPERATIONS,
  approvalCell,
  loadReportData,
  supportedOperationCount,
  type ReportData,
} from './report-data.js';

const OP_COUNT = REPORTED_OPERATIONS.length;
const PAGE_WIDTH = 1200;

/**
 * Pure HTML composition. Returns the full HTML document a headless browser
 * would rasterise. Style: minimal, system font, light background.
 */
export function renderReportTableHtml(data: ReportData): string {
  const rows = data.networks
    .map((entry) => {
      const m = entry.manifest;
      const supported = supportedOperationCount(entry);
      return `<tr>
        <td>${escapeHtml(m.name)}</td>
        <td class="num">${m.setup_time_estimate_minutes} min</td>
        <td>${escapeHtml(approvalCell(m))}</td>
        <td class="num">${supported} / ${OP_COUNT}</td>
        <td class="num">${m.known_limitations.length}</td>
        <td>${escapeHtml(m.claim_status)}</td>
        <td>${escapeHtml(m.adapter_version)}</td>
        <td>${escapeHtml(m.last_verified)}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>affiliate-mcp Report — Summary</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #111111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .page {
    width: ${PAGE_WIDTH}px;
    padding: 48px 40px;
    box-sizing: border-box;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 8px 0;
    font-weight: 600;
  }
  p.sub {
    margin: 0 0 24px 0;
    font-size: 13px;
    color: #555555;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 14px;
  }
  th, td {
    border-bottom: 1px solid #e5e5e5;
    padding: 10px 12px;
    text-align: left;
    vertical-align: middle;
  }
  th {
    background: #f7f7f7;
    font-weight: 600;
    color: #222222;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td.num, th.num { text-align: right; }
  tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
<div class="page">
  <h1>affiliate-mcp — network summary</h1>
  <p class="sub">Generated ${escapeHtml(data.generatedAt)}. Static data from each network.json; see REPORT.md for findings.</p>
  <table>
    <thead>
      <tr>
        <th>Network</th>
        <th class="num">Setup (min)</th>
        <th>Approval</th>
        <th class="num">Ops supported</th>
        <th class="num">Limitations</th>
        <th>Claim status</th>
        <th>Adapter</th>
        <th>Last verified</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CLI — Playwright rasterisation
// ---------------------------------------------------------------------------

async function runCli(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = loadReportData({ repoRoot });
  const html = renderReportTableHtml(data);

  const outDir = path.join(repoRoot, 'docs', 'images');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'report-table.png');

  // Dynamic import so the script doesn't hard-require Playwright at parse time.
  // Playwright is intentionally not a declared dependency at v0.1 because its
  // browser-binary download is heavyweight; install it explicitly when you
  // want to regenerate the report image. The dynamic import is typed loosely
  // on purpose — adding type-only deps for an optional install would defeat
  // the point.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pw: any = await import('playwright' as string).catch(() => null);
    if (!pw) throw new Error('playwright module not found');
    chromium = pw.chromium;
  } catch {
    process.stderr.write(
      'generate-report-image: Playwright is not installed.\n' +
        '  Install it with: npm install --save-dev playwright\n' +
        '  Then install the browsers: npx playwright install chromium\n' +
        '  Skipping image generation — REPORT.md and README.md are unaffected.\n',
    );
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: PAGE_WIDTH, height: 800 } });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const tableHandle = await page.locator('.page');
    await tableHandle.screenshot({ path: outPath, type: 'png' });
    process.stderr.write(`Wrote ${outPath}.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`generate-report-image: rasterisation failed — ${(err as Error).message}\n`);
    // Write the HTML alongside as a debugging aid.
    const htmlPath = path.join(outDir, 'report-table.html');
    writeFileSync(htmlPath, html, 'utf8');
    process.stderr.write(`  HTML written to ${htmlPath} for inspection.\n`);
    return 2;
  } finally {
    if (browser) await browser.close();
  }
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('generate-report-image.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`generate-report-image fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
