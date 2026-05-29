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
 * Rendering: the card is composed as a self-contained SVG (a pure function
 * exercised by the test suite) and rasterised with `@resvg/resvg-js` — a
 * pure-npm dependency that needs no browser, so this works in headless/CI and
 * web environments where Playwright's browser binaries can't be downloaded.
 * The SVG is written alongside the PNG so it can be re-rendered anywhere.
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
const RENDER_SCALE = 2; // rasterise at 2× for crispness after LinkedIn re-compresses
const PAD = 72;
const MAX_CHANGES = 4;
const REPO_URL = 'https://github.com/bobberrisford/affiliatemcp';
// Font stack: resvg matches the first family it can load from system fonts.
const FONT_STACK = 'DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif';

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
// SVG composition (pure)
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Approximate rendered width of a string. SVG has no layout engine, so the
 * card positions text manually; `charW` is an average glyph-width ratio tuned
 * for the sans-serif stack. Good enough for wrapping and chip sizing.
 */
function textWidth(s: string, fontSize: number, charW = 0.54): number {
  return s.length * fontSize * charW;
}

/** Greedy word-wrap to a maximum pixel width. */
function wrap(text: string, fontSize: number, maxWidth: number, charW = 0.54): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  const fits = (s: string): boolean => textWidth(s, fontSize, charW) <= maxWidth;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate) || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Pure SVG composition for the release card at CARD_WIDTH × CARD_HEIGHT. Dark,
 * branded, high-contrast — built to stop the scroll in a LinkedIn feed.
 * Deterministic for a given input.
 */
export function renderReleaseCardSvg(data: ReleaseCardData): string {
  const contentW = CARD_WIDTH - PAD * 2;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
  );
  parts.push(`<defs>
    <radialGradient id="bg" cx="0%" cy="0%" r="120%">
      <stop offset="0%" stop-color="#1d2a4d"/>
      <stop offset="55%" stop-color="#0b1020"/>
      <stop offset="100%" stop-color="#070a14"/>
    </radialGradient>
    <radialGradient id="accent" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#638cff" stop-opacity="0.35"/>
      <stop offset="70%" stop-color="#638cff" stop-opacity="0"/>
    </radialGradient>
  </defs>`);
  parts.push(`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)"/>`);
  parts.push(`<circle cx="${CARD_WIDTH - 60}" cy="60" r="240" fill="url(#accent)"/>`);

  // Top row — brand (left) and version pill (right).
  parts.push(
    `<text x="${PAD}" y="${PAD + 28}" font-family="${FONT_STACK}" font-size="24" font-weight="bold" fill="#c7d2fe">affiliate-mcp</text>`,
  );
  const vFont = 24;
  const vTextW = textWidth(data.version, vFont, 0.6);
  const pillPadX = 20;
  const pillW = vTextW + pillPadX * 2;
  const pillH = 44;
  const pillX = CARD_WIDTH - PAD - pillW;
  const pillY = PAD;
  parts.push(
    `<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="22" fill="none" stroke="#c7d2fe" stroke-opacity="0.4" stroke-width="1.5"/>`,
  );
  parts.push(
    `<text x="${pillX + pillW / 2}" y="${pillY + pillH / 2 + 9}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${vFont}" font-weight="bold" fill="#e8edff">${escapeXml(data.version)}</text>`,
  );

  // Hook.
  const hookFont = 50;
  let y = 250;
  for (const line of wrap(data.hook, hookFont, contentW, 0.56)) {
    parts.push(
      `<text x="${PAD}" y="${y}" font-family="${FONT_STACK}" font-size="${hookFont}" font-weight="bold" fill="#f5f7fb">${escapeXml(line)}</text>`,
    );
    y += hookFont * 1.12;
  }

  // Changes.
  y += 18;
  const chFont = 24;
  for (const change of data.changes) {
    parts.push(
      `<rect x="${PAD + 2}" y="${y - chFont + 6}" width="12" height="12" rx="3" fill="#6c8cff"/>`,
    );
    for (const line of wrap(change, chFont, contentW - 34, 0.54)) {
      parts.push(
        `<text x="${PAD + 34}" y="${y}" font-family="${FONT_STACK}" font-size="${chFont}" fill="#d7deec">${escapeXml(line)}</text>`,
      );
      y += chFont * 1.3;
    }
    y += 6;
  }

  // New-network spotlight chip.
  if (data.newNetworks.length > 0) {
    const label = 'NEW';
    const names = data.newNetworks.join('  ·  ');
    const labelFont = 14;
    const nameFont = 22;
    const chipPadX = 18;
    const gap = 16;
    // Bold + 1.5px letter-spacing across the label glyphs — widen the estimate.
    const labelW = textWidth(label, labelFont, 0.78) + 1.5 * label.length;
    const namesW = textWidth(names, nameFont, 0.56);
    const chipW = chipPadX * 2 + labelW + gap + namesW;
    const chipH = 46;
    const chipY = y + 6;
    parts.push(
      `<rect x="${PAD}" y="${chipY}" width="${chipW}" height="${chipH}" rx="12" fill="#6c8cff" fill-opacity="0.16" stroke="#6c8cff" stroke-opacity="0.45" stroke-width="1.5"/>`,
    );
    parts.push(
      `<text x="${PAD + chipPadX}" y="${chipY + chipH / 2 + 5}" font-family="${FONT_STACK}" font-size="${labelFont}" font-weight="bold" fill="#aebdff" letter-spacing="1.5">${label}</text>`,
    );
    parts.push(
      `<text x="${PAD + chipPadX + labelW + gap}" y="${chipY + chipH / 2 + 8}" font-family="${FONT_STACK}" font-size="${nameFont}" font-weight="bold" fill="#f5f7fb">${escapeXml(names)}</text>`,
    );
  }

  // Bottom row — coverage (left) and licence note (right).
  const coverage = data.bothSides
    ? `${data.networkCount} networks · publisher + brand side`
    : `${data.networkCount} networks`;
  const bottomY = CARD_HEIGHT - PAD + 8;
  parts.push(
    `<text x="${PAD}" y="${bottomY}" font-family="${FONT_STACK}" font-size="22" font-weight="bold" fill="#aebdff">${escapeXml(coverage)}</text>`,
  );
  const footer = 'Open source · MIT · bring your own keys';
  const footerW = textWidth(footer, 18, 0.52);
  parts.push(
    `<text x="${CARD_WIDTH - PAD - footerW}" y="${bottomY}" font-family="${FONT_STACK}" font-size="18" fill="#8a97b8">${escapeXml(footer)}</text>`,
  );

  parts.push(`</svg>`);
  return parts.join('\n');
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

  const svg = renderReleaseCardSvg(data);
  const post = renderLinkedInPostCopy(data);

  const outDir = path.join(repoRoot, 'docs', 'images');
  mkdirSync(outDir, { recursive: true });
  const outPath = cli.outPath ? path.resolve(cli.outPath) : path.join(outDir, 'release-card.png');
  const svgPath = path.join(outDir, 'release-card.svg');
  const postPath = path.join(outDir, 'release-post.txt');

  // The SVG and post copy don't depend on the rasteriser — always write them.
  writeFileSync(svgPath, svg, 'utf8');
  writeFileSync(postPath, post, 'utf8');
  process.stderr.write(`Wrote ${svgPath}.\n`);
  process.stderr.write(`Wrote ${postPath}.\n`);

  // resvg-js is a declared devDependency; import it lazily so the pure
  // functions above stay loadable (e.g. in tests) without the native binary.
  let Resvg: typeof import('@resvg/resvg-js').Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    process.stderr.write(
      'generate-release-card: @resvg/resvg-js is not installed.\n' +
        '  Install dev dependencies with: npm install\n' +
        `  The SVG (${svgPath}) and post copy (${postPath}) were still written;\n` +
        '  you can rasterise the SVG with any tool.\n',
    );
    return 1;
  }

  try {
    const resvg = new Resvg(svg, {
      font: { loadSystemFonts: true },
      fitTo: { mode: 'width', value: CARD_WIDTH * RENDER_SCALE },
    });
    const png = resvg.render().asPng();
    writeFileSync(outPath, png);
    process.stderr.write(
      `Wrote ${outPath} (${CARD_WIDTH * RENDER_SCALE}×${CARD_HEIGHT * RENDER_SCALE}, ${RENDER_SCALE}× of ${CARD_WIDTH}×${CARD_HEIGHT}).\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `generate-release-card: rasterisation failed — ${(err as Error).message}\n` +
        `  The SVG was written to ${svgPath} for inspection.\n`,
    );
    return 2;
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
      process.stderr.write(`generate-release-card fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
