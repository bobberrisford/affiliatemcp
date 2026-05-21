/**
 * Tests for `scripts/generate-report-image.ts`.
 *
 * Playwright is not exercised here — the test asserts on the pure HTML
 * composition (which is what the headless browser ultimately rasterises).
 * If the HTML is well-formed and contains the expected rows, the rasterisation
 * step is a single integration concern best validated by running the script
 * in an environment with Playwright installed.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadReportData } from '../../scripts/report-data.js';
import { renderReportTableHtml } from '../../scripts/generate-report-image.js';

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-image-'));
  const netDir = path.join(root, 'src', 'networks');
  const findingsDir = path.join(root, 'docs', 'findings');
  mkdirSync(netDir, { recursive: true });
  mkdirSync(findingsDir, { recursive: true });
  const networks = [
    {
      slug: 'awin',
      name: 'Awin',
      base_url: 'https://api.awin.com',
      auth_model: 'bearer',
      env_vars: ['AWIN_API_TOKEN'],
      setup_time_estimate_minutes: 5,
      setup_requires_approval: false,
      known_limitations: ['listClicks is unsupported.'],
      claim_status: 'partial',
      adapter_version: '0.1.0',
      last_verified: '2026-05-21',
      supports_brand_ops: false,
    },
    {
      slug: 'cj',
      name: 'CJ Affiliate',
      base_url: 'https://api.cj.com',
      auth_model: 'bearer',
      env_vars: ['CJ_API_TOKEN'],
      setup_time_estimate_minutes: 8,
      setup_requires_approval: false,
      known_limitations: [],
      claim_status: 'partial',
      adapter_version: '0.1.0',
      last_verified: '2026-05-21',
      supports_brand_ops: false,
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

describe('generate-report-image (HTML composition)', () => {
  it('renders a complete HTML document with a doctype and table', () => {
    const repoRoot = makeFixture();
    const data = loadReportData({ repoRoot });
    const html = renderReportTableHtml(data);

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<table>');
    expect(html).toContain('</table>');
  });

  it('contains one row per network from the fixture', () => {
    const repoRoot = makeFixture();
    const data = loadReportData({ repoRoot });
    const html = renderReportTableHtml(data);
    expect(html).toContain('Awin');
    expect(html).toContain('CJ Affiliate');
  });

  it('escapes HTML special characters in dynamic cells', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-image-esc-'));
    const netDir = path.join(root, 'src', 'networks');
    const findingsDir = path.join(root, 'docs', 'findings');
    mkdirSync(netDir, { recursive: true });
    mkdirSync(findingsDir, { recursive: true });
    const slugDir = path.join(netDir, 'awin');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      path.join(slugDir, 'network.json'),
      JSON.stringify({
        slug: 'awin',
        name: 'A & B <script>',
        base_url: 'https://api.example.com',
        auth_model: 'bearer',
        env_vars: ['X'],
        setup_time_estimate_minutes: 1,
        setup_requires_approval: false,
        known_limitations: [],
        claim_status: 'partial',
        adapter_version: '0.1.0',
        last_verified: '2026-05-21',
        supports_brand_ops: false,
      }),
    );
    writeFileSync(path.join(findingsDir, 'awin.md'), '# stub');

    const data = loadReportData({ repoRoot: root });
    const html = renderReportTableHtml(data);
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('is idempotent — same inputs render the same HTML body', () => {
    const repoRoot = makeFixture();
    const fixed = new Date('2026-05-21T12:00:00Z');
    const d1 = loadReportData({ repoRoot, now: fixed });
    const d2 = loadReportData({ repoRoot, now: fixed });
    expect(renderReportTableHtml(d1)).toEqual(renderReportTableHtml(d2));
  });
});
