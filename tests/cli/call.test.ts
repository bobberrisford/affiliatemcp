/**
 * Tests for `affiliate-networks-mcp call`: the terminal surface over network
 * operations.
 *
 * The command reuses the same `generateAllTools()` registry as the MCP server,
 * so these tests register fake adapters and assert that `runCall`:
 *   - lists the generated tools (grouped, including meta tools),
 *   - resolves both the full tool name and the `<network> <operation>` form,
 *   - parses key=value and --args arguments into the adapter call,
 *   - prints results as JSON to stdout, and
 *   - surfaces failures as a NetworkErrorEnvelope on stderr with a non-zero code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCall } from '../../src/cli/call.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { makeFakeAdapter } from './fakes.js';
import type { NetworkAdapter } from '../../src/shared/types.js';

let stdoutWrites: string[];
let stderrWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;

beforeEach(() => {
  _clearRegistry();
  stdoutWrites = [];
  stderrWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function stdout(): string {
  return stdoutWrites.join('');
}
function stderr(): string {
  return stderrWrites.join('');
}

/**
 * A fake adapter whose listTransactions records the args it was called with so
 * tests can assert argument parsing.
 */
function makeRecordingAdapter(slug: string): {
  adapter: NetworkAdapter;
  calls: { listTransactions: unknown[] };
} {
  const calls = { listTransactions: [] as unknown[] };
  const adapter = makeFakeAdapter({ slug, name: slug.toUpperCase(), steps: [] });
  adapter.listTransactions = (async (query: unknown) => {
    calls.listTransactions.push(query);
    return [{ id: 'tx-1', programmeId: 'p-1', status: 'approved', query }];
  }) as unknown as NetworkAdapter['listTransactions'];
  return { adapter, calls };
}

describe('runCall: listing', () => {
  it('lists tools grouped by network, including meta tools, when no tool is named', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    const code = await runCall({ argv: [] });
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('alpha');
    expect(text).toContain('affiliate_alpha_list_transactions');
    // Meta tools are always present and listed last.
    expect(text).toContain('affiliate_list_networks');
  });

  it('--list --network filters to a single network', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    registerAdapter(makeFakeAdapter({ slug: 'beta', name: 'Beta', steps: [] }));
    const code = await runCall({ argv: ['--list', '--network', 'beta'] });
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('affiliate_beta_list_programmes');
    expect(text).not.toContain('affiliate_alpha_list_programmes');
  });

  it('groups meta tools under "meta", not under a pseudo-network from their name', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    const code = await runCall({ argv: ['--list'] });
    expect(code).toBe(0);
    const text = stdout();
    // `affiliate_list_networks` / `affiliate_run_diagnostic` must not create
    // fake "list" / "run" network groups; only registered slugs and "meta".
    expect(text).toContain('\nmeta\n');
    expect(text).not.toContain('\nlist\n');
    expect(text).not.toContain('\nrun\n');
  });

  it('--list --network matches a long advertiser slug whose tool names are shortened', async () => {
    // Long enough that toolNameFor abbreviates `-advertiser` to `-adv` for
    // some tool names (64-char MCP tool-name cap).
    const slug = 'extremely-long-network-name-advertiser';
    registerAdapter(makeFakeAdapter({ slug, name: 'Long Advertiser', steps: [] }));
    const code = await runCall({ argv: ['--list', '--network', slug] });
    expect(code).toBe(0);
    const text = stdout();
    // The shortened name is grouped under the real registered slug.
    expect(text).toContain('affiliate_extremely-long-network-name-adv_list_transactions');
  });
});

describe('runCall: describe', () => {
  it('prints the description and input schema for a tool', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    const code = await runCall({
      argv: ['--describe', 'affiliate_alpha_list_transactions'],
    });
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('affiliate_alpha_list_transactions');
    expect(text).toContain('Input schema:');
    expect(text).toContain('"type": "object"');
  });
});

describe('runCall: invocation', () => {
  it('resolves the <network> <operation> form and prints JSON result to stdout', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({ argv: ['alpha', 'list_transactions'] });
    expect(code).toBe(0);
    expect(calls.listTransactions.length).toBe(1);
    expect(stdout()).toContain('"id": "tx-1"');
  });

  it('accepts the camelCase operation form too', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({ argv: ['alpha', 'listTransactions'] });
    expect(code).toBe(0);
    expect(calls.listTransactions.length).toBe(1);
  });

  it('parses key=value pairs into typed args (number, string, array)', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({
      argv: ['alpha', 'list_transactions', 'limit=50', 'from=2026-01-01', 'status=["approved","pending"]'],
    });
    expect(code).toBe(0);
    expect(calls.listTransactions[0]).toMatchObject({
      limit: 50,
      from: '2026-01-01',
      status: ['approved', 'pending'],
    });
  });

  it('keeps numeric-looking string ids as strings (schema-aware coercion)', async () => {
    // generateTrackingLink declares programmeId/destinationUrl as strings.
    const adapter = makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] });
    let captured: unknown;
    adapter.generateTrackingLink = (async (input: unknown) => {
      captured = input;
      return { network: 'alpha', destinationUrl: 'x', trackingUrl: 'y', createdAt: 'z' };
    }) as unknown as NetworkAdapter['generateTrackingLink'];
    registerAdapter(adapter);
    const code = await runCall({
      argv: ['alpha', 'generate_tracking_link', 'programmeId=12345', 'destinationUrl=https://ex.com'],
    });
    expect(code).toBe(0);
    expect(captured).toEqual({ programmeId: '12345', destinationUrl: 'https://ex.com' });
  });

  it('accepts a comma-separated list for array/union fields', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({
      argv: ['alpha', 'list_transactions', 'status=approved,pending'],
    });
    expect(code).toBe(0);
    expect(calls.listTransactions[0]).toMatchObject({ status: ['approved', 'pending'] });
  });

  it('parses --args JSON, with key=value overriding overlapping keys', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({
      argv: ['alpha', 'list_transactions', '--args', '{"limit":10,"from":"2026-02-01"}', 'limit=99'],
    });
    expect(code).toBe(0);
    expect(calls.listTransactions[0]).toMatchObject({ limit: 99, from: '2026-02-01' });
  });

  it('resolves the friendly form when the registered tool name carries the -adv abbreviation', async () => {
    const { adapter, calls } = makeRecordingAdapter('extremely-long-network-name-advertiser');
    registerAdapter(adapter);
    // The registered tool is affiliate_extremely-long-network-name-adv_list_transactions
    // (64-char cap), but the user types the real slug.
    const code = await runCall({
      argv: ['extremely-long-network-name-advertiser', 'list_transactions'],
    });
    expect(code).toBe(0);
    expect(calls.listTransactions.length).toBe(1);
  });

  it('accepts the full tool name', async () => {
    const { adapter, calls } = makeRecordingAdapter('alpha');
    registerAdapter(adapter);
    const code = await runCall({ argv: ['affiliate_alpha_list_transactions'] });
    expect(code).toBe(0);
    expect(calls.listTransactions.length).toBe(1);
  });
});

describe('runCall: failures', () => {
  it('returns 2 and a hint when the tool cannot be resolved', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    const code = await runCall({ argv: ['nope', 'made_up'] });
    expect(code).toBe(2);
    expect(stderr()).toContain('No tool matches');
  });

  it('surfaces adapter failures as a NetworkErrorEnvelope on stderr with exit 1', async () => {
    const adapter = makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] });
    adapter.listTransactions = (async () => {
      throw new Error('401 unauthorized');
    }) as unknown as NetworkAdapter['listTransactions'];
    registerAdapter(adapter);
    const code = await runCall({ argv: ['alpha', 'list_transactions'] });
    expect(code).toBe(1);
    const text = stderr();
    expect(text).toContain('"network": "alpha"');
    expect(text).toContain('"operation": "affiliate_alpha_list_transactions"');
    expect(text).toContain('auth_error');
    expect(text).not.toContain('at Object.<anonymous>');
  });

  it('rejects malformed --args JSON with exit 2', async () => {
    registerAdapter(makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] }));
    const code = await runCall({ argv: ['alpha', 'list_transactions', '--args', '{not json'] });
    expect(code).toBe(2);
    expect(stderr()).toContain('not valid JSON');
  });
});
