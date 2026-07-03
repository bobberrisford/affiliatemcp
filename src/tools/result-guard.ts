/**
 * Tool-result size guard.
 *
 * Claude clients cap the size of an MCP tool result at roughly 1 MB; a result
 * over the cap is rejected or truncated client-side after the upstream work is
 * already done. This module keeps every response under a byte budget at the
 * single dispatch choke point in `server.ts`, per the accepted decision
 * `docs/decisions/2026-07-03-tool-result-size-budget.md`:
 *
 *   1. small results stay pretty-printed for human inspection;
 *   2. large results are serialised compactly (pretty-printing inflates row
 *      data by roughly two to three times);
 *   3. a result that is still over budget degrades honestly (principle 4.1):
 *      a top-level array returns the largest prefix that fits inside an
 *      explicit truncated-list envelope with counts; anything else returns a
 *      structured `result_too_large` payload naming the sizes and the remedy.
 *
 * Overflow hints name only remedies that exist today (narrower filters and
 * smaller limits). The `offset` paging and `format: "file"` hints arrive with
 * the PRs that ship those remedies.
 */

/** Default response budget: headroom under the ~1 MB client limit. */
export const DEFAULT_RESULT_BUDGET_BYTES = 800_000;

/** Above this pretty-printed size, switch to compact serialisation. */
export const PRETTY_PRINT_LIMIT_BYTES = 64_000;

/** Envelope returned when a top-level array overflows the budget. */
export interface TruncatedListResult {
  items: unknown[];
  truncated: true;
  returnedCount: number;
  totalCount: number;
  hint: string;
}

/** Payload returned when a non-list result overflows the budget. */
export interface ResultTooLarge {
  error: 'result_too_large';
  tool: string;
  resultBytes: number;
  budgetBytes: number;
  itemCount?: number;
  hint: string;
}

export interface GuardedResult {
  /** The serialised text to place in the MCP content block. */
  text: string;
  /** What the guard did. `result_too_large` should surface with isError. */
  outcome: 'ok' | 'truncated_list' | 'result_too_large';
}

const TRUNCATED_HINT =
  'The full result exceeds the client tool-result size limit. Narrow the date window or status filter, or pass a smaller limit, and repeat the call.';

const TOO_LARGE_HINT =
  'The result exceeds the client tool-result size limit and has no list shape the server can truncate honestly. Narrow the query (date window, filters, limit) and repeat the call.';

/**
 * The active budget. Reads `AFFILIATE_MCP_MAX_RESULT_BYTES` fresh on each call
 * (consistent with how the rest of the project treats env config); a missing,
 * empty, non-numeric, or non-positive value falls back to the default.
 */
export function resultBudgetBytes(): number {
  const raw = process.env['AFFILIATE_MCP_MAX_RESULT_BYTES'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESULT_BUDGET_BYTES;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_RESULT_BUDGET_BYTES;
  return parsed;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** JSON.stringify that never returns undefined (a bare `undefined` result). */
function stringify(value: unknown, pretty: boolean): string {
  return JSON.stringify(value, null, pretty ? 2 : 0) ?? 'null';
}

function buildTruncatedEnvelope(items: unknown[], totalCount: number): TruncatedListResult {
  return {
    items,
    truncated: true,
    returnedCount: items.length,
    totalCount,
    hint: TRUNCATED_HINT,
  };
}

/**
 * Largest prefix of `result` whose truncated-list envelope fits the budget,
 * found by binary search on the prefix length. Returns null when not even a
 * one-item envelope fits (a single oversized record).
 */
function truncateListToBudget(result: unknown[], budgetBytes: number): string | null {
  let low = 1;
  let high = result.length;
  let best: string | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = stringify(buildTruncatedEnvelope(result.slice(0, mid), result.length), false);
    if (utf8Bytes(candidate) <= budgetBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Serialise a tool result within the byte budget. Small results are returned
 * pretty-printed and byte-identical to the previous behaviour; everything else
 * follows the decision record's compact / truncate / refuse ladder.
 */
export function guardToolResult(
  toolName: string,
  result: unknown,
  budgetBytes: number = resultBudgetBytes(),
): GuardedResult {
  const pretty = stringify(result, true);
  if (utf8Bytes(pretty) <= Math.min(PRETTY_PRINT_LIMIT_BYTES, budgetBytes)) {
    return { text: pretty, outcome: 'ok' };
  }

  const compact = stringify(result, false);
  const compactBytes = utf8Bytes(compact);
  if (compactBytes <= budgetBytes) {
    return { text: compact, outcome: 'ok' };
  }

  if (Array.isArray(result) && result.length > 0) {
    const truncated = truncateListToBudget(result, budgetBytes);
    if (truncated !== null) {
      return { text: truncated, outcome: 'truncated_list' };
    }
  }

  const tooLarge: ResultTooLarge = {
    error: 'result_too_large',
    tool: toolName,
    resultBytes: compactBytes,
    budgetBytes,
    ...(Array.isArray(result) ? { itemCount: result.length } : {}),
    hint: TOO_LARGE_HINT,
  };
  return { text: stringify(tooLarge, true), outcome: 'result_too_large' };
}
