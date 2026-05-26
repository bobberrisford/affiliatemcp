/**
 * Contribute skill structural test (PRD §15.28).
 *
 * The skill at `.claude/skills/contribute/SKILL.md` is what auto-loads when a
 * contributor opens the repo in Claude Code. The test bar:
 *
 *   1. The file exists with valid YAML frontmatter (name + description).
 *   2. It mentions all five contribution tasks.
 *   3. Every file path it cites exists on disk.
 *   4. Every npm script it names is declared in package.json.
 *
 * Live verification (a fresh Claude Code session running through the skill to
 * add a real network) is §15.31 and is deferred to an orchestrator-level test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const skillPath = join(repoRoot, '.claude', 'skills', 'contribute', 'SKILL.md');

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

describe('contribute skill (PRD §15.28)', () => {
  it('SKILL.md exists at .claude/skills/contribute/', () => {
    expect(existsSync(skillPath), `expected ${skillPath} to exist`).toBe(true);
  });

  it('has valid frontmatter with name + description', () => {
    const content = readFileSync(skillPath, 'utf8');
    const { name, description } = parseFrontmatter(content);
    expect(name).toBe('contribute-to-affiliate-mcp');
    expect(description, 'description must be present').toBeTruthy();
    expect(description!.length).toBeGreaterThan(50);
  });

  it('description quotes at least one trigger phrase', () => {
    const content = readFileSync(skillPath, 'utf8');
    const { description } = parseFrontmatter(content);
    const triggers = description!.match(/"[^"]{6,}"/g) ?? [];
    expect(
      triggers.length,
      `expected at least one quoted trigger phrase in description; got: ${description}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('mentions all five contribution tasks', () => {
    const content = readFileSync(skillPath, 'utf8');
    // The five tasks named in the task brief / PRD §14.2.
    const tasks = [
      /add a new network adapter/i,
      /fix an existing network adapter/i,
      /add a Claude Code skill/i,
      /(improve|setup) documentation/i,
      /finding/i,
    ];
    for (const re of tasks) {
      expect(content, `expected SKILL.md to mention task matching ${re}`).toMatch(re);
    }
  });

  it('every file path it references exists on disk', () => {
    const content = readFileSync(skillPath, 'utf8');
    const withoutFences = content.replace(/```[\s\S]*?```/g, '');
    // Require at least one slash so bare filenames like `auth.ts` (generic
    // references) are exempt; we only verify paths that look literal.
    const pathRegex = /(?<![\w./])([a-zA-Z0-9_][a-zA-Z0-9_./-]*\/[a-zA-Z0-9_.-]+\.(?:ts|tsx|md|json|cjs|js))(?![\w])/g;
    const matches = withoutFences.match(pathRegex) ?? [];
    const missing: string[] = [];
    for (const raw of matches) {
      if (raw.includes('://')) continue;
      if (raw.includes('<') || raw.includes('>')) continue;
      if (raw === 'CONTRIBUTING.md') continue;
      if (raw === 'CODEOWNERS') continue;
      if (raw === 'PR.md') continue;
      const candidate = join(repoRoot, raw);
      if (!existsSync(candidate)) missing.push(raw);
    }
    expect(
      missing,
      `SKILL.md references file paths that do not exist:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every `npm run <script>` it names is declared in package.json', () => {
    const content = readFileSync(skillPath, 'utf8');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.scripts ?? {}));
    const scriptRegex = /npm run\s+([a-zA-Z][a-zA-Z0-9:_-]*)/g;
    const unknown: string[] = [];
    for (const m of content.matchAll(scriptRegex)) {
      const name = m[1];
      if (!name) continue;
      if (!declared.has(name)) unknown.push(name);
    }
    expect(
      unknown,
      `SKILL.md cites npm scripts not declared in package.json: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('references AGENTS.md as a prerequisite read', () => {
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/AGENTS\.md/);
  });

  it('names src/shared/types.ts and the Awin reference', () => {
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/src\/shared\/types\.ts/);
    expect(content).toMatch(/src\/networks\/awin\/adapter\.ts/);
  });

  it('includes a closing checklist', () => {
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/checklist/i);
    expect(content).toMatch(/\[ ?\]/); // contains markdown checkboxes
  });
});
