/**
 * Tests for `scripts/generate-report.ts`.
 *
 * Strategy: build a tiny fixture set of `network.json` + findings against a
 * temporary directory, run the generator, and assert on the rendered string.
 *
 * The test does not exec the CLI — it imports `renderReport` and `loadReportData`
 * so failures show stack traces rather than child-process exit codes.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadReportData } from '../../scripts/report-data.js';
import { renderReport } from '../../scripts/generate-report.js';

interface FixtureNetwork {
  slug: string;
  name: string;
  base_url: string;
  auth_model: 'bearer' | 'oauth2' | 'basic' | 'custom';
  env_vars: string[];
  setup_time_estimate_minutes: number;
  setup_requires_approval: boolean;
  setup_approval_days_typical?: number;
  known_limitations: string[];
  claim_status: 'production' | 'partial' | 'experimental' | 'unsupported';
  adapter_version: string;
  last_verified: string;
  supports_brand_ops: boolean;
  docs_url?: string;
  findings: string;
}

function makeFixture(networks: FixtureNetwork[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-report-'));
  const netDir = path.join(root, 'src', 'networks');
  const findingsDir = path.join(root, 'docs', 'findings');
  mkdirSync(netDir, { recursive: true });
  mkdirSync(findingsDir, { recursive: true });
  for (const n of networks) {
    const slugDir = path.join(netDir, n.slug);
    mkdirSync(slugDir, { recursive: true });
    const { findings, ...manifest } = n;
    writeFileSync(path.join(slugDir, 'network.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(findingsDir, `${n.slug}.md`), findings);
  }
  return root;
}

const FIXTURES: FixtureNetwork[] = [
  {
    slug: 'awin',
    name: 'Awin',
    base_url: 'https://api.awin.com',
    auth_model: 'bearer',
    env_vars: ['AWIN_API_TOKEN', 'AWIN_PUBLISHER_ID'],
    setup_time_estimate_minutes: 5,
    setup_requires_approval: false,
    known_limitations: ['Click-level data is not exposed via the public publisher API; listClicks is unsupported.'],
    claim_status: 'partial',
    adapter_version: '0.1.0',
    last_verified: '2026-05-21',
    supports_brand_ops: false,
    docs_url: 'https://wiki.awin.com/index.php/API_Get_Started',
    findings: '# Findings: Awin\n\nThe canonical reference adapter. Single bearer token, long-lived.\n',
  },
  {
    slug: 'cj',
    name: 'CJ Affiliate',
    base_url: 'https://api.cj.com',
    auth_model: 'bearer',
    env_vars: ['CJ_API_TOKEN', 'CJ_COMPANY_ID'],
    setup_time_estimate_minutes: 8,
    setup_requires_approval: false,
    known_limitations: ['Click-level data is not exposed via GraphQL; listClicks throws NotImplementedError.'],
    claim_status: 'partial',
    adapter_version: '0.1.0',
    last_verified: '2026-05-21',
    supports_brand_ops: false,
    findings: '# Findings: CJ\n\nGraphQL + REST hybrid. CJ-specific characterisation prose.\n',
  },
  {
    slug: 'impact',
    name: 'Impact',
    base_url: 'https://api.impact.com',
    auth_model: 'basic',
    env_vars: ['IMPACT_ACCOUNT_SID', 'IMPACT_AUTH_TOKEN'],
    setup_time_estimate_minutes: 6,
    setup_requires_approval: false,
    known_limitations: ['Pagination headers are inconsistent across endpoints.'],
    claim_status: 'partial',
    adapter_version: '0.1.0',
    last_verified: '2026-05-21',
    supports_brand_ops: false,
    findings: '# Findings: Impact\n\nMediapartners surface; 5xx workarounds documented.\n',
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
    known_limitations: ['Click-level data (clicks_reports) is paid-tier-gated; listClicks throws NotImplementedError.'],
    claim_status: 'partial',
    adapter_version: '0.1.0',
    last_verified: '2026-05-21',
    supports_brand_ops: false,
    findings: '# Findings: Rakuten\n\nOAuth2 with hourly tokens; approval required to gain API access.\n',
  },
];

// Tone-policing tokens. The report must read matter-of-factly. We allow some
// negative tokens (e.g. "limitation", "unsupported") because they are
// descriptive, not editorial; the list below targets snark and marketing.
const SNARKY_PATTERNS: RegExp[] = [
  /\bbad\b/i,
  /\bterrible\b/i,
  /\bawful\b/i,
  /\blazy\b/i,
  /\bbroken\b/i,
  /\bworst\b/i,
  /\bbest\b/i,
  /\bleader\b/i,
  /\bgarbage\b/i,
  /\bhorrible\b/i,
];

describe('generate-report', () => {
  it('renders all four network sections from the fixture', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);

    expect(body).toMatch(/## Awin\b/);
    expect(body).toMatch(/## CJ Affiliate\b/);
    expect(body).toMatch(/## Impact\b/);
    expect(body).toMatch(/## Rakuten Advertising\b/);
  });

  it('embeds the findings prose verbatim under each network', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);

    for (const fix of FIXTURES) {
      expect(body).toContain(fix.findings.trim());
    }
  });

  it('includes a methodology section', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);
    expect(body).toMatch(/## Methodology\b/);
    expect(body).toContain('canonical contract');
  });

  it('stamps the generated date within seconds of "now"', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);

    const today = new Date().toISOString().slice(0, 10);
    expect(body).toContain(`Date-stamped: ${today}`);
  });

  it('contains no snarky-tone tokens in the rendered output', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);

    for (const pattern of SNARKY_PATTERNS) {
      const match = body.match(pattern);
      if (match) {
        throw new Error(
          `Snarky-tone token "${match[0]}" appeared in the report. Surrounding text: "${body.slice(
            Math.max(0, (match.index ?? 0) - 60),
            (match.index ?? 0) + match[0].length + 60,
          )}"`,
        );
      }
    }
  });

  it('is idempotent — re-running with the same inputs produces the same body (modulo timestamp)', () => {
    const repoRoot = makeFixture(FIXTURES);
    const fixedDate = new Date('2026-05-21T12:00:00Z');
    const data1 = loadReportData({ repoRoot, now: fixedDate });
    const data2 = loadReportData({ repoRoot, now: fixedDate });
    const body1 = renderReport(data1, { now: fixedDate });
    const body2 = renderReport(data2, { now: fixedDate });
    expect(body1).toEqual(body2);
  });

  it('lists networks alphabetically by slug regardless of disk order', () => {
    const reversed = [...FIXTURES].reverse();
    const repoRoot = makeFixture(reversed);
    const data = loadReportData({ repoRoot });
    const body = renderReport(data);

    const order = ['Awin', 'CJ Affiliate', 'Impact', 'Rakuten Advertising'];
    const indices = order.map((name) => body.indexOf(`## ${name}`));
    expect(indices.every((i) => i > -1)).toBe(true);
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  it('surfaces the live-data-unavailable note when no capabilities are injected', () => {
    const repoRoot = makeFixture(FIXTURES);
    const data = loadReportData({ repoRoot });
    expect(data.liveDataAvailable).toBe(false);
    const body = renderReport(data);
    expect(body).toContain('Live diagnostic data was not collected');
  });
});
