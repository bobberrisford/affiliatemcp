/**
 * Free-tier consumption meter (`docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`).
 *
 * The metered free tier allows a fixed number of "report windows" per rolling
 * 7 days, with no card. A window is opened by the first data tool call and
 * stays open for `WINDOW_MS`; every call inside that window is free and does
 * NOT open a new one, so a single natural-language question — which fans out to
 * several MCP tool calls — counts as one report, not several. The free tier is
 * allowed `FREE_WINDOWS_PER_WEEK` windows in any rolling 7-day span.
 *
 * The meter of record is durable KV (`HOSTED_BILLING`, keyed `meter:<userId>`),
 * not the transport's in-memory `rate-limiter.ts`: an in-memory counter resets
 * on every Worker/process restart and would silently grant unlimited free use.
 * It stores COUNTS AND TIMESTAMPS ONLY, keyed on the existing hosted `userId` —
 * no affiliate data, no credentials, no identifier the billing store does not
 * already hold. `PRIVACY.md` holds verbatim.
 *
 * `N` (3) and the window length (30 minutes) are the two tunable launch knobs
 * the decision record names; changing them needs no new decision as long as the
 * model (metered free windows, no card) is unchanged.
 *
 * Concurrency: `consumeFreeWindow` is a read-modify-write on one KV key with no
 * lock. KV offers no compare-and-set, so two truly simultaneous first-of-a-window
 * calls for the same user could each observe the pre-write state and both open a
 * window, granting at most one extra free window. This is the same
 * accepted-race posture `hosted/README.md` records for the vault data-key write;
 * over-counting is impossible and the worst case is one bonus free report, so no
 * lock is warranted for an MVP free tier.
 */

/** Free windows allowed per rolling 7 days. Tunable launch knob (decision 2026-07-18). */
export const FREE_WINDOWS_PER_WEEK = 3;

/** How long one report window stays open, in ms. Tunable launch knob (decision 2026-07-18). */
export const WINDOW_MS = 30 * 60 * 1000;

/** The rolling span the window count is measured over, in ms. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const meterKey = (userId: string): string => `meter:${userId}`;

/** Stored meter state: the start timestamps (unix ms) of each window opened in the last 7 days. */
interface MeterRecord {
  windows: number[];
}

/** The decision returned to the transport for one free-tier tool call. */
export interface MeterDecision {
  /** Whether this call may proceed. */
  allowed: boolean;
  /** Windows still available in the current rolling span after this call (0 when refused). */
  remaining: number;
  /** When the oldest counted window ages out and a window frees up, unix ms; null when the user
   * has used none, so nothing is pending a reset. */
  resetAt: number | null;
}

/**
 * Pure meter logic, separated from KV so it is exhaustively unit-testable
 * without a store. Given the windows opened so far and the current time,
 * decide whether this call proceeds and compute the window list to persist.
 *
 * - Prune windows older than `WEEK_MS` first (rolling span).
 * - If the most recent surviving window is still open (`now - start < WINDOW_MS`),
 *   the call is inside it: allowed, and the window list is unchanged (no new
 *   consumption).
 * - Otherwise this call would open a NEW window: allowed only if fewer than
 *   `FREE_WINDOWS_PER_WEEK` windows survive the prune; when allowed, `now` is
 *   appended.
 */
export function decideFreeWindow(
  windows: readonly number[],
  nowMs: number,
): { decision: MeterDecision; nextWindows: number[] } {
  const pruned = windows.filter((start) => nowMs - start < WEEK_MS).sort((a, b) => a - b);
  const oldest = pruned.length > 0 ? pruned[0] : undefined;
  const newest = pruned.length > 0 ? pruned[pruned.length - 1] : undefined;

  // Inside an already-open window: free, opens nothing new.
  if (newest !== undefined && nowMs - newest < WINDOW_MS) {
    return {
      decision: {
        allowed: true,
        remaining: Math.max(0, FREE_WINDOWS_PER_WEEK - pruned.length),
        resetAt: oldest !== undefined ? oldest + WEEK_MS : null,
      },
      nextWindows: pruned,
    };
  }

  // A new window is required. Refuse when the rolling span is already full.
  if (pruned.length >= FREE_WINDOWS_PER_WEEK) {
    return {
      decision: {
        allowed: false,
        remaining: 0,
        resetAt: oldest !== undefined ? oldest + WEEK_MS : null,
      },
      nextWindows: pruned,
    };
  }

  const nextWindows = [...pruned, nowMs];
  return {
    decision: {
      allowed: true,
      remaining: Math.max(0, FREE_WINDOWS_PER_WEEK - nextWindows.length),
      resetAt: nextWindows[0] + WEEK_MS,
    },
    nextWindows,
  };
}

/**
 * Read the caller's meter, decide this call, and persist the result. Writes
 * back only when the window list changed (a new window opened), so a call
 * inside an open window and a refused call are both read-only. The stored key
 * carries a `WEEK_MS` TTL so an inactive user's meter self-expires rather than
 * lingering in KV. Returns the `MeterDecision` the transport turns into either
 * "proceed" or a structured `free_quota_exceeded` refusal.
 */
export async function consumeFreeWindow(
  kv: KVNamespace,
  userId: string,
  nowMs: number,
): Promise<MeterDecision> {
  const raw = await kv.get(meterKey(userId));
  const record: MeterRecord = raw ? (JSON.parse(raw) as MeterRecord) : { windows: [] };
  const { decision, nextWindows } = decideFreeWindow(record.windows, nowMs);

  const changed =
    nextWindows.length !== record.windows.length ||
    nextWindows.some((v, i) => v !== record.windows[i]);
  if (changed) {
    await kv.put(meterKey(userId), JSON.stringify({ windows: nextWindows } satisfies MeterRecord), {
      expirationTtl: Math.ceil(WEEK_MS / 1000),
    });
  }
  return decision;
}
