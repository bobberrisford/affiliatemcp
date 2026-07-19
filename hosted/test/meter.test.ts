/**
 * Unit tests for the free-tier consumption meter (`src/meter.ts`). The pure
 * `decideFreeWindow` is exercised directly; `consumeFreeWindow` uses the same
 * in-memory KV fake as the other `hosted/test/*.test.ts` files. Time is always
 * an explicit argument, so no clock is mocked. See
 * `docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`.
 */

import { describe, expect, it } from 'vitest';

import {
  consumeFreeWindow,
  decideFreeWindow,
  FREE_WINDOWS_PER_WEEK,
  WEEK_MS,
  WINDOW_MS,
} from '../src/meter.js';

const T0 = 1_700_000_000_000; // an arbitrary fixed "now" in ms; no wall clock is read

function fakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      void opts;
      store.set(k, v);
    },
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('decideFreeWindow', () => {
  it('allows the first-ever call and opens one window', () => {
    const { decision, nextWindows } = decideFreeWindow([], T0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(FREE_WINDOWS_PER_WEEK - 1);
    expect(nextWindows).toEqual([T0]);
    expect(decision.resetAt).toBe(T0 + WEEK_MS);
  });

  it('treats a call inside an open window as free and opens nothing new', () => {
    const openedAt = T0;
    const within = T0 + WINDOW_MS - 1;
    const { decision, nextWindows } = decideFreeWindow([openedAt], within);
    expect(decision.allowed).toBe(true);
    // One window already counted; the allowance is unchanged by an in-window call.
    expect(decision.remaining).toBe(FREE_WINDOWS_PER_WEEK - 1);
    expect(nextWindows).toEqual([openedAt]);
  });

  it('opens a new window once the previous one has closed', () => {
    const first = T0;
    const later = T0 + WINDOW_MS + 1;
    const { decision, nextWindows } = decideFreeWindow([first], later);
    expect(decision.allowed).toBe(true);
    expect(nextWindows).toEqual([first, later]);
    expect(decision.remaining).toBe(FREE_WINDOWS_PER_WEEK - 2);
  });

  it('refuses a new window once the rolling weekly allowance is spent', () => {
    // Three closed windows, all within the last 7 days.
    const windows = [T0, T0 + WINDOW_MS * 2, T0 + WINDOW_MS * 4];
    const now = T0 + WINDOW_MS * 6; // outside the last window, so a NEW window is required
    const { decision, nextWindows } = decideFreeWindow(windows, now);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(nextWindows).toEqual(windows); // nothing consumed on a refusal
    expect(decision.resetAt).toBe(T0 + WEEK_MS); // oldest window frees up first
  });

  it('frees capacity as windows age past the 7-day span', () => {
    const stale = T0 - WEEK_MS - 1; // older than the rolling span, should be pruned
    const recentA = T0 - WINDOW_MS * 4;
    const recentB = T0 - WINDOW_MS * 2;
    const { decision, nextWindows } = decideFreeWindow([stale, recentA, recentB], T0);
    // Only the two recent windows count, so a third is allowed.
    expect(decision.allowed).toBe(true);
    expect(nextWindows).toEqual([recentA, recentB, T0]);
    expect(decision.remaining).toBe(0);
  });
});

describe('consumeFreeWindow', () => {
  it('persists an opened window and returns the decision', async () => {
    const kv = fakeKV();
    const first = await consumeFreeWindow(kv, 'hosted_usr_free', T0);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(FREE_WINDOWS_PER_WEEK - 1);
    expect(kv.store.get('meter:hosted_usr_free')).toBe(JSON.stringify({ windows: [T0] }));
  });

  it('does not consume a second window for a call inside the first', async () => {
    const kv = fakeKV();
    await consumeFreeWindow(kv, 'u', T0);
    const second = await consumeFreeWindow(kv, 'u', T0 + WINDOW_MS - 1);
    expect(second.allowed).toBe(true);
    expect(kv.store.get('meter:u')).toBe(JSON.stringify({ windows: [T0] }));
  });

  it('refuses the (N+1)th distinct report window in a week', async () => {
    const kv = fakeKV();
    let t = T0;
    for (let i = 0; i < FREE_WINDOWS_PER_WEEK; i++) {
      const d = await consumeFreeWindow(kv, 'u', t);
      expect(d.allowed).toBe(true);
      t += WINDOW_MS + 1; // advance past the open window each time
    }
    const overCap = await consumeFreeWindow(kv, 'u', t);
    expect(overCap.allowed).toBe(false);
    expect(overCap.remaining).toBe(0);
    expect(overCap.resetAt).not.toBeNull();
  });

  it('keeps each user meter independent', async () => {
    const kv = fakeKV();
    for (let i = 0; i < FREE_WINDOWS_PER_WEEK; i++) {
      await consumeFreeWindow(kv, 'heavy', T0 + i * (WINDOW_MS + 1));
    }
    const heavy = await consumeFreeWindow(kv, 'heavy', T0 + FREE_WINDOWS_PER_WEEK * (WINDOW_MS + 1));
    const fresh = await consumeFreeWindow(kv, 'light', T0);
    expect(heavy.allowed).toBe(false);
    expect(fresh.allowed).toBe(true);
  });
});
