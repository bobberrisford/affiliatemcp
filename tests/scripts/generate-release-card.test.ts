/**
 * Tests for `scripts/generate-release-card.ts`.
 *
 * The rasteriser (`@resvg/resvg-js`) is not exercised here — the tests assert
 * on the pure data assembly, SVG composition (what resvg rasterises) and the
 * LinkedIn post copy. Rasterisation is a single integration concern validated
 * by running the script.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildReleaseCardData,
  extractChangeHeadlines,
  normaliseVersion,
  parseArgs,
  renderLinkedInPostCopy,
  renderReleaseCardSvg,
} from '../../scripts/generate-release-card.js';

/**
 * Build a minimal repo fixture: a publisher network, an advertiser network,
 * and a package.json so the version fallback resolves.
 */
function makeFixture(version = '0.3.0'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-card-'));
  const netDir = path.join(root, 'src', 'networks');
  const findingsDir = path.join(root, 'docs', 'findings');
  mkdirSync(netDir, { recursive: true });
  mkdirSync(findingsDir, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));

  const networks = [
    {
      slug: 'awin',
      name: 'Awin',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'partial',
      adapter_version: '0.1.0',
      last_verified: '2026-05-21',
      supports_brand_ops: false,
      side: 'publisher',
    },
    {
      slug: 'awin-advertiser',
      name: 'Awin (advertiser)',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'partial',
      adapter_version: '0.1.0',
      last_verified: '2026-05-21',
      supports_brand_ops: true,
      side: 'advertiser',
    },
  ];
  for (const n of networks) {
    const slugDir = path.join(netDir, n.slug);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(path.join(slugDir, 'network.json'), JSON.stringify(n));
    writeFileSync(path.join(findingsDir, `${n.slug}.md`), '# stub');
  }
  return root;
}

describe('normaliseVersion', () => {
  it('adds a single leading v', () => {
    expect(normaliseVersion('0.3.0')).toBe('v0.3.0');
    expect(normaliseVersion('v0.3.0')).toBe('v0.3.0');
    expect(normaliseVersion('  V1.2.3 ')).toBe('v1.2.3');
  });
});

describe('extractChangeHeadlines', () => {
  it('pulls bullet lines and strips PR/author noise', () => {
    const notes = [
      "## What's Changed",
      '* Added the Rakuten advertiser adapter by @bob in https://github.com/x/y/pull/42',
      '- Faster transaction pagination (#43)',
      '* **Full Changelog**: https://github.com/x/y/compare/v0.2.0...v0.3.0',
      'New Contributors',
    ].join('\n');
    expect(extractChangeHeadlines(notes)).toEqual([
      'Added the Rakuten advertiser adapter',
      'Faster transaction pagination',
    ]);
  });

  it('respects the max count', () => {
    const notes = ['- a', '- b', '- c', '- d', '- e'].join('\n');
    expect(extractChangeHeadlines(notes, 2)).toEqual(['a', 'b']);
  });

  it('returns nothing when there are no bullets', () => {
    expect(extractChangeHeadlines('just prose, no bullets')).toEqual([]);
  });
});

describe('buildReleaseCardData', () => {
  it('reads version from package.json and counts both sides', () => {
    const repoRoot = makeFixture('1.4.2');
    const data = buildReleaseCardData({ repoRoot });
    expect(data.version).toBe('v1.4.2');
    expect(data.networkCount).toBe(2);
    expect(data.bothSides).toBe(true);
    expect(data.hook).toMatch(/Claude/);
  });

  it('prefers explicit changes over notes', () => {
    const repoRoot = makeFixture();
    const data = buildReleaseCardData({
      repoRoot,
      changes: ['Explicit one'],
      notes: '- From notes',
    });
    expect(data.changes).toEqual(['Explicit one']);
  });

  it('falls back to notes when no explicit changes given', () => {
    const repoRoot = makeFixture();
    const data = buildReleaseCardData({ repoRoot, notes: '- From notes' });
    expect(data.changes).toEqual(['From notes']);
  });

  it('falls back to a generic change line when nothing is supplied', () => {
    const repoRoot = makeFixture();
    const data = buildReleaseCardData({ repoRoot });
    expect(data.changes).toHaveLength(1);
    expect(data.changes[0]).toMatch(/adapter updates/i);
  });

  it('caps changes at four', () => {
    const repoRoot = makeFixture();
    const data = buildReleaseCardData({
      repoRoot,
      changes: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(data.changes).toHaveLength(4);
  });
});

describe('renderReleaseCardSvg', () => {
  const baseData = {
    version: 'v0.3.0',
    hook: 'Chat to your affiliate data with Claude.',
    changes: ['Added Rakuten advertiser adapter', 'Faster pagination'],
    networkCount: 18,
    bothSides: true,
    newNetworks: ['Rakuten (brand side)'],
  };

  it('renders a well-formed SVG document at the LinkedIn ratio', () => {
    const svg = renderReleaseCardSvg(baseData);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('</svg>');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="627"');
    expect(svg).toContain('v0.3.0');
    expect(svg).toContain('Added Rakuten advertiser adapter');
    expect(svg).toContain('18 networks · publisher + brand side');
    expect(svg).toContain('Rakuten (brand side)');
  });

  it('omits the spotlight chip when there are no new networks', () => {
    const without = renderReleaseCardSvg({ ...baseData, newNetworks: [] });
    expect(without).not.toContain('Rakuten (brand side)');
    expect(without).not.toContain('>NEW<');
    // The chip is the only place the "NEW" label appears.
    expect(renderReleaseCardSvg(baseData)).toContain('>NEW<');
  });

  it('shows a plain network count when not both sides', () => {
    const svg = renderReleaseCardSvg({ ...baseData, bothSides: false });
    expect(svg).toContain('18 networks');
    expect(svg).not.toContain('publisher + brand side');
  });

  it('escapes XML special characters', () => {
    const svg = renderReleaseCardSvg({
      ...baseData,
      changes: ['A & B <script>'],
    });
    expect(svg).toContain('A &amp; B &lt;script&gt;');
    expect(svg).not.toContain('<script>');
  });

  it('wraps a long change line across multiple text runs', () => {
    const long =
      'A very long change description that will certainly exceed the available content width of the card and wrap';
    const svg = renderReleaseCardSvg({ ...baseData, changes: [long] });
    // The single change should produce more than one <text> run for its lines,
    // beyond the fixed text runs (brand, version, hook, coverage, footer).
    const textRuns = (svg.match(/<text /g) ?? []).length;
    expect(textRuns).toBeGreaterThan(6);
  });

  it('is deterministic for the same input', () => {
    expect(renderReleaseCardSvg(baseData)).toEqual(renderReleaseCardSvg(baseData));
  });
});

describe('renderLinkedInPostCopy', () => {
  const data = {
    version: 'v0.3.0',
    hook: 'Chat to your affiliate data with Claude.',
    changes: ['Added Rakuten advertiser adapter', 'Faster pagination'],
    networkCount: 18,
    bothSides: true,
    newNetworks: ['Rakuten (brand side)'],
  };

  it('leads with the hook and version', () => {
    const post = renderLinkedInPostCopy(data);
    expect(post.startsWith('Chat to your affiliate data with Claude. v0.3.0')).toBe(true);
  });

  it('keeps the release link out of the body and puts it in the first comment', () => {
    const post = renderLinkedInPostCopy(data);
    const [body] = post.split('\n---\n');
    expect(body).not.toContain('https://');
    expect(post).toContain('First comment');
    expect(post).toContain('/releases/tag/v0.3.0');
    expect(post).toMatch(/first comment/i);
  });

  it('mentions the new networks and coverage', () => {
    const post = renderLinkedInPostCopy(data);
    expect(post).toContain('Rakuten (brand side)');
    expect(post).toContain('18 affiliate networks');
    expect(post).toContain('publisher and brand side');
  });
});

describe('parseArgs', () => {
  it('parses repeatable and single flags', () => {
    const args = parseArgs([
      '--version',
      'v1.0.0',
      '--change',
      'one',
      '--change',
      'two',
      '--new-network',
      'Rakuten',
      '--notes',
      'notes.md',
      '--out',
      'card.png',
    ]);
    expect(args).toEqual({
      version: 'v1.0.0',
      changes: ['one', 'two'],
      newNetworks: ['Rakuten'],
      notesPath: 'notes.md',
      outPath: 'card.png',
    });
  });

  it('throws on a missing value', () => {
    expect(() => parseArgs(['--version'])).toThrow(/Missing value/);
  });

  it('throws on an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
