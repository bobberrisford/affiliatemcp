/**
 * Persona journeys — the regression gate.
 *
 * Each scenario drives the real generated tool surface as its persona would and
 * must produce zero findings: every envelope, shape, and journey assertion
 * holds. Plus two cross-cutting guards: scenario credentials must be obviously
 * fake, and server-authored tool descriptions must use UK spelling.
 *
 * See ./README.md for what this gate does and does not prove.
 */

import { describe, expect, it } from 'vitest';

import '../../src/networks/index.js';
import { generateAllTools } from '../../src/tools/generate.js';
import { runScenario, ukSpellingFindings } from './harness/index.js';
import { ALL_SCENARIOS } from './scenarios/index.js';

const FAKE_MARKERS = /(fake|test|persona|ignore|example|placeholder|agency)/i;

describe('persona journeys', () => {
  for (const scenario of ALL_SCENARIOS) {
    describe(`${scenario.persona}: ${scenario.id}`, () => {
      it(scenario.title, async () => {
        const result = await runScenario(scenario);
        const report = result.findings.map((f) => `  - [${f.step}] ${f.message}`).join('\n');
        expect(result.findings, `persona journey findings:\n${report}`).toEqual([]);
      });
    });
  }
});

describe('persona scenario hygiene', () => {
  it('scenario credentials are obviously fake (never real secrets)', () => {
    const offenders: string[] = [];
    for (const scenario of ALL_SCENARIOS) {
      for (const [key, value] of Object.entries(scenario.env)) {
        // A long, high-entropy-looking value with no fake marker is suspicious.
        if (value.length > 24 && !FAKE_MARKERS.test(value)) {
          offenders.push(`${scenario.id}:${key}`);
        }
      }
    }
    expect(offenders, `scenario env values look like real secrets: ${offenders.join(', ')}`).toEqual([]);
  });

  it('generated tool descriptions use UK spelling', () => {
    const findings = generateAllTools().flatMap((t) => ukSpellingFindings(t.name, t.description));
    const report = findings.map((f) => `  - [${f.step}] ${f.message}`).join('\n');
    expect(findings, `US spellings in tool descriptions:\n${report}`).toEqual([]);
  });
});
