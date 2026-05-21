/**
 * Tests for `affiliate-mcp test` (PRD §15.15 — friendly diagnostic).
 *
 * Asserts the human-readable summary format. Drives `formatDiagnostic`
 * directly so we don't need to swallow stdout from runTest, then also
 * exercises `runTest` end-to-end to confirm exit-code semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDiagnostic, runTest } from '../../src/cli/test.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { makeFakeAdapter } from './fakes.js';
import type { DiagnosticResult } from '../../src/shared/diagnostic.js';

let stdoutWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;

beforeEach(() => {
  _clearRegistry();
  stdoutWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});
afterEach(() => {
  stdoutSpy.mockRestore();
});

function out(): string {
  return stdoutWrites.join('');
}

describe('formatDiagnostic — human-readable summary', () => {
  it('renders an "ok" line with a latency range when all operations succeeded', () => {
    const result: DiagnosticResult = {
      generatedAt: new Date().toISOString(),
      results: [
        {
          network: 'awin',
          capabilities: {
            network: 'awin',
            generatedAt: new Date().toISOString(),
            operations: {
              listProgrammes: { supported: true, latencyMs: 240 },
              listTransactions: { supported: true, latencyMs: 520 },
              verifyAuth: { supported: true, latencyMs: 310 },
            },
            knownLimitations: [],
          },
        },
      ],
    };

    const text = formatDiagnostic(result);
    expect(text).toContain('awin');
    expect(text).toContain('ok');
    expect(text).toContain('3');
    expect(text).toContain('240');
    expect(text).toContain('520');
  });

  it('renders a "partial" line and lists the unsupported operations with their notes', () => {
    const result: DiagnosticResult = {
      generatedAt: new Date().toISOString(),
      results: [
        {
          network: 'rakuten',
          capabilities: {
            network: 'rakuten',
            generatedAt: new Date().toISOString(),
            operations: {
              listProgrammes: { supported: true, latencyMs: 100 },
              listClicks: {
                supported: false,
                note: 'clicks_reports requires paid tier',
              },
            },
            knownLimitations: [],
          },
        },
      ],
    };
    const text = formatDiagnostic(result);
    expect(text).toContain('rakuten');
    expect(text).toContain('partial');
    expect(text).toContain('listClicks');
    expect(text).toContain('clicks_reports requires paid tier');
  });

  it('surfaces error envelopes by name and operation, no stack', () => {
    const result: DiagnosticResult = {
      generatedAt: new Date().toISOString(),
      results: [
        {
          network: 'cj',
          error: { message: 'cj/verifyAuth: 401 invalid token' },
        },
      ],
    };
    const text = formatDiagnostic(result);
    expect(text).toContain('cj');
    expect(text).toContain('error');
    expect(text).toContain('401 invalid token');
    expect(text).not.toContain('at Object.<anonymous>');
  });
});

describe('runTest — end-to-end', () => {
  it('exits 0 when every supported operation responds', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'alpha',
        name: 'Alpha',
        steps: [],
        capabilities: async () => ({
          network: 'alpha',
          generatedAt: new Date().toISOString(),
          operations: { verifyAuth: { supported: true, latencyMs: 50 } },
          knownLimitations: [],
        }),
      }),
    );
    const code = await runTest();
    expect(code).toBe(0);
    expect(out()).toContain('alpha');
  });

  it('exits 1 and names the network when a network has unsupported operations', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'beta',
        name: 'Beta',
        steps: [],
        capabilities: async () => ({
          network: 'beta',
          generatedAt: new Date().toISOString(),
          operations: {
            verifyAuth: { supported: true, latencyMs: 50 },
            listClicks: { supported: false, note: 'gated' },
          },
          knownLimitations: [],
        }),
      }),
    );
    const code = await runTest();
    expect(code).toBe(1);
    const text = out();
    expect(text).toContain('beta');
    expect(text).toContain('partial');
    expect(text).toContain('listClicks');
  });

  it('exits 1 with a friendly message when no adapters are registered', async () => {
    const code = await runTest();
    expect(code).toBe(1);
    expect(out()).toContain('No network adapters are registered');
  });
});
