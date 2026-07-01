/**
 * affiliate-mcp — skill composer core.
 *
 * A guided composer that turns a few enumerated choices (archetype, networks,
 * data operations, name + trigger) into a valid `SKILL.md`. It never adds a
 * tool surface and never references a tool that does not exist: the operation
 * choices come straight from `generateToolsFor`, the same source of truth the
 * MCP tool registry uses, and `composeSkill` rejects any operation that is not
 * a real tool for the chosen networks. That is the whole guardrail — a composed
 * skill orchestrates existing generated tools only.
 *
 * IPC-safe: every returned shape is a plain object. Local file write only, no
 * network (D4). UK spelling in user-facing strings.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getAdapter } from '../shared/registry.js';
import { generateToolsFor } from '../tools/generate.js';
import { resolveSkillsInstallDir } from './skills.js';

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface SkillArchetype {
  id: string;
  label: string;
  summary: string;
}

export interface NetworkOperation {
  /** The generated MCP tool name, e.g. `affiliate_awin_list_transactions`. */
  toolName: string;
  /** The tool's matter-of-fact description, for the picker. */
  description: string;
}

export interface ComposeSkillInput {
  archetypeId: string;
  networks: string[];
  operations: string[];
  name: string;
  trigger: string;
}

export interface ComposedSkill {
  slug: string;
  targetPath: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Archetype palette
// ---------------------------------------------------------------------------

/**
 * The output shapes offered in step 1. Repo-owned data (not scattered through
 * the binary); each maps to a body template in `archetypeSteps`. A future PR
 * can promote this to a metadata file the composer reads, per the decision.
 */
export const SKILL_ARCHETYPES: SkillArchetype[] = [
  { id: 'report', label: 'Report', summary: 'Pull data across the chosen networks and present one consolidated summary.' },
  { id: 'health-check', label: 'Health check', summary: 'Verify auth and reachability across the chosen networks.' },
  { id: 'anomaly-scan', label: 'Watch / anomaly scan', summary: 'Compare the current period with the prior one and flag notable changes.' },
  { id: 'link-audit', label: 'Link audit', summary: 'Check that tracking links still resolve to active programmes.' },
  { id: 'custom', label: 'Custom prompt (advanced)', summary: 'A free-form instruction that still calls only the tools you pick.' },
];

export function listSkillArchetypes(): SkillArchetype[] {
  return SKILL_ARCHETYPES;
}

// ---------------------------------------------------------------------------
// Operations available for a network
// ---------------------------------------------------------------------------

/**
 * The generated tools a network exposes, as `{ toolName, description }`. Reuses
 * `generateToolsFor` so the names (including the advertiser-slug shortening
 * rule) are identical to what the MCP server registers. Throws for an unknown
 * network rather than returning an empty list that would hide the mistake.
 */
export function listNetworkOperations(slug: string): NetworkOperation[] {
  const adapter = getAdapter(slug);
  if (!adapter) {
    throw new Error(`No adapter registered for network "${slug}".`);
  }
  return generateToolsFor(adapter).map((t) => ({
    toolName: t.name,
    description: t.description,
  }));
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function archetypeSteps(id: string): string[] {
  switch (id) {
    case 'health-check':
      return [
        '1. For each network, call its `verify_auth` tool and report the result.',
        '2. Surface any verbatim error from the tool envelope; never fake success.',
      ];
    case 'anomaly-scan':
      return [
        '1. Pull the current period and a prior comparable period from each network.',
        '2. Compare like for like; flag only changes you can quote both figures for.',
      ];
    case 'link-audit':
      return [
        '1. Resolve each link and confirm it points at an active programme.',
        '2. List any link that fails to resolve, with the reason.',
      ];
    case 'report':
      return [
        '1. Confirm the period with the user (default: last 30 days).',
        '2. Call the tools below for each network and consolidate the results.',
        '3. Present a compact table; keep per-network currencies separate.',
      ];
    default:
      return ['1. Follow the user’s instruction, calling only the tools listed below.'];
  }
}

function renderSkillMarkdown(input: ComposeSkillInput & { slug: string }): string {
  const arche =
    SKILL_ARCHETYPES.find((a) => a.id === input.archetypeId) ??
    SKILL_ARCHETYPES[SKILL_ARCHETYPES.length - 1]!;
  const descLines = [
    `Use this skill for a ${arche.label.toLowerCase()} across ${input.networks.join(', ')}.`,
    `Trigger on: "${input.trigger}".`,
  ];
  const frontmatter = `---\nname: ${input.slug}\ndescription: |\n${descLines
    .map((l) => `  ${l}`)
    .join('\n')}\n---`;
  const toolLines = input.operations.length
    ? input.operations.map((t) => `- \`${t}\``).join('\n')
    : '- (no tools selected — ask the user which data to pull)';
  const body = [
    `# ${input.name}`,
    '',
    arche.summary,
    '',
    '## Networks',
    input.networks.map((n) => `- ${n}`).join('\n'),
    '',
    '## Tools this skill may call',
    'Call only these generated tools; never invent a tool name.',
    '',
    toolLines,
    '',
    '## Steps',
    ...archetypeSteps(arche.id),
    '',
    '## Constraints',
    '- Never invent data. Surface the verbatim error from a tool envelope on failure.',
    '- UK spelling. Matter-of-fact tone.',
    '',
  ].join('\n');
  return `${frontmatter}\n\n${body}`;
}

/**
 * Build a valid `SKILL.md` from the picks, without writing it. Validates that
 * the name yields a usable slug, at least one network is chosen, and every
 * chosen operation is a real tool for the chosen networks (the guardrail).
 */
export function composeSkill(input: ComposeSkillInput): ComposedSkill {
  const slug = slugify(input.name);
  if (!slug) {
    throw new Error('Skill name must contain letters or numbers.');
  }
  if (!input.networks.length) {
    throw new Error('Pick at least one network for the skill.');
  }
  const available = new Set<string>();
  for (const net of input.networks) {
    for (const op of listNetworkOperations(net)) available.add(op.toolName);
  }
  const unknown = input.operations.filter((o) => !available.has(o));
  if (unknown.length) {
    throw new Error(
      `These operations aren't available for the chosen networks: ${unknown.join(', ')}.`,
    );
  }
  const content = renderSkillMarkdown({ ...input, slug });
  const targetPath = path.join(resolveSkillsInstallDir(), slug, 'SKILL.md');
  return { slug, targetPath, content };
}

/**
 * Write a composed skill to the resolved skills directory. Re-validates the
 * slug (defence in depth against a hand-crafted IPC payload) before writing.
 */
export function saveComposedSkill(
  slug: string,
  content: string,
  opts: { installDir?: string } = {},
): { ok: true; path: string } {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid skill slug "${slug}".`);
  }
  const dir = path.join(opts.installDir ?? resolveSkillsInstallDir(), slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, content, 'utf8');
  return { ok: true, path: file };
}
