/**
 * affiliate-mcp — skills catalogue + local deployment.
 *
 * The bundled `skills/` tree is the product's workflow layer: ready-made
 * playbooks a user invokes in plain English. The desktop app (and any future
 * GUI) deploys selected skills into the detected client's on-disk skills
 * directory. This module is the prompter-free, IPC-safe core the facade
 * re-exports.
 *
 * Design constraints honoured here:
 *   - Local-first, no network (D4). Deploy is a local file copy, mirroring the
 *     env/config writes; nothing is fetched from a registry.
 *   - Everything crossing the IPC boundary is a plain, structured-clone-safe
 *     shape (no functions).
 *   - Idempotent install: an already-present skill is skipped, never
 *     duplicated, matching the atomic-backup spirit of the config write.
 *   - UK spelling in user-facing strings.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public DTOs — plain shapes only.
// ---------------------------------------------------------------------------

export type SkillSide = 'publisher' | 'brand' | 'agency';

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  /** First quoted trigger phrase from the description, for the done-screen prompt. */
  trigger?: string;
  /**
   * The product side this skill needs, when the SKILL.md declares one. Absent
   * means the skill applies regardless of configured side; the GUI shows such
   * skills for everyone. When present, the GUI can grey the skill with a reason
   * rather than silently dropping it (never hide a capability).
   */
  side?: SkillSide;
}

export interface InstallSkillsResult {
  ok: true;
  /** Slugs whose folders were copied this call. */
  installed: string[];
  /** Slugs already present at the target, left untouched. */
  skipped: string[];
  /** Absolute directory the skills were written to. */
  targetDir: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Where the bundled `skills/` tree lives. Honours `AFFILIATE_MCP_SKILLS_DIR`
 * (tests and the packaged desktop app set it to the resources copy). Otherwise
 * falls back to `skills/` under the current working directory (the repo root
 * for a CLI run). The desktop layer always passes an explicit dir, and tests
 * set the env or pass `skillsDir`, so this bare-cwd default is only a last
 * resort — deliberately avoiding `import.meta.url`, which does not survive the
 * CJS bundle the desktop ships.
 */
export function resolveBundledSkillsDir(): string {
  const override = process.env['AFFILIATE_MCP_SKILLS_DIR'];
  if (override && override.trim() !== '') return override;
  return path.resolve(process.cwd(), 'skills');
}

/**
 * Where a client reads personal skills from. Honours
 * `AFFILIATE_MCP_SKILLS_INSTALL_DIR` (tests, and the desktop app once it has
 * resolved the detected client's location). Default `~/.claude/skills` is
 * confirmed for Claude Code and personal Cowork. Claude Desktop's on-disk skill
 * location is unconfirmed (see the skill-deployment decision); the desktop app
 * passes an explicit dir, or falls back to an export path, for that client.
 */
export function resolveSkillsInstallDir(): string {
  const override = process.env['AFFILIATE_MCP_SKILLS_INSTALL_DIR'];
  if (override && override.trim() !== '') return override;
  return path.join(homedir(), '.claude', 'skills');
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter parser for a SKILL.md leading `---` block. Handles
 * inline `key: value` and multiline block scalars (`description: |`). Captures
 * every top-level key; unknown keys are preserved and ignored by callers, so
 * adding a field to a SKILL.md never breaks this.
 */
export function parseSkillFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: text };
  const yaml = match[1] ?? '';
  const body = match[2] ?? '';
  const lines = yaml.split('\n');
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const top = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(\|?)\s*(.*)$/);
    if (!top) {
      i += 1;
      continue;
    }
    const [, key = '', pipe = '', inline = ''] = top;
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
      fields[key] = buf.join('\n').trim();
    } else {
      fields[key] = inline.trim();
      i += 1;
    }
  }
  return { fields, body };
}

function firstTrigger(description: string): string | undefined {
  const m = description.match(/"([^"]{8,})"/);
  return m?.[1];
}

function normaliseSide(raw: string | undefined): SkillSide | undefined {
  if (raw === 'publisher' || raw === 'brand' || raw === 'agency') return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

/**
 * Every bundled skill, summarised for the picker, sorted by name. Returns `[]`
 * when the skills directory is absent rather than throwing, so a misconfigured
 * bundle degrades to "no skills offered" instead of a crash in setup.
 */
export function listSkills(opts: { skillsDir?: string } = {}): SkillSummary[] {
  const dir = opts.skillsDir ?? resolveBundledSkillsDir();
  if (!existsSync(dir)) return [];
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const { fields } = parseSkillFrontmatter(readFileSync(skillMd, 'utf8'));
    const summary: SkillSummary = {
      slug: entry.name,
      name: fields['name'] ?? entry.name,
      description: fields['description'] ?? '',
    };
    const trigger = firstTrigger(summary.description);
    if (trigger !== undefined) summary.trigger = trigger;
    const side = normaliseSide(fields['side']);
    if (side !== undefined) summary.side = side;
    out.push(summary);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// installSkills
// ---------------------------------------------------------------------------

/**
 * Copy the selected skill folders into the resolved client skills directory.
 * Idempotent: a skill whose `SKILL.md` already exists at the target is left
 * untouched and reported under `skipped`. An unknown slug (no bundled
 * `SKILL.md`) throws, rather than silently installing nothing.
 */
export function installSkills(
  slugs: string[],
  opts: { skillsDir?: string; installDir?: string } = {},
): InstallSkillsResult {
  const src = opts.skillsDir ?? resolveBundledSkillsDir();
  const dest = opts.installDir ?? resolveSkillsInstallDir();
  mkdirSync(dest, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const slug of slugs) {
    const from = path.join(src, slug);
    if (!existsSync(path.join(from, 'SKILL.md'))) {
      throw new Error(`Unknown skill "${slug}" — no SKILL.md under ${from}.`);
    }
    const to = path.join(dest, slug);
    if (existsSync(path.join(to, 'SKILL.md'))) {
      skipped.push(slug);
      continue;
    }
    cpSync(from, to, { recursive: true });
    installed.push(slug);
  }
  return { ok: true, installed, skipped, targetDir: dest };
}
