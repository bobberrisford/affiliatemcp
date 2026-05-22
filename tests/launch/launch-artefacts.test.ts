/**
 * Launch-artefact acceptance tests (Chunk 13).
 *
 * These tests guard the structural shape of the launch-prep deliverables:
 *
 * - the README's "four bundled" stale prose has been corrected (post-eBay);
 * - eBay Partner Network is mentioned in the README;
 * - the three registry submission files exist;
 * - the three demo scripts exist;
 * - the launch checklist exists and contains every documented section.
 *
 * These are existence + content guards, not deep-quality checks. The
 * launch-day go / no-go signal is the checklist itself.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const SUBMISSIONS_DIR = path.join(REPO_ROOT, 'docs', 'launch', 'submissions');
const DEMO_DIR = path.join(REPO_ROOT, 'docs', 'launch', 'demo-scripts');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'launch', 'CHECKLIST.md');

function readReadme(): string {
  return readFileSync(README_PATH, 'utf8');
}

describe('Launch artefacts (Chunk 13)', () => {
  describe('README post-eBay corrections', () => {
    it('no longer claims "four bundled"', () => {
      const body = readReadme();
      // Match either "four bundled" or "four networks bundled" (the two
      // exact stale phrasings on lines 5 and 10 prior to this chunk).
      expect(body).not.toMatch(/four bundled/i);
      expect(body).not.toMatch(/four networks\b/i);
    });

    it('mentions eBay Partner Network in the prose', () => {
      const body = readReadme();
      expect(body).toMatch(/eBay/i);
    });

    it('claims five bundled networks (or stronger) somewhere in the prose', () => {
      const body = readReadme();
      // Either "five bundled" or "five networks bundled" must appear.
      // We accept either phrasing because the editorial fix in Chunk 13
      // touched two distinct sentences.
      expect(body).toMatch(/\bfive\b[^.]*\bbundled\b|\bfive networks bundled\b/i);
    });
  });

  describe('Submission text (docs/launch/submissions/)', () => {
    it.each([
      ['mcp-registry.md'],
      ['smithery.md'],
      ['glama.md'],
    ])('contains %s', (file) => {
      expect(existsSync(path.join(SUBMISSIONS_DIR, file))).toBe(true);
    });
  });

  describe('Demo scripts (docs/launch/demo-scripts/)', () => {
    it.each([
      ['01-wizard-in-action.md'],
      ['02-setup-help-skill.md'],
      ['03-claude-code-adds-a-network.md'],
    ])('contains %s', (file) => {
      expect(existsSync(path.join(DEMO_DIR, file))).toBe(true);
    });
  });

  describe('Launch-readiness checklist', () => {
    it('exists at docs/launch/CHECKLIST.md', () => {
      expect(existsSync(CHECKLIST_PATH)).toBe(true);
    });

    it('contains every documented section heading', () => {
      const body = readFileSync(CHECKLIST_PATH, 'utf8');
      // The nine sections specified in the chunk-13 brief.
      const sections: RegExp[] = [
        /^##\s+1\.\s+Code\s*&\s*build/im,
        /^##\s+2\.\s+Manual verification/im,
        /^##\s+3\.\s+Live API exercise/im,
        /^##\s+4\.\s+Docs/im,
        /^##\s+5\.\s+Demo recording/im,
        /^##\s+6\.\s+Comparison table image/im,
        /^##\s+7\.\s+Registry submissions/im,
        /^##\s+8\.\s+GitHub/im,
        /^##\s+9\.\s+External contact/im,
      ];
      for (const re of sections) {
        expect(body, `checklist missing section matching ${re}`).toMatch(re);
      }
    });
  });
});
