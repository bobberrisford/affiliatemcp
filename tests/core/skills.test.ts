/**
 * Tests for the skills catalogue + local deploy core (src/core/skills.ts).
 *
 * Uses a sandboxed source tree (a tmp dir of fake SKILL.md folders) and a
 * sandboxed install dir, so it never reads the real skills/ tree or writes to
 * ~/.claude. Frontmatter parsing, trigger extraction, side detection, sorting,
 * idempotent install, and the unknown-slug error are all covered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  installSkills,
  listSkills,
  parseSkillFrontmatter,
} from '../../src/core/skills.js';

let srcDir: string;
let destDir: string;

function writeSkill(root: string, slug: string, frontmatter: string, body = '# body\n'): void {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf8');
}

beforeEach(() => {
  srcDir = mkdtempSync(path.join(tmpdir(), 'amcp-skills-src-'));
  destDir = mkdtempSync(path.join(tmpdir(), 'amcp-skills-dest-'));
});

afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(destDir, { recursive: true, force: true });
});

describe('parseSkillFrontmatter', () => {
  it('captures inline keys and multiline block scalars', () => {
    const { fields, body } = parseSkillFrontmatter(
      '---\nname: demo\nside: publisher\ndescription: |\n  Line one.\n  Trigger on: "do the thing".\n---\n\n# Instructions\n',
    );
    expect(fields['name']).toBe('demo');
    expect(fields['side']).toBe('publisher');
    expect(fields['description']).toContain('Line one.');
    expect(fields['description']).toContain('do the thing');
    expect(body).toContain('# Instructions');
  });

  it('returns empty fields when there is no frontmatter', () => {
    const { fields, body } = parseSkillFrontmatter('# just a heading\n');
    expect(fields).toEqual({});
    expect(body).toContain('# just a heading');
  });
});

describe('listSkills', () => {
  it('summarises each skill, extracts the trigger, detects side, sorts by name', () => {
    writeSkill(
      srcDir,
      'zeta-report',
      'name: zeta-report\ndescription: |\n  Does zeta things.\n  Trigger on: "run the zeta report".',
    );
    writeSkill(
      srcDir,
      'alpha-rollup',
      'name: alpha-rollup\nside: agency\ndescription: |\n  Agency rollup.\n  Trigger on: "show the whole book".',
    );

    const skills = listSkills({ skillsDir: srcDir });

    expect(skills.map((s) => s.slug)).toEqual(['alpha-rollup', 'zeta-report']); // sorted by name
    const alpha = skills[0]!;
    expect(alpha.name).toBe('alpha-rollup');
    expect(alpha.side).toBe('agency');
    expect(alpha.trigger).toBe('show the whole book');
    const zeta = skills[1]!;
    expect(zeta.side).toBeUndefined(); // no side declared -> shown for everyone
    expect(zeta.trigger).toBe('run the zeta report');
  });

  it('ignores non-directories and folders without a SKILL.md', () => {
    writeSkill(srcDir, 'real', 'name: real\ndescription: |\n  Real skill.\n  Trigger on: "do real work".');
    mkdirSync(path.join(srcDir, 'empty-folder'), { recursive: true });
    writeFileSync(path.join(srcDir, 'stray-file.md'), 'not a skill', 'utf8');

    const skills = listSkills({ skillsDir: srcDir });
    expect(skills.map((s) => s.slug)).toEqual(['real']);
  });

  it('returns [] when the skills directory is absent', () => {
    expect(listSkills({ skillsDir: path.join(srcDir, 'does-not-exist') })).toEqual([]);
  });
});

describe('installSkills', () => {
  beforeEach(() => {
    writeSkill(srcDir, 'earnings', 'name: earnings\ndescription: |\n  Earnings.\n  Trigger on: "show earnings".');
    writeSkill(srcDir, 'health', 'name: health\ndescription: |\n  Health.\n  Trigger on: "check health".');
  });

  it('copies selected skills into the install dir', () => {
    const res = installSkills(['earnings', 'health'], { skillsDir: srcDir, installDir: destDir });
    expect(res.ok).toBe(true);
    expect(res.installed.sort()).toEqual(['earnings', 'health']);
    expect(res.skipped).toEqual([]);
    expect(existsSync(path.join(destDir, 'earnings', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(destDir, 'health', 'SKILL.md'))).toBe(true);
  });

  it('is idempotent — a re-run skips already-present skills', () => {
    installSkills(['earnings'], { skillsDir: srcDir, installDir: destDir });
    const res = installSkills(['earnings', 'health'], { skillsDir: srcDir, installDir: destDir });
    expect(res.installed).toEqual(['health']);
    expect(res.skipped).toEqual(['earnings']);
  });

  it('throws on an unknown slug rather than installing nothing silently', () => {
    expect(() => installSkills(['nope'], { skillsDir: srcDir, installDir: destDir })).toThrow(
      /Unknown skill "nope"/,
    );
  });
});
