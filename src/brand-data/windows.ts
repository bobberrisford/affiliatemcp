/**
 * Brand Data Layer — time windows.
 *
 * Buckets rows by event date into the four windows (yesterday, rolling 7d,
 * rolling 30d, YTD), midnight-to-midnight in one canonical brand timezone
 * (default `Europe/London`). Minor day-boundary bleed from networks reporting
 * in their own zone is accepted and footnoted, not engineered away (brief §6).
 *
 * Everything here is pure: the reference instant `asOf` is passed in rather
 * than read from the clock, so windows are deterministic and testable.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import { DEFAULT_BRAND_TIMEZONE, WINDOW_KEYS, type WindowKey } from './model.js';

/** An inclusive `[from, to]` day range, both `YYYY-MM-DD`. */
export interface WindowBounds {
  from: string;
  to: string;
}

/**
 * The calendar day (`YYYY-MM-DD`) an ISO instant falls on in `timezone`.
 * Uses `Intl` so no date dependency is needed; `en-CA` yields ISO order.
 *
 * Formatters are cached per timezone — `dayInZone` is called once per row when
 * bucketing or aggregating, so constructing a formatter each call would be the
 * hot path at the 10k-row cap.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function dayInZone(iso: string, timezone: string = DEFAULT_BRAND_TIMEZONE): string {
  const date = new Date(iso);
  // A malformed or empty date (some networks aggregate over a range and leave
  // the field empty) must not crash the snapshot. Return '' so the row matches
  // no window rather than throwing on Intl.format.
  if (Number.isNaN(date.getTime())) return '';
  let fmt = dayFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timezone, fmt);
  }
  // en-CA formats as YYYY-MM-DD.
  return fmt.format(date);
}

/**
 * Add `n` whole days to a `YYYY-MM-DD` value, returning `YYYY-MM-DD`. Pure
 * calendar arithmetic at UTC midnight (UTC has no DST), so it never drifts.
 */
export function addDays(day: string, n: number): string {
  const parts = day.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear().toString().padStart(4, '0');
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = dt.getUTCDate().toString().padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** First day of the calendar year of `day`. */
export function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

/**
 * Split an inclusive `[from, to]` day range into consecutive slices of at most
 * `maxDays` days each. Awin's transaction endpoints (advertiser and publisher)
 * cap a single query at ~31 days; the brand-data pull chunks here because the
 * advertiser adapter, unlike the publisher one, does not chunk internally.
 */
export function chunkDayRange(from: string, to: string, maxDays = 31): WindowBounds[] {
  if (from > to) return [];
  const out: WindowBounds[] = [];
  let start = from;
  while (start <= to) {
    let end = addDays(start, maxDays - 1);
    if (end > to) end = to;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

/**
 * The inclusive day bounds for each window, anchored on `asOf` interpreted in
 * `timezone`. `yesterday` is the single completed canonical day; `last7d` and
 * `last30d` are rolling and end today (today may be partial); `ytd` runs from
 * 1 January through today inclusive.
 */
export function windowBounds(
  asOf: string,
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): Record<WindowKey, WindowBounds> {
  const today = dayInZone(asOf, timezone);
  const yesterday = addDays(today, -1);
  return {
    yesterday: { from: yesterday, to: yesterday },
    last7d: { from: addDays(today, -6), to: today },
    last30d: { from: addDays(today, -29), to: today },
    ytd: { from: startOfYear(today), to: today },
  };
}

/** Whether `day` (YYYY-MM-DD) is within an inclusive bounds range. */
export function dayInBounds(day: string, bounds: WindowBounds): boolean {
  return day >= bounds.from && day <= bounds.to;
}

/**
 * Partition rows into the four windows by their event date. A row can appear in
 * several windows (yesterday is within 7d within 30d within YTD), so each
 * window gets its own filtered array. `getEventDate` extracts the ISO instant
 * (or `YYYY-MM-DD`) that should be bucketed.
 */
export function bucketByWindow<T>(
  rows: T[],
  getEventDate: (row: T) => string,
  asOf: string,
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): Record<WindowKey, T[]> {
  const bounds = windowBounds(asOf, timezone);
  const out = {
    yesterday: [] as T[],
    last7d: [] as T[],
    last30d: [] as T[],
    ytd: [] as T[],
  } satisfies Record<WindowKey, T[]>;
  for (const row of rows) {
    const day = dayInZone(getEventDate(row), timezone);
    for (const key of WINDOW_KEYS) {
      if (dayInBounds(day, bounds[key])) out[key].push(row);
    }
  }
  return out;
}
