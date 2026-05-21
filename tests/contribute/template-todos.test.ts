/**
 * Template self-documentation test (PRD §15.29).
 *
 * The template at `templates/new-network/` is the starting point for any new
 * adapter. Per PRD §14.3 every method's TODO must:
 *
 *   1. Carry a `// TODO:` marker.
 *   2. Point at the equivalent Awin implementation with a "Reference:" line.
 *   3. Name the return type or the relevant types-source file.
 *
 * The auth, client, and setup template files are not class-method shaped; we
 * verify them with lighter checks (Reference to Awin + presence of TODOs).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const templateRoot = join(repoRoot, 'templates', 'new-network');

const adapterPath = join(templateRoot, 'adapter.ts');

/**
 * The seven publisher operations + the wizard/setup helpers we expect to find
 * documented in the adapter template. The two admin stubs are deliberately
 * NOT in this list — they throw NotImplementedError unconditionally and the
 * template should not encourage a contributor to fill them in at v0.1.
 */
const METHODS_REQUIRING_TODO = [
  'listProgrammes',
  'getProgramme',
  'listTransactions',
  'getEarningsSummary',
  'listClicks',
  'generateTrackingLink',
  'verifyAuth',
  'validateCredential',
  'setupSteps',
  'capabilitiesCheck',
] as const;

describe('template TODOs (PRD §15.29)', () => {
  it('adapter.ts exists', () => {
    expect(() => readFileSync(adapterPath, 'utf8')).not.toThrow();
  });

  for (const method of METHODS_REQUIRING_TODO) {
    describe(method, () => {
      it('has a TODO comment block in the template adapter', () => {
        const content = readFileSync(adapterPath, 'utf8');
        // Match a TODO block that names the method.
        const re = new RegExp(`//\\s*TODO:.*${method}`, 'i');
        expect(
          re.test(content),
          `expected templates/new-network/adapter.ts to contain a "// TODO: ... ${method}" block`,
        ).toBe(true);
      });

      it('the TODO block references src/networks/awin/', () => {
        const content = readFileSync(adapterPath, 'utf8');
        // Locate the TODO block for this method, then check the next ~30
        // lines contain a Reference: src/networks/awin/ line.
        const re = new RegExp(`//\\s*TODO:[^\\n]*${method}[\\s\\S]{0,2000}?// Reference:[^\\n]*src/networks/awin/`, 'i');
        expect(
          re.test(content),
          `expected the ${method} TODO block to include a "Reference: src/networks/awin/..." line`,
        ).toBe(true);
      });

      it('the TODO block names a return type or types.ts', () => {
        const content = readFileSync(adapterPath, 'utf8');
        const re = new RegExp(`//\\s*TODO:[^\\n]*${method}[\\s\\S]{0,2000}?(Return type:|src/shared/types\\.ts)`, 'i');
        expect(
          re.test(content),
          `expected the ${method} TODO block to include a "Return type:" or "src/shared/types.ts" line`,
        ).toBe(true);
      });
    });
  }

  describe('auxiliary template files', () => {
    for (const file of ['auth.ts', 'client.ts', 'setup.ts']) {
      it(`${file} references src/networks/awin/`, () => {
        const content = readFileSync(join(templateRoot, file), 'utf8');
        expect(
          content,
          `expected templates/new-network/${file} to reference the Awin equivalent`,
        ).toMatch(/src\/networks\/awin\//);
      });

      it(`${file} contains at least one TODO`, () => {
        const content = readFileSync(join(templateRoot, file), 'utf8');
        expect(content, `expected at least one TODO in templates/new-network/${file}`).toMatch(
          /TODO:/,
        );
      });
    }
  });

  it('the file-level header names the cardinal rules', () => {
    const content = readFileSync(adapterPath, 'utf8');
    // The template header should re-state the cardinal rules so a contributor
    // reading only the template is aware of them.
    expect(content).toMatch(/cardinal/i);
    expect(content).toMatch(/principle 4\.1/i);
    expect(content).toMatch(/rawNetworkData/);
    expect(content).toMatch(/programme/);
  });
});
