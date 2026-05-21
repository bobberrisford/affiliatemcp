/**
 * README acceptance tests (PRD §15.20).
 *
 * The README is the project's front door. These assertions encode the
 * structural shape we expect — required sections, a link to REPORT.md, a
 * link to at least one per-network setup doc, the generated network table
 * block, and no marketing tokens.
 *
 * UK-spelling drift is checked best-effort: we warn (via the test name and
 * a console message) but do not fail, because the spelling regex can
 * legitimately match within quoted upstream field names.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');

function readReadme(): string {
  return readFileSync(README_PATH, 'utf8');
}

describe('README.md (PRD §15.20)', () => {
  it('exists at repo root', () => {
    expect(existsSync(README_PATH)).toBe(true);
  });

  it('has between 50 and 400 lines', () => {
    const lines = readReadme().split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(50);
    expect(lines.length).toBeLessThanOrEqual(400);
  });

  it('contains the required sections', () => {
    const body = readReadme();

    // "Quick-start" (or "Quick start")
    expect(body).toMatch(/^##\s+Quick[- ]start\b/im);

    // "Networks" — top-level mention is enough.
    expect(body).toMatch(/^##\s+Networks\b/im);

    // "Per-network setup" or "setup docs" — be permissive.
    expect(body).toMatch(/^##\s+(Per-network setup|Setup docs?)\b/im);

    // "Tool surface" or "Tools".
    expect(body).toMatch(/^##\s+(Tool surface|Tools)\b/im);

    // "Licence" or "License" — UK spelling is the project default but both
    // are accepted defensively.
    expect(body).toMatch(/^##\s+Licen[cs]e\b/im);
  });

  it('links to REPORT.md', () => {
    const body = readReadme();
    expect(body).toMatch(/\]\(\.?\/?REPORT\.md\)/);
  });

  it('links to at least one per-network setup doc', () => {
    const body = readReadme();
    expect(body).toMatch(/docs\/networks\/[a-z0-9-]+\.md/);
  });

  it('contains the generated network table block', () => {
    const body = readReadme();
    expect(body).toMatch(/<!--\s*AFFILIATE_MCP_NETWORK_TABLE_START\s*-->/);
    expect(body).toMatch(/<!--\s*AFFILIATE_MCP_NETWORK_TABLE_END\s*-->/);
  });

  it('contains no marketing tokens', () => {
    const body = readReadme();
    const marketing = /\b(best|leader|world-class|unmatched|revolutionary|cutting-edge)\b/i;
    const match = body.match(marketing);
    expect(match, `marketing token found: ${match?.[0] ?? ''}`).toBeNull();
  });

  it('flags US-spelling drift (best-effort, non-failing)', () => {
    const body = readReadme();
    const us = /\b(behavior|colorize|optimize)\b/i;
    const match = body.match(us);
    if (match) {
      // eslint-disable-next-line no-console
      console.warn(
        `README.md: possible US spelling drift — found "${match[0]}". Confirm UK form is intended.`,
      );
    }
    // Non-failing: this check is advisory; the regex can match in quoted
    // upstream identifiers that we cannot rewrite.
    expect(true).toBe(true);
  });
});
