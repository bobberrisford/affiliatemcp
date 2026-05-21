/**
 * `affiliate-mcp test [slug]` — friendly diagnostic.
 *
 * Drives `runDiagnostic` and prints a human-readable summary. Designed for the
 * common "is it working?" question — no JSON, no stack traces, just one line
 * per network plus an extra line per failing operation.
 *
 * Output is to stdout (user-facing CLI text on an interactive surface). Pino
 * still logs to stderr.
 */

import { runDiagnostic, type DiagnosticResult } from '../shared/diagnostic.js';
import type { NetworkCapabilities, OperationCapability } from '../shared/types.js';

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

export interface TestOptions {
  slug?: string;
}

export async function runTest(opts: TestOptions = {}): Promise<number> {
  const result = await runDiagnostic(opts.slug);
  if (result.results.length === 0) {
    out('No network adapters are registered. Nothing to test.');
    return 1;
  }

  let anyFailure = false;
  for (const r of result.results) {
    if (r.error) {
      out(`${r.network}  error — ${r.error.message}`);
      anyFailure = true;
      continue;
    }
    const cap = r.capabilities;
    if (!cap) {
      out(`${r.network}  error — no capabilities reported`);
      anyFailure = true;
      continue;
    }
    const summary = summariseNetwork(r.network, cap);
    out(summary.line);
    if (summary.failures.length > 0) anyFailure = true;
    for (const f of summary.failures) {
      out(`    ${f}`);
    }
  }
  return anyFailure ? 1 : 0;
}

interface NetworkSummary {
  line: string;
  failures: string[];
}

function summariseNetwork(
  name: string,
  cap: NetworkCapabilities,
): NetworkSummary {
  const ops = Object.entries(cap.operations);
  const supported = ops.filter(([, v]) => v.supported);
  const unsupported = ops.filter(([, v]) => !v.supported);
  const failures: string[] = [];

  const total = ops.length;
  const ok = supported.length;
  let marker = 'ok';
  if (ok === 0) marker = 'fail';
  else if (unsupported.length > 0) marker = 'partial';

  // Latency range across supported ops that actually probed (had latencyMs).
  const latencies = supported
    .map(([, v]) => v.latencyMs)
    .filter((n): n is number => typeof n === 'number');
  const latencyText =
    latencies.length > 0
      ? `${Math.min(...latencies)}–${Math.max(...latencies)}ms`
      : 'no live probes';

  let line: string;
  if (marker === 'ok') {
    line = `${name}  ok  all ${total} supported operations responded in ${latencyText}`;
  } else if (marker === 'partial') {
    const note = describeFirstLimitation(unsupported);
    line = `${name}  partial  ${ok} of ${total} operations supported${note ? '; ' + note : ''}`;
    for (const [opName, opCap] of unsupported) {
      failures.push(`${name}/${opName} unsupported${opCap.note ? ` — ${opCap.note}` : ''}`);
    }
  } else {
    line = `${name}  fail  no operations responded`;
    for (const [opName, opCap] of unsupported) {
      failures.push(`${name}/${opName} failed${opCap.note ? ` — ${opCap.note}` : ''}`);
    }
  }

  return { line, failures };
}

function describeFirstLimitation(
  unsupported: Array<[string, OperationCapability]>,
): string | undefined {
  if (unsupported.length === 0) return undefined;
  const first = unsupported[0];
  if (!first) return undefined;
  const [name, cap] = first;
  if (cap.note) return `${name} not supported (${cap.note})`;
  return `${name} not supported`;
}

/** Exposed for tests so they can assert the formatter output directly. */
export function formatDiagnostic(result: DiagnosticResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    if (r.error) {
      lines.push(`${r.network}  error — ${r.error.message}`);
      continue;
    }
    if (!r.capabilities) {
      lines.push(`${r.network}  error — no capabilities reported`);
      continue;
    }
    const summary = summariseNetwork(r.network, r.capabilities);
    lines.push(summary.line);
    for (const f of summary.failures) lines.push(`    ${f}`);
  }
  return lines.join('\n');
}
