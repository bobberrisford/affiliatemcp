/**
 * Tests for the skill composer core (src/core/composer.ts).
 *
 * Imports the network registry so real adapters back listNetworkOperations
 * (awin is always registered). Writes only to a sandbox install dir. Covers the
 * archetype palette, operation enumeration, the compose guardrail (unknown tool
 * rejected), slug derivation, generated-frontmatter validity, and save.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import '../../src/networks/index.js'; // populate the adapter registry

import {
  composeSkill,
  listNetworkOperations,
  listSkillArchetypes,
  saveComposedSkill,
} from '../../src/core/composer.js';
import { parseSkillFrontmatter } from '../../src/core/skills.js';

let destDir: string;

beforeEach(() => {
  destDir = mkdtempSync(path.join(tmpdir(), 'amcp-composer-'));
});
afterEach(() => {
  rmSync(destDir, { recursive: true, force: true });
});

describe('listSkillArchetypes', () => {
  it('returns the palette with stable ids', () => {
    const ids = listSkillArchetypes().map((a) => a.id);
    expect(ids).toContain('report');
    expect(ids).toContain('health-check');
    expect(ids).toContain('custom');
  });
});

describe('listNetworkOperations', () => {
  it('returns real generated tool names for a registered network', () => {
    const ops = listNetworkOperations('awin');
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.toolName.startsWith('affiliate_awin_')).toBe(true);
      expect(typeof op.description).toBe('string');
    }
  });

  it('throws for an unknown network', () => {
    expect(() => listNetworkOperations('does-not-exist')).toThrow(/No adapter registered/);
  });
});

describe('composeSkill', () => {
  it('derives a slug, embeds the trigger, and lists the chosen tools', () => {
    const ops = listNetworkOperations('awin').slice(0, 2).map((o) => o.toolName);
    const res = composeSkill({
      archetypeId: 'report',
      networks: ['awin'],
      operations: ops,
      name: 'My Awin Report',
      trigger: 'run my awin report',
    });

    expect(res.slug).toBe('my-awin-report');
    expect(res.targetPath.endsWith(path.join('my-awin-report', 'SKILL.md'))).toBe(true);

    // The generated file must parse as a valid skill (name + description + a
    // quoted trigger phrase), and reference exactly the chosen real tools.
    const { fields } = parseSkillFrontmatter(res.content);
    expect(fields['name']).toBe('my-awin-report');
    expect(fields['description']).toContain('run my awin report');
    for (const t of ops) expect(res.content).toContain(t);
  });

  it('rejects an operation that is not a real tool for the chosen networks (guardrail)', () => {
    expect(() =>
      composeSkill({
        archetypeId: 'report',
        networks: ['awin'],
        operations: ['affiliate_awin_make_coffee'],
        name: 'bad skill',
        trigger: 'do the thing',
      }),
    ).toThrow(/aren't available/);
  });

  it('rejects a name with no usable characters', () => {
    expect(() =>
      composeSkill({ archetypeId: 'report', networks: ['awin'], operations: [], name: '!!!', trigger: 'x phrase' }),
    ).toThrow(/must contain letters or numbers/);
  });

  it('requires at least one network', () => {
    expect(() =>
      composeSkill({ archetypeId: 'report', networks: [], operations: [], name: 'no nets', trigger: 'x phrase' }),
    ).toThrow(/at least one network/);
  });
});

describe('saveComposedSkill', () => {
  it('writes the SKILL.md under the install dir', () => {
    const composed = composeSkill({
      archetypeId: 'health-check',
      networks: ['awin'],
      operations: [],
      name: 'awin health',
      trigger: 'check my awin setup',
    });
    const res = saveComposedSkill(composed.slug, composed.content, { installDir: destDir });
    expect(res.ok).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(readFileSync(res.path, 'utf8')).toContain('name: awin-health');
  });

  it('rejects a bad slug rather than writing outside the tree', () => {
    expect(() => saveComposedSkill('../evil', 'x', { installDir: destDir })).toThrow(/Invalid skill slug/);
  });
});
