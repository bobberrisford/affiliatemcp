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

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(here, '..', '..', 'src', 'skills');

const SKILLS = [
  'audit-affiliate-links',
  'affiliate-earnings-report',
  'affiliate-network-status',
  'affiliate-network-setup-help',
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
    expect(content).toMatch(/affiliate-mcp setup/);
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
