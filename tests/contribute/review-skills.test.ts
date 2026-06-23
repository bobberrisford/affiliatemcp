import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const REVIEW_SKILLS = ['delivery-steward', 'prepare-for-review', 'review-pr'] as const;

describe('collaboration review skills', () => {
  for (const skill of REVIEW_SKILLS) {
    const claudePath = join(repoRoot, '.claude', 'skills', skill, 'SKILL.md');
    const agentsPath = join(repoRoot, '.agents', 'skills', skill);

    it(`${skill} has a canonical Claude skill`, () => {
      expect(existsSync(claudePath), `expected ${claudePath}`).toBe(true);
      const content = readFileSync(claudePath, 'utf8');
      expect(content).toMatch(new RegExp(`name:\\s*${skill}`));
      expect(content).toMatch(/description:/);
    });

    it(`${skill} is exposed to Codex by relative symlink`, () => {
      expect(lstatSync(agentsPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(agentsPath)).toBe(`../../.claude/skills/${skill}`);
    });
  }

  it('preparation owns CI failures and records uncertainty', () => {
    const content = readFileSync(
      join(repoRoot, '.claude', 'skills', 'prepare-for-review', 'SKILL.md'),
      'utf8',
    );
    expect(content).toMatch(/coding agent owns failures caused by its branch/i);
    expect(content).toMatch(/npm run check:change/);
    expect(content).toMatch(/request re-review/i);
    expect(content).toMatch(/queued-risk/i);
    expect(content).toMatch(/two routine PRs/i);
    expect(content).toMatch(/disposable prototype/i);
  });

  it('review skill covers product clarity, docs, severity, and CI repair', () => {
    const content = readFileSync(
      join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
      'utf8',
    );
    expect(content).toMatch(/customer journey/i);
    expect(content).toMatch(/documentation accuracy/i);
    expect(content).toMatch(/blocker/);
    expect(content).toMatch(/important/);
    expect(content).toMatch(/suggestion/);
    expect(content).toMatch(/follow-up ticket/);
    expect(content).toMatch(/When asked to fix or unblock the PR/i);
    expect(content).toMatch(/Re-review/);
    expect(content).toMatch(/sequencing blocker/i);
    expect(content).toMatch(/Delivery-system learning/i);
  });

  it('delivery steward covers implementation and keeps human decision gates', () => {
    const content = readFileSync(
      join(repoRoot, '.claude', 'skills', 'delivery-steward', 'SKILL.md'),
      'utf8',
    );
    expect(content).toMatch(/customer journey/i);
    expect(content).toMatch(/smallest coherent change/i);
    expect(content).toMatch(/Assumptions can evolve/i);
    expect(content).toMatch(/Othman steers\s+technical architecture/i);
    expect(content).toMatch(/Rob steers affiliate-domain\s+truth/i);
    expect(content).toMatch(/repair branch/i);
    expect(content).toMatch(/Preserve its remote branch/i);
    expect(content).toMatch(/Do not merge until the user explicitly approves/i);
    expect(content).toMatch(/Refresh branches just in time/i);
    expect(content).toMatch(/active-risk/i);
    expect(content).toMatch(/at most two decision-complete/i);
    expect(content).toMatch(/Delivery-system learning/i);
  });

  it('documents canonical governance for Claude and Codex', () => {
    const content = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
    expect(content).toMatch(/\.claude\/skills\/.*canonical source/i);
    expect(content).toMatch(/\.agents\/skills\/[\s\S]*relative symlinks/i);
    expect(content).toMatch(/Evolve an existing skill/i);
    expect(content).toMatch(/active-risk[\s\S]*at most one/i);
    expect(content).toMatch(/routine[\s\S]*at most two/i);
    expect(content).toMatch(/Draft status controls[\s\S]*does not authorise/i);
    expect(content).toMatch(/every[\s\S]*merge requires explicit human approval/i);
    expect(content).toMatch(/Delivery-system learning/i);

    const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/@AGENTS\.md/);
    expect(claude).toMatch(/delivery-steward/);
    expect(claude).toMatch(/Do not build production foundations/i);
    expect(claude).toMatch(/at\s+most two routine lanes/i);
    expect(claude).toMatch(/delivery-system lesson/i);
  });

  it('keeps default PR templates aligned with delivery fields', () => {
    const defaultTemplate = readFileSync(
      join(repoRoot, '.github', 'PULL_REQUEST_TEMPLATE', 'default.md'),
      'utf8',
    );
    const githubDefault = readFileSync(
      join(repoRoot, '.github', 'pull_request_template.md'),
      'utf8',
    );
    expect(githubDefault).toBe(defaultTemplate);
    expect(defaultTemplate).toMatch(/Dependency graph and merge order/i);
    expect(defaultTemplate).toMatch(/Semantic conflict domains/i);
    expect(defaultTemplate).toMatch(/Optional delivery-system learning/i);
  });
});
