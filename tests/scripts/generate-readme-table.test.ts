/**
 * Tests for `scripts/generate-readme-table.ts`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadReportData } from '../../scripts/report-data.js';
import {
  applyReadmeTable,
  renderReadmeTable,
  TABLE_END_MARKER,
  TABLE_START_MARKER,
} from '../../scripts/generate-readme-table.js';

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-readme-'));
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
      slug: 'rakuten',
      name: 'Rakuten Advertising',
      base_url: 'https://api.linksynergy.com',
      auth_model: 'oauth2',
      env_vars: ['RAKUTEN_CLIENT_ID', 'RAKUTEN_CLIENT_SECRET', 'RAKUTEN_SID'],
      setup_time_estimate_minutes: 12,
      setup_requires_approval: true,
      setup_approval_days_typical: 5,
      known_limitations: [
        'listClicks is paid-tier-gated and throws NotImplementedError.',
      ],
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
    writeFileSync(path.join(findingsDir, `${n.slug}.md`), '# findings stub');
  }
  return root;
}

describe('generate-readme-table', () => {
  it('renders a table with one row per network in alphabetical slug order', () => {
    const repoRoot = makeFixture();
    const data = loadReportData({ repoRoot });
    const table = renderReadmeTable(data);

    expect(table).toContain('| Awin |');
    expect(table).toContain('| Rakuten Advertising |');
    expect(table.indexOf('| Awin |')).toBeLessThan(table.indexOf('| Rakuten Advertising |'));
  });

  it('updates the marked region in an existing README without disturbing surrounding content', () => {
    const before = [
      '# Project',
      '',
      'Some hand-written intro that must survive.',
      '',
      TABLE_START_MARKER,
      '| old | row |',
      TABLE_END_MARKER,
      '',
      '## Section after the table',
      '',
      'More hand-written prose that must also survive.',
      '',
    ].join('\n');
    const newTable = '| new | table |\n| --- | --- |';
    const after = applyReadmeTable(before, newTable);

    expect(after).toContain('Some hand-written intro that must survive.');
    expect(after).toContain('## Section after the table');
    expect(after).toContain('More hand-written prose that must also survive.');
    expect(after).toContain('| new | table |');
    expect(after).not.toContain('| old | row |');
  });

  it('appends the marked region when no markers exist', () => {
    const before = '# Project\n\nNo markers yet.\n';
    const newTable = '| col |\n| --- |';
    const after = applyReadmeTable(before, newTable);

    expect(after).toContain('No markers yet.');
    expect(after).toContain(TABLE_START_MARKER);
    expect(after).toContain(TABLE_END_MARKER);
    expect(after).toContain('| col |');
  });

  it('is idempotent — running the apply twice produces no further change', () => {
    const before = '# Project\n\nIntro.\n';
    const newTable = '| col |\n| --- |';
    const once = applyReadmeTable(before, newTable);
    const twice = applyReadmeTable(once, newTable);
    expect(twice).toEqual(once);
  });
});
