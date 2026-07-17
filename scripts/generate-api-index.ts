#!/usr/bin/env tsx
/**
 * Affiliate Network API Index — draft generator.
 *
 * Builds `docs/product/api-index-draft.md`: a per-network score derived only
 * from data already committed to this repository (`network.json` manifests
 * and the presence of a `docs/findings/<slug>.md` document), so the ranking
 * is reproducible and arguable rather than editorial.
 *
 * Status: this generator produces a DRAFT ONLY. Publishing an actual ranking
 * to any public surface (website, LinkedIn, README) is a separate go/no-go
 * decision for the maintainer, per `docs/product/solo-50k-revenue-plan.md`
 * section 7 and `docs/product/solo-50k-technical-roadmap.md`'s "Content
 * engine tooling" item. Building the generator was authorised on 2026-07-12;
 * publication was not. The rendered document carries an explicit banner
 * saying so — do not remove it when regenerating.
 *
 * CLI: `npm run generate:api-index` — writes
 * `docs/product/api-index-draft.md` at the repo root.
 *
 * Determinism: identical repo state (same commit) produces byte-identical
 * output. Both the "generated at" stamp and the `now` fed into the freshness
 * check are read from the current git commit rather than the wall clock
 * (see `getGitGenerationInfo`), so re-running against an unchanged tree at a
 * later date reproduces the same file, even once an adapter's
 * `last_verified` would have aged past the freshness window in real time.
 *
 * One inherent off-by-one: when the generated draft is itself committed, the
 * stamp names the tree the draft was computed from, which is always the
 * parent of the commit that contains the draft. Checking out the stamped
 * commit and re-running the generator reproduces the draft byte for byte,
 * stamp included, because HEAD is then the stamped commit itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORTED_OPERATIONS,
  loadReportData,
  supportedOperationCount,
  type NetworkManifest,
  type NetworkReportEntry,
} from './report-data.js';
import { PROMOTED_ADAPTER_FRESHNESS_DAYS } from './validate-network-json.js';

// ---------------------------------------------------------------------------
// Scoring inputs and weights
//
// Every weight below is a named, commented constant — nothing is a hidden
// judgement call. The five components sum to 100 (enforced at module load).
// Each input is traceable to a specific file:
//   - claim_status, last_verified          -> src/networks/<slug>/network.json
//   - supported/total canonical operations -> scripts/report-data.ts (the
//                                              same counting logic REPORT.md
//                                              and README.md already use)
//   - setup_time_estimate_minutes,
//     setup_requires_approval, env_vars    -> src/networks/<slug>/network.json
//   - findings document presence           -> docs/findings/<slug>.md
// ---------------------------------------------------------------------------

/** Ordinal tier for each claim_status. Higher tier = more verified evidence,
 * per `docs/decisions/2026-06-15-adapter-promotion-gates.md`. */
export const CLAIM_STATUS_TIER: Record<NetworkManifest['claim_status'], number> = {
  unsupported: 0,
  experimental: 1,
  partial: 2,
  production: 3,
};
export const MAX_CLAIM_STATUS_TIER = 3;

/** Points out of 100 assigned to each component. Chosen so the strongest,
 * most repo-verifiable signal (verified claim status) dominates, followed by
 * how much of the canonical operation surface is actually supported. Setup
 * friction, credential-footprint simplicity, and documentation transparency
 * are real but secondary API-quality signals, so they carry less weight. */
export const CLAIM_STATUS_WEIGHT = 40;
export const OPERATION_COVERAGE_WEIGHT = 30;
export const SETUP_FRICTION_WEIGHT = 15;
export const AUTH_SIMPLICITY_WEIGHT = 10;
export const TRANSPARENCY_WEIGHT = 5;

const TOTAL_WEIGHT =
  CLAIM_STATUS_WEIGHT +
  OPERATION_COVERAGE_WEIGHT +
  SETUP_FRICTION_WEIGHT +
  AUTH_SIMPLICITY_WEIGHT +
  TRANSPARENCY_WEIGHT;
if (TOTAL_WEIGHT !== 100) {
  throw new Error(`API Index component weights must sum to 100; got ${TOTAL_WEIGHT}.`);
}

/**
 * When a `partial` or `production` claim's `last_verified` is older than
 * `PROMOTED_ADAPTER_FRESHNESS_DAYS` (imported from the accepted freshness
 * gate in `scripts/validate-network-json.ts`), the promotion-gates decision
 * says the claim is due for reconsideration, not automatic demotion. The
 * score reflects that by halving the claim-status contribution rather than
 * silently keeping full credit for stale evidence.
 */
export const FRESHNESS_STALE_FACTOR = 0.5;

/**
 * Fastest `setup_time_estimate_minutes` recorded across the current adapter
 * set (5 minutes, e.g. Awin). Used as the baseline for the setup-time
 * component so the ratio is always <= 1 for every adapter on record today;
 * a future adapter faster than this baseline would simply score full marks.
 */
export const BASELINE_SETUP_MINUTES = 5;

/** Approval-gated setup is materially slower to start using in practice, so
 * it halves the setup-friction contribution regardless of the recorded
 * estimate. */
export const APPROVAL_FRICTION_MULTIPLIER = 0.5;

/** Simplest recorded credential footprint (a single env var) across the
 * current adapter set. Used the same way as `BASELINE_SETUP_MINUTES`. */
export const MIN_ENV_VARS_BASELINE = 1;

export interface ApiIndexEntryInput {
  manifest: NetworkManifest;
  /** Whether `docs/findings/<slug>.md` exists. Passed in explicitly (rather
   * than inferred from findings text) so `scoreNetwork` stays a pure
   * function with no filesystem access. */
  hasFindingsDoc: boolean;
  supportedOps: number;
  totalOps: number;
}

export interface ApiIndexScore {
  slug: string;
  name: string;
  side: NetworkManifest['side'];
  claimStatus: NetworkManifest['claim_status'];
  freshnessStale: boolean;
  claimStatusPoints: number;
  supportedOps: number;
  totalOps: number;
  operationCoveragePoints: number;
  setupFrictionPoints: number;
  authSimplicityPoints: number;
  hasFindingsDoc: boolean;
  transparencyPoints: number;
  total: number;
}

function isStaleVerification(lastVerified: string, now: Date): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastVerified);
  if (!match) return true; // an unparsable date cannot evidence freshness
  const verified = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((today - verified) / 86_400_000);
  return ageDays > PROMOTED_ADAPTER_FRESHNESS_DAYS;
}

/**
 * Pure scoring function: given the recorded manifest facts for one network,
 * return its full score breakdown. No filesystem or git access, so it is
 * directly unit-testable against fixture manifests.
 */
export function scoreNetwork(input: ApiIndexEntryInput, now: Date = new Date()): ApiIndexScore {
  const m = input.manifest;

  const tier = CLAIM_STATUS_TIER[m.claim_status];
  const claimIsAgeSensitive = m.claim_status === 'partial' || m.claim_status === 'production';
  const freshnessStale = claimIsAgeSensitive && isStaleVerification(m.last_verified, now);
  const claimFactor = (tier / MAX_CLAIM_STATUS_TIER) * (freshnessStale ? FRESHNESS_STALE_FACTOR : 1);
  const claimStatusPoints = CLAIM_STATUS_WEIGHT * claimFactor;

  const operationCoverageFactor = input.totalOps === 0 ? 0 : input.supportedOps / input.totalOps;
  const operationCoveragePoints = OPERATION_COVERAGE_WEIGHT * operationCoverageFactor;

  const setupTimeFactor = Math.min(1, BASELINE_SETUP_MINUTES / m.setup_time_estimate_minutes);
  const approvalFactor = m.setup_requires_approval ? APPROVAL_FRICTION_MULTIPLIER : 1;
  const setupFrictionPoints = SETUP_FRICTION_WEIGHT * setupTimeFactor * approvalFactor;

  const authSimplicityFactor = Math.min(1, MIN_ENV_VARS_BASELINE / m.env_vars.length);
  const authSimplicityPoints = AUTH_SIMPLICITY_WEIGHT * authSimplicityFactor;

  const transparencyPoints = input.hasFindingsDoc ? TRANSPARENCY_WEIGHT : 0;

  const total =
    claimStatusPoints +
    operationCoveragePoints +
    setupFrictionPoints +
    authSimplicityPoints +
    transparencyPoints;

  return {
    slug: m.slug,
    name: m.name,
    side: m.side,
    claimStatus: m.claim_status,
    freshnessStale,
    claimStatusPoints,
    supportedOps: input.supportedOps,
    totalOps: input.totalOps,
    operationCoveragePoints,
    setupFrictionPoints,
    authSimplicityPoints,
    hasFindingsDoc: input.hasFindingsDoc,
    transparencyPoints,
    total,
  };
}

/**
 * Rank scores highest-first. Ties break alphabetically by name so the order
 * is stable and reproducible rather than depending on array insertion order.
 */
export function rankScores(scores: ApiIndexScore[]): ApiIndexScore[] {
  return [...scores].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function toEntryInput(entry: NetworkReportEntry, findingsDir: string): ApiIndexEntryInput {
  return {
    manifest: entry.manifest,
    hasFindingsDoc: existsSync(path.join(findingsDir, `${entry.manifest.slug}.md`)),
    supportedOps: supportedOperationCount(entry),
    totalOps: REPORTED_OPERATIONS.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const DRAFT_BANNER = [
  '> **UNPUBLISHED DRAFT — NOT FOR PUBLIC USE.**',
  '>',
  '> This is an internal, reproducible draft of the quarterly Affiliate Network',
  '> API Index described in `docs/product/solo-50k-revenue-plan.md` (section 7)',
  '> and `docs/product/solo-50k-technical-roadmap.md` ("Content engine',
  '> tooling"). Rob authorised building this GENERATOR on 2026-07-12.',
  '> Publishing an actual ranking to any public surface (website, LinkedIn,',
  '> README, press) is a separate go/no-go decision that has not been made.',
  '> Do not share, quote, or publish this document, or any ranking derived',
  '> from it, without that explicit maintainer decision.',
].join('\n');

export interface RenderApiIndexOptions {
  /** ISO 8601 timestamp of the commit the draft was generated from. */
  generatedAtIso: string;
  /** Short commit SHA the draft was generated from. */
  gitSha: string;
}

function formatPoints(value: number): string {
  return value.toFixed(1);
}

function renderMethodology(): string {
  return [
    '## Methodology',
    '',
    'Every score is computed only from data already committed to this repository:',
    "each network's `src/networks/<slug>/network.json` manifest and whether",
    '`docs/findings/<slug>.md` exists. No live account data, no editorial',
    'judgement, and no input that cannot be pointed at a specific file.',
    '',
    'The score is five weighted components summing to 100:',
    '',
    `1. **Claim status (${CLAIM_STATUS_WEIGHT} pts)** — \`claim_status\` maps to a tier`,
    '   (`unsupported`=0, `experimental`=1, `partial`=2, `production`=3, per',
    '   `docs/decisions/2026-06-15-adapter-promotion-gates.md`), scaled to',
    `   ${CLAIM_STATUS_WEIGHT} points as \`tier / ${MAX_CLAIM_STATUS_TIER}\`. If the claim is`,
    "   `partial` or `production` and `last_verified` is older than",
    `   ${PROMOTED_ADAPTER_FRESHNESS_DAYS} days (the same freshness window`,
    '   `scripts/validate-network-json.ts` enforces), the contribution is halved',
    `   (a factor of ${FRESHNESS_STALE_FACTOR}) rather than left at full credit for stale`,
    '   evidence. Staleness is judged as of the stamped commit date, not the',
    '   wall clock, so identical repo state always scores identically.',
    `2. **Operation coverage (${OPERATION_COVERAGE_WEIGHT} pts)** — the count of the seven`,
    '   canonical publisher operations the adapter supports (the same count',
    '   `REPORT.md` and `README.md` already publish), as a share of seven,',
    `   scaled to ${OPERATION_COVERAGE_WEIGHT} points. Advertiser-side adapters are`,
    '   counted against the same seven canonical publisher operations,',
    "   consistent with `REPORT.md`'s counting; an advertiser adapter whose",
    '   surface maps poorly onto that set will under-score on this component',
    '   until a side-specific canonical operation set is recorded.',
    `3. **Setup friction (${SETUP_FRICTION_WEIGHT} pts)** — \`setup_time_estimate_minutes\` is`,
    `   compared against the fastest recorded setup (${BASELINE_SETUP_MINUTES} minutes) as`,
    `   \`${BASELINE_SETUP_MINUTES} / setup_time_estimate_minutes\` (capped at 1), then halved`,
    '   (`×0.5`) if `setup_requires_approval` is true, then scaled to',
    `   ${SETUP_FRICTION_WEIGHT} points.`,
    `4. **Credential simplicity (${AUTH_SIMPLICITY_WEIGHT} pts)** — the count of`,
    `   \`env_vars\` compared against the simplest recorded footprint`,
    `   (${MIN_ENV_VARS_BASELINE} variable) as \`${MIN_ENV_VARS_BASELINE} / env_vars.length\` (capped at 1),`,
    `   scaled to ${AUTH_SIMPLICITY_WEIGHT} points.`,
    `5. **Documentation transparency (${TRANSPARENCY_WEIGHT} pts)** — the full`,
    `   ${TRANSPARENCY_WEIGHT} points if \`docs/findings/<slug>.md\` exists for the`,
    '   network, otherwise 0.',
    '',
    'Deliberately excluded: API-backed vs browser-driven operation share, and',
    'any per-operation auth-complexity detail beyond credential count. Neither',
    'is recorded consistently enough across all current `network.json`',
    'manifests to score fairly; adding either requires first recording the',
    'signal in the manifest schema, not inventing it at generation time.',
    '',
    'Source: `scripts/generate-api-index.ts`, function `scoreNetwork`. Run',
    '`npm run generate:api-index` to reproduce this document from the current',
    'tree.',
  ].join('\n');
}

export function renderApiIndexDraft(
  scores: ApiIndexScore[],
  options: RenderApiIndexOptions,
): string {
  const ranked = rankScores(scores);
  const lines: string[] = [];

  lines.push(DRAFT_BANNER);
  lines.push('');
  lines.push('# Affiliate Network API Index (draft)');
  lines.push('');
  lines.push(
    '_Status: Generated draft, per the `docs/README.md` rule that generated' +
      ' outputs stay distinguished from source material. Produced by' +
      ' `scripts/generate-api-index.ts`; do not hand-edit the ranking below._',
  );
  lines.push('');
  lines.push(
    `_Generated from commit \`${options.gitSha}\` (${options.generatedAtIso}). Regenerate with` +
      ' `npm run generate:api-index`._',
  );
  lines.push('');
  lines.push(renderMethodology());
  lines.push('');
  lines.push('## Ranking');
  lines.push('');
  lines.push(
    '| Rank | Network | Side | Score / 100 | Claim status | Ops supported | Setup friction pts | Credential simplicity pts | Findings doc |',
  );
  lines.push('| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | --- |');
  ranked.forEach((score, index) => {
    const claimCell = score.freshnessStale ? `${score.claimStatus} (stale evidence)` : score.claimStatus;
    lines.push(
      `| ${index + 1} | ${score.name} | ${score.side} | ${formatPoints(score.total)} | ${claimCell} | ${score.supportedOps} / ${score.totalOps} | ${formatPoints(score.setupFrictionPoints)} | ${formatPoints(score.authSimplicityPoints)} | ${score.hasFindingsDoc ? 'yes' : 'no'} |`,
    );
  });
  lines.push('');
  lines.push('## Reproducing this draft');
  lines.push('');
  lines.push('```');
  lines.push('npm install');
  lines.push('npm run generate:api-index');
  lines.push('```');
  lines.push('');
  lines.push(
    'The script reads every `src/networks/<slug>/network.json` and checks for a',
  );
  lines.push(
    'matching `docs/findings/<slug>.md`; it makes no network calls and reads no',
  );
  lines.push('live account data.');
  lines.push('');
  lines.push(DRAFT_BANNER);

  return lines.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Reads the generation timestamp from the current git commit rather than the
 * wall clock. The CLI uses this same timestamp as `now` for the freshness
 * check, so re-running the generator against an unchanged tree at a
 * different moment in time produces byte-identical output; a `last_verified`
 * date crossing the freshness boundary in real time changes nothing until a
 * new commit changes HEAD.
 */
export function getGitGenerationInfo(repoRoot: string): { sha: string; iso: string } {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const iso = execFileSync('git', ['log', '-1', '--format=%cI'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (!sha || !iso) {
    throw new Error('git did not return commit metadata; refusing to hand-type a generation timestamp.');
  }
  return { sha, iso };
}

async function runCli(): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const findingsDir = path.join(repoRoot, 'docs', 'findings');
  const data = loadReportData({ repoRoot });
  const { sha, iso } = getGitGenerationInfo(repoRoot);

  // Derive `now` from the commit date, not the wall clock, so identical repo
  // state produces byte-identical output even on the day an adapter's
  // last_verified would cross the freshness boundary in real time.
  const now = new Date(iso);

  const scores = data.networks.map((entry) =>
    scoreNetwork(toEntryInput(entry, findingsDir), now),
  );

  const body = renderApiIndexDraft(scores, { generatedAtIso: iso, gitSha: sha });
  const outPath = path.join(repoRoot, 'docs', 'product', 'api-index-draft.md');
  writeFileSync(outPath, body, 'utf8');
  process.stderr.write(`Wrote ${outPath} (${body.length} bytes, ${scores.length} networks).\n`);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('generate-api-index.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`generate-api-index fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
