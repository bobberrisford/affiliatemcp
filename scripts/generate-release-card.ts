#!/usr/bin/env tsx
/**
 * Release → LinkedIn "release card" PNG + post copy generator.
 *
 * CLI: `npm run generate:release-card` — renders a branded 1200×627 PNG
 * (LinkedIn's optimal single-image ratio) for the current release into
 * `docs/images/release-card.png`, and writes ready-to-paste LinkedIn post copy
 * to `docs/images/release-post.txt`.
 *
 * Why a native image + first-comment link, and not just a pasted release URL:
 * LinkedIn's feed ranking demotes posts that carry an external link in the
 * body (it wants to keep readers on-platform), and a pasted GitHub release URL
 * only ever surfaces the repo's generic social-preview image. A natively
 * uploaded, release-specific card stops the scroll and ranks better; the
 * convention is to drop the link in the first comment instead.
 *
 * Card content (per the engagement brief):
 *   - audience hook   — the publisher/brand value prop, not just a changelog
 *   - version         — the vX.Y.Z being announced
 *   - key changes     — 2–4 headline bullets from the release notes
 *   - network count   — concrete, growing coverage figure (both sides)
 *   - new-network spotlight — when a release adds adapters, name them
 *
 * Mirrors `scripts/generate-report-image.ts`: the HTML composition and post
 * copy are pure functions exercised by the test suite, and Playwright is an
 * optional, dynamically-imported dependency so the script fails loudly (rather
 * than fabricating an image) when it is not installed.
 *
 * Usage:
 *   npm run generate:release-card -- \
 *     --version v0.3.0 \
 *     --change "Added the Rakuten advertiser adapter" \
 *     --change "Faster transaction pagination" \
 *     --new-network "Rakuten (brand side)" \
 *     [--notes path/to/release-notes.md] \
 *     [--out docs/images/release-card.png]
 *
 * `--notes` parses markdown bullet lines into headline changes (GitHub
 * auto-generated notes work too — PR/author noise is stripped). Explicit
 * `--change` flags take precedence over a notes file. With neither, the card
 * falls back to a single generic "what's new" line so it is still buildable.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReportData, type ReportData } from './report-data.js';

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 627; // LinkedIn single-image optimum (1.91:1)
const MAX_CHANGES = 4;
const REPO_URL = 'https://github.com/bobberrisford/affiliatemcp';

/** Resolved data the card and post copy are rendered from. */
export interface ReleaseCardData {
  /** Normalised version label, always prefixed with `v` (e.g. `v0.3.0`). */
  version: string;
  /** Audience-first hook headline. */
  hook: string;
  /** 2–4 short headline changes. */
  changes: string[];
  /** Total network adapters available. */
  networkCount: number;
  /** True when adapters exist on both the publisher and brand sides. */
  bothSides: boolean;
  /** Networks newly added in this release, for the spotlight chip. */
  newNetworks: string[];
}

export interface BuildReleaseCardOptions {
  /** Absolute path to the repo root. Defaults to one level above this script. */
  repoRoot?: string;
  /** Override the version; defaults to the repo `package.json` version. */
  version?: string;
  /** Explicit headline changes. Takes precedence over `notes`. */
  changes?: string[];
  /** Raw markdown release notes to extract bullet headlines from. */
  notes?: string;
  /** Networks newly added in this release (spotlight). */
  newNetworks?: string[];
}

// ---------------------------------------------------------------------------
// Data assembly (pure)
// ---------------------------------------------------------------------------

/** Normalise a version string to a single leading `v`. */
export function normaliseVersion(raw: string): string {
  const trimmed = raw.trim().replace(/^v+/i, '');
  return `v${trimmed}`;
}

/**
 * Pull short headline changes out of markdown release notes. Handles GitHub
 * auto-generated notes: keeps `-`/`*` bullet lines, drops the
 * "by @author in #123" trailer and bare commit/PR links, and skips the
 * boilerplate "Full Changelog" / "New Contributors" lines.
 */
export function extractChangeHeadlines(notes: string, max = MAX_CHANGES): string[] {
  const out: string[] = [];
  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    let text = (bullet[1] ?? '').trim();
    if (/full changelog|new contributors/i.test(text)) continue;
    // Drop "by @author in https://.../pull/123" trailers.
    text = text.replace(/\s+by\s+@[\w-]+\s+in\s+\S+$/i, '');
    // Drop trailing "(#123)" PR references and bare links.
    text = text.replace(/\s*\(#\d+\)\s*$/i, '').replace(/\s+#\d+$/i, '');
    // Strip inline markdown link syntax, keeping the label.
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    text = text.replace(/[*_`]/g, '').trim();
    if (text.length === 0) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function readPackageVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

/**
 * Build the release-card data from the repo's manifests + the supplied
 * release metadata. Network coverage is read live from `network.json`
 * manifests so the figure never drifts from reality.
 */
export function buildReleaseCardData(options: BuildReleaseCardOptions = {}): ReleaseCardData {
  const repoRoot =
    options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const report: ReportData = loadReportData({ repoRoot });
  const networkCount = report.networks.length;
  const sides = new Set(report.networks.map((n) => n.manifest.side));
  const bothSides = sides.has('publisher') && sides.has('advertiser');

  const version = normaliseVersion(options.version ?? readPackageVersion(repoRoot));

  let changes = (options.changes ?? []).map((c) => c.trim()).filter(Boolean);
  if (changes.length === 0 && options.notes) {
    changes = extractChangeHeadlines(options.notes);
  }
  if (changes.length === 0) {
    changes = ['Latest fixes and adapter updates across the supported networks.'];
  }
  changes = changes.slice(0, MAX_CHANGES);

  const newNetworks = (options.newNetworks ?? []).map((n) => n.trim()).filter(Boolean);

  const hook = 'Chat to your affiliate data with Claude.';

  return { version, hook, changes, networkCount, bothSides, newNetworks };
}

// ---------------------------------------------------------------------------
// HTML composition (pure)
// ---------------------------------------------------------------------------

/**
 * Pure HTML composition for the release card. Returns the full HTML document a
 * headless browser rasterises at CARD_WIDTH × CARD_HEIGHT. Dark, branded,
 * high-contrast — built to stop the scroll in a LinkedIn feed.
 */
export function renderReleaseCardHtml(data: ReleaseCardData): string {
  const coverage = data.bothSides
    ? `${data.networkCount} networks · publisher + brand side`
    : `${data.networkCount} networks`;

  const changeItems = data.changes
    .map((c) => `      <li>${escapeHtml(c)}</li>`)
    .join('\n');

  const spotlight =
    data.newNetworks.length > 0
      ? `  <div class="spotlight">
    <span class="spotlight-label">New</span>
    <span class="spotlight-names">${escapeHtml(data.newNetworks.join(' · '))}</span>
  </div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>affiliate-mcp ${escapeHtml(data.version)} — release</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    box-sizing: border-box;
    padding: 64px 72px;
    background: radial-gradient(120% 120% at 0% 0%, #1d2a4d 0%, #0b1020 55%, #070a14 100%);
    color: #f5f7fb;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    overflow: hidden;
  }
  .accent {
    position: absolute;
    right: -120px;
    top: -120px;
    width: 360px;
    height: 360px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 50%, rgba(99,140,255,0.35), rgba(99,140,255,0) 70%);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 1;
  }
  .brand {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #c7d2fe;
  }
  .version {
    font-size: 22px;
    font-weight: 700;
    padding: 8px 18px;
    border: 1px solid rgba(199,210,254,0.4);
    border-radius: 999px;
    color: #e8edff;
  }
  .body { z-index: 1; }
  .hook {
    font-size: 52px;
    line-height: 1.08;
    font-weight: 700;
    margin: 0 0 28px 0;
    max-width: 900px;
  }
  ul.changes {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  ul.changes li {
    font-size: 24px;
    line-height: 1.3;
    color: #d7deec;
    padding-left: 34px;
    position: relative;
  }
  ul.changes li::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 12px;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: #6c8cff;
  }
  .spotlight {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-top: 26px;
    padding: 10px 18px;
    background: rgba(108,140,255,0.16);
    border: 1px solid rgba(108,140,255,0.45);
    border-radius: 12px;
    width: fit-content;
  }
  .spotlight-label {
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #aebdff;
  }
  .spotlight-names { font-size: 22px; font-weight: 600; color: #f5f7fb; }
  .bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 1;
  }
  .coverage {
    font-size: 22px;
    font-weight: 600;
    color: #aebdff;
  }
  .footer-note { font-size: 18px; color: #8a97b8; }
</style>
</head>
<body>
<div class="card">
  <div class="accent"></div>
  <div class="top">
    <div class="brand">affiliate-mcp</div>
    <div class="version">${escapeHtml(data.version)}</div>
  </div>
  <div class="body">
    <h1 class="hook">${escapeHtml(data.hook)}</h1>
    <ul class="changes">
${changeItems}
    </ul>
${spotlight}
  </div>
  <div class="bottom">
    <div class="coverage">${escapeHtml(coverage)}</div>
    <div class="footer-note">Open source · MIT · bring your own keys</div>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// LinkedIn post copy (pure)
// ---------------------------------------------------------------------------

/**
 * Build ready-to-paste LinkedIn post copy. The release URL is intentionally
 * NOT in the body — it goes in the first comment (the reminder line says so)
 * to avoid the feed's external-link demotion.
 */
export function renderLinkedInPostCopy(data: ReleaseCardData, repoUrl = REPO_URL): string {
  const coverage = data.bothSides
    ? `${data.networkCount} affiliate networks, on both the publisher and brand side`
    : `${data.networkCount} affiliate networks`;

  const lines: string[] = [];
  lines.push(`${data.hook} ${data.version} is out 🚀`);
  lines.push('');

  if (data.newNetworks.length > 0) {
    lines.push(`New in this release: ${data.newNetworks.join(', ')}.`);
    lines.push('');
  }

  lines.push("What's new:");
  for (const change of data.changes) {
    lines.push(`• ${change}`);
  }
  lines.push('');
  lines.push(
    `affiliate-mcp now covers ${coverage} — ask Claude one question and it fans out across them all. Free, open source, MIT licensed.`,
  );
  lines.push('');
  lines.push('👇 Link to the release in the first comment.');
  lines.push('');
  lines.push('#affiliatemarketing #MCP #Claude #opensource #martech');

  const post = lines.join('\n');

  // Appended for convenience, clearly separated; not part of the post body.
  const releaseUrl = `${repoUrl}/releases/tag/${data.version}`;
  return `${post}\n\n---\nFirst comment (paste separately):\n${releaseUrl}\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  version?: string;
  changes: string[];
  newNetworks: string[];
  notesPath?: string;
  outPath?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { changes: [], newNetworks: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--version':
        args.version = next();
        break;
      case '--change':
        args.changes.push(next());
        break;
      case '--new-network':
        args.newNetworks.push(next());
        break;
      case '--notes':
        args.notesPath = next();
        break;
      case '--out':
        args.outPath = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function runCli(argv: string[]): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = parseArgs(argv);

  const notes = cli.notesPath ? readFileSync(path.resolve(cli.notesPath), 'utf8') : undefined;
  const data = buildReleaseCardData({
    repoRoot,
    version: cli.version,
    changes: cli.changes,
    notes,
    newNetworks: cli.newNetworks,
  });

  const html = renderReleaseCardHtml(data);
  const post = renderLinkedInPostCopy(data);

  const outDir = path.join(repoRoot, 'docs', 'images');
  mkdirSync(outDir, { recursive: true });
  const outPath = cli.outPath
    ? path.resolve(cli.outPath)
    : path.join(outDir, 'release-card.png');
  const postPath = path.join(outDir, 'release-post.txt');

  // Always write the post copy — it does not depend on Playwright.
  writeFileSync(postPath, post, 'utf8');
  process.stderr.write(`Wrote ${postPath}.\n`);

  // Dynamic import so the script doesn't hard-require Playwright at parse time.
  // Playwright is intentionally not a declared dependency (its browser-binary
  // download is heavyweight); install it explicitly to render the card. The
  // dynamic import is typed loosely on purpose.
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
      'generate-release-card: Playwright is not installed.\n' +
        '  Install it with: npm install --save-dev playwright\n' +
        '  Then install the browsers: npx playwright install chromium\n' +
        `  The LinkedIn post copy was still written to ${postPath}.\n`,
    );
    // Write the HTML alongside so the card can still be inspected/rendered.
    const htmlPath = path.join(outDir, 'release-card.html');
    writeFileSync(htmlPath, html, 'utf8');
    process.stderr.write(`  Card HTML written to ${htmlPath} for inspection.\n`);
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
      deviceScaleFactor: 2, // crisp on retina / when LinkedIn re-compresses
    });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const cardHandle = page.locator('.card');
    await cardHandle.screenshot({ path: outPath, type: 'png' });
    process.stderr.write(`Wrote ${outPath} (${CARD_WIDTH}×${CARD_HEIGHT}).\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `generate-release-card: rasterisation failed — ${(err as Error).message}\n`,
    );
    const htmlPath = path.join(outDir, 'release-card.html');
    writeFileSync(htmlPath, html, 'utf8');
    process.stderr.write(`  HTML written to ${htmlPath} for inspection.\n`);
    return 2;
  } finally {
    if (browser) await browser.close();
  }
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('generate-release-card.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `generate-release-card fatal: ${(err as Error).stack ?? String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
