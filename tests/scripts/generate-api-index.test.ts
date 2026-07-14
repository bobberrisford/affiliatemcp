/**
 * Tests for `scripts/generate-api-index.ts`.
 *
 * Two layers, matching the sibling generator tests:
 *  - `scoreNetwork` is a pure function exercised against fixture manifests
 *    (mirrors `tests/scripts/validate-network-json.test.ts`).
 *  - An end-to-end pass loads the real repo tree (every network's
 *    `network.json` under `src/networks/`) and renders a draft, so a schema
 *    or path change
 *    that breaks the generator against real data fails here, not only in CI
 *    after `npm run generate:api-index` is run by hand.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  loadReportData,
  REPORTED_OPERATIONS,
  supportedOperationCount,
  type NetworkManifest,
} from '../../scripts/report-data.js';
import {
  APPROVAL_FRICTION_MULTIPLIER,
  AUTH_SIMPLICITY_WEIGHT,
  BASELINE_SETUP_MINUTES,
  CLAIM_STATUS_WEIGHT,
  FRESHNESS_STALE_FACTOR,
  MIN_ENV_VARS_BASELINE,
  OPERATION_COVERAGE_WEIGHT,
  SETUP_FRICTION_WEIGHT,
  TRANSPARENCY_WEIGHT,
  getGitGenerationInfo,
  rankScores,
  renderApiIndexDraft,
  scoreNetwork,
  type ApiIndexEntryInput,
} from '../../scripts/generate-api-index.js';

function manifest(overrides: Partial<NetworkManifest> = {}): NetworkManifest {
  return {
    slug: 'fixture-network',
    name: 'Fixture Network',
    base_url: 'https://api.example.com',
    auth_model: 'bearer',
    env_vars: ['FIXTURE_API_TOKEN'],
    setup_time_estimate_minutes: 5,
    setup_requires_approval: false,
    known_limitations: [],
    claim_status: 'production',
    adapter_version: '0.1.0',
    last_verified: '2026-07-01',
    supports_brand_ops: false,
    side: 'publisher',
    credential_scope: 'single-brand',
    ...overrides,
  };
}

function input(overrides: Partial<ApiIndexEntryInput> = {}): ApiIndexEntryInput {
  return {
    manifest: manifest(),
    hasFindingsDoc: true,
    supportedOps: REPORTED_OPERATIONS.length,
    totalOps: REPORTED_OPERATIONS.length,
    ...overrides,
  };
}

const NOW = new Date('2026-07-12T12:00:00Z');

describe('scoreNetwork (pure)', () => {
  it('awards full marks to a fresh, fully-supported, frictionless, documented adapter', () => {
    const score = scoreNetwork(input(), NOW);
    expect(score.total).toBeCloseTo(100, 5);
    expect(score.claimStatusPoints).toBeCloseTo(CLAIM_STATUS_WEIGHT, 5);
    expect(score.operationCoveragePoints).toBeCloseTo(OPERATION_COVERAGE_WEIGHT, 5);
    expect(score.setupFrictionPoints).toBeCloseTo(SETUP_FRICTION_WEIGHT, 5);
    expect(score.authSimplicityPoints).toBeCloseTo(AUTH_SIMPLICITY_WEIGHT, 5);
    expect(score.transparencyPoints).toBeCloseTo(TRANSPARENCY_WEIGHT, 5);
    expect(score.freshnessStale).toBe(false);
  });

  it('scores an unsupported network at zero claim-status points', () => {
    const score = scoreNetwork(input({ manifest: manifest({ claim_status: 'unsupported' }) }), NOW);
    expect(score.claimStatusPoints).toBe(0);
  });

  it('gives experimental exactly one third of the production claim-status points', () => {
    const experimental = scoreNetwork(
      input({ manifest: manifest({ claim_status: 'experimental' }) }),
      NOW,
    );
    const production = scoreNetwork(input({ manifest: manifest({ claim_status: 'production' }) }), NOW);
    expect(experimental.claimStatusPoints).toBeCloseTo(production.claimStatusPoints / 3, 5);
  });

  it('gives partial exactly two thirds of the production claim-status points', () => {
    const partial = scoreNetwork(
      input({ manifest: manifest({ claim_status: 'partial', last_verified: '2026-07-01' }) }),
      NOW,
    );
    const production = scoreNetwork(input({ manifest: manifest({ claim_status: 'production' }) }), NOW);
    expect(partial.claimStatusPoints).toBeCloseTo((production.claimStatusPoints * 2) / 3, 5);
  });

  it('halves the claim-status contribution when a production claim is stale', () => {
    const fresh = scoreNetwork(
      input({ manifest: manifest({ claim_status: 'production', last_verified: '2026-06-01' }) }),
      NOW,
    );
    const stale = scoreNetwork(
      input({ manifest: manifest({ claim_status: 'production', last_verified: '2025-12-01' }) }),
      NOW,
    );
    expect(fresh.freshnessStale).toBe(false);
    expect(stale.freshnessStale).toBe(true);
    expect(stale.claimStatusPoints).toBeCloseTo(fresh.claimStatusPoints * FRESHNESS_STALE_FACTOR, 5);
  });

  it('never applies freshness staleness to an experimental claim', () => {
    const score = scoreNetwork(
      input({ manifest: manifest({ claim_status: 'experimental', last_verified: '2020-01-01' }) }),
      NOW,
    );
    expect(score.freshnessStale).toBe(false);
  });

  it('scales operation coverage points by the supported/total ratio', () => {
    const half = scoreNetwork(input({ supportedOps: REPORTED_OPERATIONS.length / 2 }), NOW);
    expect(half.operationCoveragePoints).toBeCloseTo(OPERATION_COVERAGE_WEIGHT / 2, 5);
  });

  it('halves setup-friction points when approval is required', () => {
    const noApproval = scoreNetwork(
      input({ manifest: manifest({ setup_requires_approval: false }) }),
      NOW,
    );
    const approval = scoreNetwork(
      input({ manifest: manifest({ setup_requires_approval: true }) }),
      NOW,
    );
    expect(approval.setupFrictionPoints).toBeCloseTo(
      noApproval.setupFrictionPoints * APPROVAL_FRICTION_MULTIPLIER,
      5,
    );
  });

  it('caps setup-friction points at the full weight for the fastest baseline', () => {
    const score = scoreNetwork(
      input({ manifest: manifest({ setup_time_estimate_minutes: BASELINE_SETUP_MINUTES }) }),
      NOW,
    );
    expect(score.setupFrictionPoints).toBeCloseTo(SETUP_FRICTION_WEIGHT, 5);
  });

  it('reduces setup-friction points for a slower recorded setup time', () => {
    const slow = scoreNetwork(
      input({ manifest: manifest({ setup_time_estimate_minutes: BASELINE_SETUP_MINUTES * 4 }) }),
      NOW,
    );
    expect(slow.setupFrictionPoints).toBeCloseTo(SETUP_FRICTION_WEIGHT / 4, 5);
  });

  it('caps credential-simplicity points at the full weight for the simplest footprint', () => {
    const score = scoreNetwork(
      input({ manifest: manifest({ env_vars: Array(MIN_ENV_VARS_BASELINE).fill('X') }) }),
      NOW,
    );
    expect(score.authSimplicityPoints).toBeCloseTo(AUTH_SIMPLICITY_WEIGHT, 5);
  });

  it('reduces credential-simplicity points for a larger credential footprint', () => {
    const score = scoreNetwork(
      input({ manifest: manifest({ env_vars: ['A', 'B', 'C', 'D'] }) }),
      NOW,
    );
    expect(score.authSimplicityPoints).toBeCloseTo(AUTH_SIMPLICITY_WEIGHT / 4, 5);
  });

  it('awards zero transparency points when no findings doc exists', () => {
    const score = scoreNetwork(input({ hasFindingsDoc: false }), NOW);
    expect(score.transparencyPoints).toBe(0);
  });

  it('is deterministic: identical input and clock produce an identical score', () => {
    const a = scoreNetwork(input(), NOW);
    const b = scoreNetwork(input(), NOW);
    expect(a).toEqual(b);
  });
});

describe('rankScores', () => {
  it('orders by total descending and breaks ties alphabetically by name', () => {
    const high = scoreNetwork(input({ manifest: manifest({ name: 'Zeta', claim_status: 'production' }) }), NOW);
    const tiedA = scoreNetwork(
      input({ manifest: manifest({ name: 'Beta', claim_status: 'experimental' }) }),
      NOW,
    );
    const tiedB = scoreNetwork(
      input({ manifest: manifest({ name: 'Alpha', claim_status: 'experimental' }) }),
      NOW,
    );
    const ranked = rankScores([high, tiedA, tiedB]);
    expect(ranked.map((s) => s.name)).toEqual(['Zeta', 'Alpha', 'Beta']);
  });
});

describe('renderApiIndexDraft', () => {
  const options = { generatedAtIso: '2026-07-12T00:00:00Z', gitSha: 'abc1234' };

  it('carries the unpublished-draft banner at both the top and bottom', () => {
    const body = renderApiIndexDraft([scoreNetwork(input(), NOW)], options);
    expect(body).toMatch(/^> \*\*UNPUBLISHED DRAFT/);
    const occurrences = body.split('UNPUBLISHED DRAFT').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('states the exact weights in the methodology section', () => {
    const body = renderApiIndexDraft([scoreNetwork(input(), NOW)], options);
    expect(body).toContain('## Methodology');
    expect(body).toContain(`Claim status (${CLAIM_STATUS_WEIGHT} pts)`);
    expect(body).toContain(`Operation coverage (${OPERATION_COVERAGE_WEIGHT} pts)`);
    expect(body).toContain(`Setup friction (${SETUP_FRICTION_WEIGHT} pts)`);
    expect(body).toContain(`Credential simplicity (${AUTH_SIMPLICITY_WEIGHT} pts)`);
    expect(body).toContain(`Documentation transparency (${TRANSPARENCY_WEIGHT} pts)`);
  });

  it('renders the commit sha and timestamp the CLI passed in, not a hand-typed date', () => {
    const body = renderApiIndexDraft([scoreNetwork(input(), NOW)], options);
    expect(body).toContain(options.gitSha);
    expect(body).toContain(options.generatedAtIso);
  });

  it('renders one ranked row per network', () => {
    const scores = [
      scoreNetwork(input({ manifest: manifest({ slug: 'a', name: 'A Network' }) }), NOW),
      scoreNetwork(input({ manifest: manifest({ slug: 'b', name: 'B Network' }) }), NOW),
    ];
    const body = renderApiIndexDraft(scores, options);
    expect(body).toContain('A Network');
    expect(body).toContain('B Network');
  });

  it('is idempotent for identical scores and options', () => {
    const scores = [scoreNetwork(input(), NOW)];
    expect(renderApiIndexDraft(scores, options)).toEqual(renderApiIndexDraft(scores, options));
  });
});

describe('end-to-end against the real repo tree', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = loadReportData({ repoRoot });
  const findingsDir = path.join(repoRoot, 'docs', 'findings');

  function toEntryInput(entry: (typeof data.networks)[number]): ApiIndexEntryInput {
    return {
      manifest: entry.manifest,
      hasFindingsDoc: existsSync(path.join(findingsDir, `${entry.manifest.slug}.md`)),
      supportedOps: supportedOperationCount(entry),
      totalOps: REPORTED_OPERATIONS.length,
    };
  }

  it('loads every real network.json and scores it without throwing', () => {
    expect(data.networks.length).toBeGreaterThan(0);

    const scores = data.networks.map((entry) =>
      scoreNetwork(toEntryInput(entry), new Date('2026-07-12T00:00:00Z')),
    );

    expect(scores).toHaveLength(data.networks.length);
    for (const score of scores) {
      expect(score.total).toBeGreaterThanOrEqual(0);
      expect(score.total).toBeLessThanOrEqual(100);
      expect(Number.isFinite(score.total)).toBe(true);
    }
  });

  it('renders a complete draft document from real data, written only to a scratch path', () => {
    const scores = data.networks.map((entry) =>
      scoreNetwork(toEntryInput(entry), new Date('2026-07-12T00:00:00Z')),
    );
    const body = renderApiIndexDraft(scores, { generatedAtIso: '2026-07-12T00:00:00Z', gitSha: 'deadbee' });

    expect(body).toContain('# Affiliate Network API Index (draft)');
    expect(body).toContain('## Ranking');
    for (const entry of data.networks) {
      expect(body).toContain(entry.manifest.name);
    }

    // Write to a scratch directory, never the real docs/product path, so the
    // test never mutates the tree it is verifying.
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-api-index-'));
    mkdirSync(scratchDir, { recursive: true });
    const scratchFile = path.join(scratchDir, 'api-index-draft.md');
    writeFileSync(scratchFile, body, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('reads a real commit sha and ISO timestamp from git', () => {
    const info = getGitGenerationInfo(repoRoot);
    expect(info.sha).toMatch(/^[0-9a-f]{4,40}$/);
    expect(() => new Date(info.iso).toISOString()).not.toThrow();
  });
});
