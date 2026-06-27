/**
 * Skill execution sanity test (PRD §15.21).
 *
 * We can't actually invoke a skill from a unit test — skills run inside a
 * model conversation. The proxy: each SKILL.md exists, has a valid frontmatter
 * (name + description), the description quotes at least one trigger phrase,
 * and the body grounds itself in real `affiliate_*` tool names that this
 * server actually exposes.
 *
 * Also covers PRD §15.17 — the setup-help skill has a documented fallback
 * path when `docs/networks/<slug>.md` is missing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/networks/index.js';
import { generateAllTools } from '../../src/tools/generate.js';

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, '..', '..', 'skills');

const SKILLS = [
  'audit-affiliate-links',
  'affiliate-earnings-report',
  'affiliate-network-status',
  'affiliate-network-setup-help',
  'chase-unpaid-commissions',
] as const;

// Agency-side skills (PR 4). Same tests apply; plus tool-name validation
// against the generator's actual output.
const AGENCY_SKILLS = [
  'programme-performance-report',
  'publisher-performance-review',
  'programme-reversal-report',
  'agency-portfolio-rollup',
  'programme-anomaly-watch',
  'client-onboarding',
  'partner-roster-audit',
  'partner-application-queue',
  'awin-application-auto-approval',
  'programme-health-check',
  'partner-outreach',
  'brand-application-shortlist',
  'awin-apply-to-programmes',
] as const;

/** Crude but adequate YAML frontmatter parser — captures the leading `---` block. */
function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { body: text };
  const yaml = match[1] ?? '';
  const body = match[2] ?? '';

  // Walk line by line. A top-level YAML key is `<name>:` at column 0 with no
  // leading whitespace. Multiline scalars (`description: |`) are indented.
  const lines = yaml.split('\n');
  const entries: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const topLevel = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(\|?)\s*(.*)$/);
    if (!topLevel) {
      i += 1;
      continue;
    }
    const [, key = '', pipe = '', inline = ''] = topLevel;
    if (pipe === '|') {
      // Consume indented lines until we hit a non-indented line.
      i += 1;
      const buf: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (next.length === 0 || /^\s/.test(next)) {
          buf.push(next.replace(/^\s{2}/, ''));
          i += 1;
        } else {
          break;
        }
      }
      entries[key] = buf.join('\n').trim();
    } else {
      entries[key] = inline.trim();
      i += 1;
    }
  }

  return { name: entries['name'], description: entries['description'], body };
}

describe('publisher skills (PRD §15.21)', () => {
  for (const slug of SKILLS) {
    describe(slug, () => {
      const skillDir = join(skillsRoot, slug);
      const skillPath = join(skillDir, 'SKILL.md');

      it('SKILL.md exists', () => {
        expect(existsSync(skillPath), `expected ${skillPath} to exist`).toBe(true);
      });

      it('has valid frontmatter with name + description', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { name, description } = parseFrontmatter(content);
        expect(name).toBe(slug);
        expect(description, 'description must be present').toBeTruthy();
        expect(description!.length).toBeGreaterThan(20);
      });

      it('description quotes at least one trigger phrase', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { description } = parseFrontmatter(content);
        // A quoted trigger phrase: any "..." substring with at least 3 words inside.
        const triggerMatches = description!.match(/"[^"]{8,}"/g) ?? [];
        expect(
          triggerMatches.length,
          `expected at least one quoted trigger phrase in description; got: ${description}`,
        ).toBeGreaterThanOrEqual(1);
      });

      it('body references at least one affiliate_* tool name', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { body } = parseFrontmatter(content);
        // Match `affiliate_<something>` mentions — backticked, plain, or with placeholders.
        const toolMatches = body.match(/affiliate_[a-z_<>]+/g) ?? [];
        expect(
          toolMatches.length,
          `expected at least one affiliate_* tool mention in ${slug} body`,
        ).toBeGreaterThanOrEqual(1);
      });

      it('has at least one example file', () => {
        const examplesDir = join(skillDir, 'examples');
        expect(existsSync(examplesDir), `expected ${examplesDir} to exist`).toBe(true);
        const entries = readdirSync(examplesDir).filter((f) => f.endsWith('.md'));
        expect(
          entries.length,
          `expected at least one example markdown in ${examplesDir}`,
        ).toBeGreaterThanOrEqual(1);
      });
    });
  }

  it('setup-help skill documents a fallback when docs/networks/<slug>.md is missing (PRD §15.17)', () => {
    const content = readFileSync(
      join(skillsRoot, 'affiliate-network-setup-help', 'SKILL.md'),
      'utf8',
    );
    // The skill body must mention setupSteps() (the fallback) AND docs/networks/.
    expect(content).toMatch(/docs\/networks\//);
    expect(content).toMatch(/setupSteps\(\)/);
    // It must reference the wizard command.
    expect(content).toMatch(/affiliate-networks-mcp setup/);
  });

  it('setup-help skill names every supported network with its env vars (PRD §15.17)', () => {
    const content = readFileSync(
      join(skillsRoot, 'affiliate-network-setup-help', 'SKILL.md'),
      'utf8',
    );
    for (const envVar of [
      'AWIN_API_TOKEN',
      'AWIN_PUBLISHER_ID',
      'CJ_API_TOKEN',
      'IMPACT_ACCOUNT_SID',
      'IMPACT_AUTH_TOKEN',
      'RAKUTEN_CLIENT_ID',
      'RAKUTEN_CLIENT_SECRET',
      'RAKUTEN_SID',
    ]) {
      expect(content, `expected env var ${envVar} to appear in setup-help skill`).toMatch(envVar);
    }
  });
});

// Match every `affiliate_*` mention. Network slugs include hyphens
// (e.g. `impact-advertiser`), so the character class allows `[a-z_<>-]`.
// The trailing `[a-z_]` boundary stops the match before adjacent punctuation
// (a closing backtick, comma, full stop, etc.) leaks into the captured name.
const TOOL_NAME_RE = /affiliate_[a-z][a-z0-9_<>-]*[a-z0-9]/g;

/**
 * Tool names cited in skill bodies that aren't expected to resolve to a real
 * tool because they're network-slug placeholders (e.g. `affiliate_<slug>_…`).
 * The runtime skills are written with these so they generalise across all
 * registered networks; the validator below strips them out before comparing
 * against the real tool registry.
 */
function isPlaceholder(name: string): boolean {
  return /<[^>]+>/.test(name);
}

describe('agency-side skills (PR 4)', () => {
  const realToolNames = new Set(generateAllTools().map((t) => t.name));

  for (const slug of AGENCY_SKILLS) {
    describe(slug, () => {
      const skillDir = join(skillsRoot, slug);
      const skillPath = join(skillDir, 'SKILL.md');

      it('SKILL.md exists', () => {
        expect(existsSync(skillPath), `expected ${skillPath} to exist`).toBe(true);
      });

      it('has valid frontmatter with name + description', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { name, description } = parseFrontmatter(content);
        expect(name).toBe(slug);
        expect(description, 'description must be present').toBeTruthy();
        expect(description!.length).toBeGreaterThan(20);
      });

      it('description quotes at least one trigger phrase', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { description } = parseFrontmatter(content);
        const triggerMatches = description!.match(/"[^"]{8,}"/g) ?? [];
        expect(
          triggerMatches.length,
          `expected at least one quoted trigger phrase in description; got: ${description}`,
        ).toBeGreaterThanOrEqual(1);
      });

      it('every cited affiliate_* tool actually exists in the registry', () => {
        const content = readFileSync(skillPath, 'utf8');
        const { body } = parseFrontmatter(content);
        const cited = (body.match(TOOL_NAME_RE) ?? []).filter((n) => !isPlaceholder(n));
        expect(cited.length, `expected ${slug} to cite at least one tool`).toBeGreaterThan(0);
        const unknown = cited.filter((n) => !realToolNames.has(n));
        expect(
          unknown,
          `${slug} cites tools the generator does not produce: ${unknown.join(', ')}`,
        ).toEqual([]);
      });

      it('has at least one example file', () => {
        const examplesDir = join(skillDir, 'examples');
        expect(existsSync(examplesDir), `expected ${examplesDir} to exist`).toBe(true);
        const entries = readdirSync(examplesDir).filter((f) => f.endsWith('.md'));
        expect(
          entries.length,
          `expected at least one example markdown in ${examplesDir}`,
        ).toBeGreaterThanOrEqual(1);
      });
    });
  }
});

// The two lists above (SKILLS + AGENCY_SKILLS) are exactly what every user
// receives: plugin.json auto-discovers them from `skills/`, so they ship with
// the plugin install. This guard pins the shipped set to the validated set.
// Adding a skill folder without registering it here (so it goes unvalidated),
// or losing one from disk, fails the build instead of silently changing what
// users get.
describe('shipped skill set matches the validated set', () => {
  it('every skills/ subdirectory with a SKILL.md is covered above, and vice versa', () => {
    const onDisk = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md')))
      .sort();
    const validated = [...SKILLS, ...AGENCY_SKILLS].sort();
    expect(
      onDisk,
      'skills/ drifted from the validated set: a skill on disk is not listed in ' +
        'SKILLS/AGENCY_SKILLS (so it ships unvalidated), or a validated skill is ' +
        'missing from disk (so users would not receive it).',
    ).toEqual(validated);
  });
});
