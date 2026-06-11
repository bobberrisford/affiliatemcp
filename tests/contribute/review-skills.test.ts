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
  });

  it('review skill separates blockers from follow-ups and supports CI repair', () => {
    const content = readFileSync(
      join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
      'utf8',
    );
    expect(content).toMatch(/blocking/);
    expect(content).toMatch(/follow-up/);
    expect(content).toMatch(/When asked to fix or unblock the PR/i);
    expect(content).toMatch(/Re-review/);
  });

  it('delivery steward advances work but keeps a human merge gate', () => {
    const content = readFileSync(
      join(repoRoot, '.claude', 'skills', 'delivery-steward', 'SKILL.md'),
      'utf8',
    );
    expect(content).toMatch(/repair branch/i);
    expect(content).toMatch(/Preserve its remote branch/i);
    expect(content).toMatch(/Do not merge until the user explicitly approves/i);
    expect(content).toMatch(/Refresh branches just in time/i);
  });
});
