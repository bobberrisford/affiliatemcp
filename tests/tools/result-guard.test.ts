import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RESULT_BUDGET_BYTES,
  PRETTY_PRINT_LIMIT_BYTES,
  guardToolResult,
  resultBudgetBytes,
} from '../../src/tools/result-guard.js';

let originalBudget: string | undefined;

beforeEach(() => {
  originalBudget = process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'];
  delete process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'];
});

afterEach(() => {
  if (originalBudget === undefined) delete process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'];
  else process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'] = originalBudget;
});

/** Rows of a predictable serialised size for driving the guard over budget. */
function makeRows(count: number, payloadLength = 100): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `txn-${i}`,
    commission: i * 0.5,
    rawNetworkData: 'x'.repeat(payloadLength),
  }));
}

describe('resultBudgetBytes', () => {
  it('defaults when the env var is unset', () => {
    expect(resultBudgetBytes()).toBe(DEFAULT_RESULT_BUDGET_BYTES);
  });

  it('honours a valid override', () => {
    process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'] = '5000';
    expect(resultBudgetBytes()).toBe(5000);
  });

  it.each(['', '  ', 'abc', '-1', '0', '1.5'])(
    'falls back to the default for invalid value %j',
    (value) => {
      process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'] = value;
      expect(resultBudgetBytes()).toBe(DEFAULT_RESULT_BUDGET_BYTES);
    },
  );
});

describe('guardToolResult', () => {
  it('keeps small results pretty-printed and byte-identical to the previous behaviour', () => {
    const result = { ok: true, identity: 'publisher 123' };
    const guarded = guardToolResult('affiliate_awin_verify_auth', result);
    expect(guarded.outcome).toBe('ok');
    expect(guarded.text).toBe(JSON.stringify(result, null, 2));
  });

  it('serialises a bare undefined result as null, matching JSON.stringify-in-content semantics', () => {
    const guarded = guardToolResult('affiliate_awin_verify_auth', undefined);
    expect(guarded.outcome).toBe('ok');
    expect(JSON.parse(guarded.text)).toBeNull();
  });

  it('switches to compact serialisation above the pretty-print limit', () => {
    const rows = makeRows(1200);
    const pretty = JSON.stringify(rows, null, 2);
    expect(Buffer.byteLength(pretty, 'utf8')).toBeGreaterThan(PRETTY_PRINT_LIMIT_BYTES);

    const guarded = guardToolResult('affiliate_awin_list_transactions', rows);
    expect(guarded.outcome).toBe('ok');
    expect(guarded.text).toBe(JSON.stringify(rows));
    expect(JSON.parse(guarded.text)).toEqual(rows);
  });

  it('returns an honest truncated-list envelope when a list overflows the budget', () => {
    const rows = makeRows(50_000, 200); // ~12 MB compact, far over the default budget
    const guarded = guardToolResult('affiliate_awin_list_transactions', rows);

    expect(guarded.outcome).toBe('truncated_list');
    expect(Buffer.byteLength(guarded.text, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_RESULT_BUDGET_BYTES,
    );

    const envelope = JSON.parse(guarded.text) as {
      items: unknown[];
      truncated: boolean;
      returnedCount: number;
      totalCount: number;
      nextOffset: number;
      hint: string;
    };
    expect(envelope.truncated).toBe(true);
    expect(envelope.totalCount).toBe(50_000);
    expect(envelope.returnedCount).toBe(envelope.items.length);
    expect(envelope.returnedCount).toBeGreaterThan(0);
    expect(envelope.returnedCount).toBeLessThan(envelope.totalCount);
    // The prefix is the original data, untransformed.
    expect(envelope.items[0]).toEqual(rows[0]);
    expect(envelope.items[envelope.returnedCount - 1]).toEqual(rows[envelope.returnedCount - 1]);
    // Hint phasing (decision record §3): offset shipped, so the envelope now
    // carries the continuation point and the hint names it.
    expect(envelope.nextOffset).toBe(envelope.returnedCount);
    expect(envelope.hint).toContain('offset');
  });

  it('continues nextOffset from the request offset', () => {
    const rows = makeRows(50_000, 200);
    const guarded = guardToolResult('affiliate_awin_list_transactions', rows, undefined, 300);
    expect(guarded.outcome).toBe('truncated_list');
    const envelope = JSON.parse(guarded.text) as { returnedCount: number; nextOffset: number };
    expect(envelope.nextOffset).toBe(300 + envelope.returnedCount);
  });

  it('returns the largest prefix that fits', () => {
    process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'] = '2000';
    const rows = makeRows(100, 50);
    const guarded = guardToolResult('affiliate_awin_list_transactions', rows);
    expect(guarded.outcome).toBe('truncated_list');
    const envelope = JSON.parse(guarded.text) as { items: unknown[]; returnedCount: number };

    // One more item must not fit.
    const oneMore = JSON.stringify({
      items: rows.slice(0, envelope.returnedCount + 1),
      truncated: true,
      returnedCount: envelope.returnedCount + 1,
      totalCount: rows.length,
      nextOffset: envelope.returnedCount + 1,
      hint: (JSON.parse(guarded.text) as { hint: string }).hint,
    });
    expect(Buffer.byteLength(guarded.text, 'utf8')).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(oneMore, 'utf8')).toBeGreaterThan(2000);
  });

  it('returns result_too_large for an oversized non-list result', () => {
    const result = { brand: 'acme', format: 'csv', csv: 'x'.repeat(1_000_000) };
    const guarded = guardToolResult('affiliate_get_brand_rows', result);

    expect(guarded.outcome).toBe('result_too_large');
    const payload = JSON.parse(guarded.text) as {
      error: string;
      tool: string;
      resultBytes: number;
      budgetBytes: number;
      itemCount?: number;
      hint: string;
    };
    expect(payload.error).toBe('result_too_large');
    expect(payload.tool).toBe('affiliate_get_brand_rows');
    expect(payload.resultBytes).toBeGreaterThan(payload.budgetBytes);
    expect(payload.budgetBytes).toBe(DEFAULT_RESULT_BUDGET_BYTES);
    expect(payload.itemCount).toBeUndefined();
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it('returns result_too_large with itemCount when not even a one-item envelope fits', () => {
    process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'] = '500';
    const rows = [{ id: 'txn-0', rawNetworkData: 'x'.repeat(2_000) }, { id: 'txn-1' }];
    const guarded = guardToolResult('affiliate_awin_list_transactions', rows);
    expect(guarded.outcome).toBe('result_too_large');
    const payload = JSON.parse(guarded.text) as { itemCount?: number };
    expect(payload.itemCount).toBe(2);
  });

  it('respects an explicit budget argument over the environment', () => {
    const rows = makeRows(100, 50);
    const guarded = guardToolResult('affiliate_awin_list_transactions', rows, 2_000);
    expect(guarded.outcome).toBe('truncated_list');
  });
});
