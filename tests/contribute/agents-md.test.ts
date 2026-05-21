/**
 * AGENTS.md completeness test (PRD §15.27).
 *
 * AGENTS.md is the primer the contribute skill reads first. The test bar:
 *
 *   1. The file exists at the repo root.
 *   2. It mentions the canonical references a contributor needs to know
 *      (UK spelling, programme, stderr, resilience.ts, src/networks/awin/,
 *      principle 4.1).
 *   3. Every file path it cites exists on disk.
 *   4. Every `npm run <script>` it names is declared in package.json.
 *
 * This is the structural verification of §15.27. End-to-end §15.31 (a fresh
 * Claude Code session adds eBay using AGENTS.md alone) is deferred to an
 * orchestrator-level meta-test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const agentsPath = join(repoRoot, 'AGENTS.md');

describe('AGENTS.md (PRD §15.27)', () => {
  it('exists at the repo root', () => {
    expect(existsSync(agentsPath), `expected ${agentsPath} to exist`).toBe(true);
  });

  it('mentions the canonical conventions and references', () => {
    const content = readFileSync(agentsPath, 'utf8');
    // UK spelling note and the noun "programme".
    expect(content, 'expected mention of UK English').toMatch(/UK English/);
    expect(content, 'expected mention of "programme"').toMatch(/programme/);
    // Logging is stderr-only.
    expect(content, 'expected mention of stderr').toMatch(/stderr/);
    // Resilience layer is the only path.
    expect(content, 'expected mention of resilience.ts').toMatch(/resilience\.ts/);
    // Awin is the canonical reference.
    expect(content, 'expected mention of src/networks/awin/').toMatch(/src\/networks\/awin\//);
    // Principle 4.1.
    expect(content, 'expected mention of principle 4.1').toMatch(/4\.1/);
  });

  it('every file path it references exists on disk', () => {
    const content = readFileSync(agentsPath, 'utf8');
    // Strip code fences so the ASCII tree inside ``` blocks is exempt — we
    // only check paths the prose actually cites.
    const withoutFences = content.replace(/```[\s\S]*?```/g, '');
    // Match relative-ish paths ending in a known extension. Require at least
    // one slash so bare filenames like `auth.ts` (referring to "your auth.ts"
    // generically) are exempt — we only verify paths that look like literal
    // repository locations.
    const pathRegex = /(?<![\w./])([a-zA-Z0-9_][a-zA-Z0-9_./-]*\/[a-zA-Z0-9_.-]+\.(?:ts|tsx|md|json|cjs|js))(?![\w])/g;
    const matches = withoutFences.match(pathRegex) ?? [];

    const missing: string[] = [];
    for (const raw of matches) {
      // Skip obvious URLs / patterns inside angle brackets / placeholder slugs.
      if (raw.includes('://')) continue;
      if (raw.includes('<') || raw.includes('>')) continue;
      // Skip example file names that aren't literal repo paths.
      if (raw === 'claude_desktop_config.json') continue;
      if (raw === 'CONTRIBUTING.md') continue; // Chunk 12 ships this.
      const candidate = join(repoRoot, raw);
      if (!existsSync(candidate)) missing.push(raw);
    }

    expect(
      missing,
      `AGENTS.md references file paths that do not exist:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every `npm run <script>` it names is declared in package.json', () => {
    const content = readFileSync(agentsPath, 'utf8');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.scripts ?? {}));

    // Match `npm run <name>` — capture the first token after `npm run `.
    const scriptRegex = /npm run\s+([a-zA-Z][a-zA-Z0-9:_-]*)/g;
    const unknown: string[] = [];
    for (const m of content.matchAll(scriptRegex)) {
      const name = m[1];
      if (!name) continue;
      if (!declared.has(name)) unknown.push(name);
    }
    expect(
      unknown,
      `AGENTS.md cites npm scripts not declared in package.json: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('names every npm script the contributor flow depends on', () => {
    const content = readFileSync(agentsPath, 'utf8');
    for (const script of [
      'test',
      'typecheck',
      'lint',
      'build',
      'validate:network',
      'generate:readme',
      'generate:report',
    ]) {
      expect(content, `expected AGENTS.md to mention npm script "${script}"`).toMatch(
        new RegExp(`npm run\\s+${script.replace(':', ':')}`),
      );
    }
  });

  it('includes a "what not to do" list', () => {
    const content = readFileSync(agentsPath, 'utf8');
    expect(content).toMatch(/what not to do/i);
    // The list must cover the cardinal don'ts.
    expect(content).toMatch(/telemetry|phone-home/i);
    expect(content).toMatch(/4xx/);
    expect(content).toMatch(/console\.log/);
  });
});
