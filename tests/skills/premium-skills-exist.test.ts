/**
 * Premium skill pack structural test.
 *
 * Mirrors `skills-exist.test.ts` for the content under `premium-skills/` — the
 * paid, maintained skill packs described in
 * `docs/decisions/2026-07-01-desktop-premium-skill-packs.md`. This tree is
 * deliberately a sibling of `skills/`, not a subdirectory: it is kept out of
 * `package.json`'s `files` array and out of the Claude plugin manifest's
 * auto-discovery of `skills/`, so it never ships in the free npm package or
 * plugin bundle. Wiring it into the desktop app's "pick" flow, premium shelf,
 * and entitlement gate is separate, later work.
 *
 * Same proxy as the free-skill test: each SKILL.md exists, has valid
 * frontmatter (name + description), the description quotes at least one
 * trigger phrase, every cited `affiliate_*` tool actually exists in the
 * generator's output, and there is at least one worked example.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/networks/index.js';
import { generateAllTools } from '../../src/tools/generate.js';

const here = dirname(fileURLToPath(import.meta.url));
const premiumRoot = join(here, '..', '..', 'premium-skills');

/** One entry per premium skill: which pack folder it lives under. */
const PREMIUM_SKILLS = [
  { pack: 'agency-pack', slug: 'qbr-prep' },
  { pack: 'agency-pack', slug: 'client-weekly-report' },
  { pack: 'agency-pack', slug: 'portfolio-rollup' },
  { pack: 'publisher-money-pack', slug: 'unpaid-commission-chaser' },
  { pack: 'publisher-money-pack', slug: 'earnings-rollup' },
  { pack: 'publisher-money-pack', slug: 'reversal-investigation' },
] as const;

/** Crude but adequate YAML frontmatter parser — captures the leading `---` block. */
function parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { body: text };
  const yaml = match[1] ?? '';
  const body = match[2] ?? '';

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

// Same tool-name matcher as skills-exist.test.ts: network slugs include
// hyphens (e.g. `impact-advertiser`), so the character class allows them.
const TOOL_NAME_RE = /affiliate_[a-z][a-z0-9_<>-]*[a-z0-9]/g;

function isPlaceholder(name: string): boolean {
  return /<[^>]+>/.test(name);
}

describe('premium skill packs (docs/decisions/2026-07-01-desktop-premium-skill-packs.md)', () => {
  const realToolNames = new Set(generateAllTools().map((t) => t.name));

  for (const { pack, slug } of PREMIUM_SKILLS) {
    describe(`${pack}/${slug}`, () => {
      const skillDir = join(premiumRoot, pack, slug);
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

// Guard against drift the same way skills-exist.test.ts guards `skills/`:
// a pack folder on disk not listed above ships unvalidated; a listed skill
// missing from disk means the premium shelf would offer nothing.
describe('shipped premium pack set matches the validated set', () => {
  it('every premium-skills/<pack>/<slug> with a SKILL.md is covered above, and vice versa', () => {
    const onDisk: Array<{ pack: string; slug: string }> = [];
    for (const packEntry of readdirSync(premiumRoot, { withFileTypes: true })) {
      if (!packEntry.isDirectory()) continue;
      const packDir = join(premiumRoot, packEntry.name);
      for (const skillEntry of readdirSync(packDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue;
        if (existsSync(join(packDir, skillEntry.name, 'SKILL.md'))) {
          onDisk.push({ pack: packEntry.name, slug: skillEntry.name });
        }
      }
    }
    const normalise = (list: ReadonlyArray<{ pack: string; slug: string }>) =>
      list.map((e) => `${e.pack}/${e.slug}`).sort();

    expect(
      normalise(onDisk),
      'premium-skills/ drifted from the validated set: a pack skill on disk is not ' +
        'listed in PREMIUM_SKILLS (so it ships unvalidated), or a validated skill is ' +
        'missing from disk.',
    ).toEqual(normalise(PREMIUM_SKILLS));
  });
});
