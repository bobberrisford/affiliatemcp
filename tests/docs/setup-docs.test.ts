/**
 * Per-network setup doc acceptance tests.
 *
 * Encodes the PRD §15.16 quality bar for the per-network setup documents in
 * `docs/networks/<slug>.md`. For each bundled network, asserts
 * that the doc:
 *   - exists at the expected path,
 *   - opens with a level-1 heading that includes a time estimate,
 *   - declares a "Prerequisites" section,
 *   - documents common failures / troubleshooting,
 *   - includes a "What success looks like" (or equivalent) confirmation
 *     section.
 *
 * These checks are deliberately structural rather than prose-level. The
 * editorial tone bar is enforced at code review time; here we only make sure
 * the bones of each doc are in place so future contributors (or LLM agents)
 * can't accidentally ship an empty or skeleton setup doc.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'networks');

const NETWORK_SLUGS = ['awin', 'cj', 'ebay', 'impact', 'rakuten'] as const;

/**
 * Reads a setup doc. Throws a useful error if the file is missing so the
 * "file exists" assertion message tells the contributor exactly where the
 * harness looked.
 */
function readDoc(slug: string): string {
  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  return readFileSync(filePath, 'utf8');
}

describe('per-network setup docs (docs/networks/<slug>.md)', () => {
  for (const slug of NETWORK_SLUGS) {
    describe(slug, () => {
      it('exists and is non-empty', () => {
        const body = readDoc(slug);
        expect(body.length).toBeGreaterThan(0);
      });

      it('opens with an H1 that includes a time estimate', () => {
        const body = readDoc(slug);
        const lines = body.split(/\r?\n/);
        const firstHeading = lines.find((l) => l.startsWith('# '));
        expect(firstHeading, 'no H1 heading found').toBeDefined();
        // The H1 itself, or a line shortly after it, must mention "minutes".
        const head = lines.slice(0, 5).join(' ');
        expect(head).toMatch(/minutes?/i);
      });

      it('has a Prerequisites section', () => {
        const body = readDoc(slug);
        expect(body).toMatch(/^##\s+Prerequisites\b/m);
      });

      it('has a common-failures or troubleshooting section', () => {
        const body = readDoc(slug);
        // Match either heading style ("## Common failures", "## Troubleshooting").
        expect(body).toMatch(/^##\s+(Common failures|Troubleshooting)\b/im);
      });

      it('has a "What success looks like" or equivalent confirmation section', () => {
        const body = readDoc(slug);
        expect(body).toMatch(
          /^##\s+(What success looks like|Verifying|Confirming|Success)\b/im,
        );
      });
    });
  }
});
