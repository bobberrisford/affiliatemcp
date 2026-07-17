/**
 * Human-readable persona report.
 *
 *   npm run persona:report            # all scenarios
 *   npm run persona:report -- <id>    # one scenario by id
 *
 * Reuses the same engine as the vitest gate (tests/personas/personas.test.ts),
 * so there is one implementation. Prints a per-step transcript and exits
 * non-zero if any journey has findings — useful for a launch-readiness snapshot
 * and for authoring new scenarios. Output goes to stdout because this is a
 * standalone CLI, not the MCP transport.
 */

import { runScenario } from '../tests/personas/harness/index.js';
import { ALL_SCENARIOS } from '../tests/personas/scenarios/index.js';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

const OK_OUTCOMES = new Set(['ok', 'error', 'api-gap']);

async function main(): Promise<void> {
  const filter = process.argv[2];
  const scenarios = filter ? ALL_SCENARIOS.filter((s) => s.id === filter) : ALL_SCENARIOS;
  if (scenarios.length === 0) {
    err(`No scenario matches "${filter}". Known ids: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    const pass = result.findings.length === 0;
    if (!pass) failed += 1;
    out(`\n${pass ? '✓' : '✗'} ${result.persona} — ${result.title}  [${result.id}]`);
    for (const step of result.steps) {
      const glyph = step.findings.length === 0 && OK_OUTCOMES.has(step.outcome) ? '✓' : '✗';
      const envelope = step.envelope ? ` → ${step.envelope.type}` : '';
      out(`   ${glyph} ${step.label} (${step.outcome})${envelope}`);
      for (const f of step.findings) out(`       ✗ ${f.message}`);
    }
  }

  out(`\n${scenarios.length - failed}/${scenarios.length} persona journeys passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  err(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
