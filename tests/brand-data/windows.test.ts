import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketByWindow,
  chunkDayRange,
  dayInBounds,
  dayInZone,
  startOfYear,
  windowBounds,
} from '../../src/brand-data/windows.js';

describe('dayInZone', () => {
  it('resolves the calendar day in the target timezone', () => {
    // 23:30 UTC on 30 June is still 30 June in London (BST, +1 -> 00:30 1 July).
    expect(dayInZone('2026-06-30T23:30:00Z', 'Europe/London')).toBe('2026-07-01');
    // The same instant in New York is still 30 June (19:30).
    expect(dayInZone('2026-06-30T23:30:00Z', 'America/New_York')).toBe('2026-06-30');
  });
});

describe('addDays', () => {
  it('rolls over months and years correctly', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29'); // leap year
  });
});

describe('startOfYear', () => {
  it('returns 1 January of the given day', () => {
    expect(startOfYear('2026-06-15')).toBe('2026-01-01');
  });
});

describe('windowBounds', () => {
  it('anchors the four windows on the reference day', () => {
    const b = windowBounds('2026-06-30T10:00:00Z', 'Europe/London');
    expect(b.yesterday).toEqual({ from: '2026-06-29', to: '2026-06-29' });
    expect(b.last7d).toEqual({ from: '2026-06-24', to: '2026-06-30' });
    expect(b.last30d).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(b.ytd).toEqual({ from: '2026-01-01', to: '2026-06-30' });
  });
});

describe('dayInBounds', () => {
  it('is inclusive of both ends', () => {
    const bounds = { from: '2026-06-01', to: '2026-06-30' };
    expect(dayInBounds('2026-06-01', bounds)).toBe(true);
    expect(dayInBounds('2026-06-30', bounds)).toBe(true);
    expect(dayInBounds('2026-05-31', bounds)).toBe(false);
    expect(dayInBounds('2026-07-01', bounds)).toBe(false);
  });
});

describe('chunkDayRange', () => {
  it('splits a range into <=maxDays inclusive slices covering it exactly', () => {
    expect(chunkDayRange('2026-01-01', '2026-01-10', 31)).toEqual([
      { from: '2026-01-01', to: '2026-01-10' },
    ]);
    const slices = chunkDayRange('2026-01-01', '2026-03-15', 31);
    expect(slices).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-03-03' },
      { from: '2026-03-04', to: '2026-03-15' },
    ]);
    // Contiguous, no gaps or overlaps.
    expect(slices[0]?.to && addDays(slices[0].to, 1)).toBe(slices[1]?.from);
  });

  it('returns [] when from is after to', () => {
    expect(chunkDayRange('2026-02-01', '2026-01-01')).toEqual([]);
  });
});

describe('bucketByWindow', () => {
  const asOf = '2026-06-30T10:00:00Z';
  const rows = [
    { d: '2026-06-29T12:00:00Z' }, // yesterday -> in all four
    { d: '2026-06-26T12:00:00Z' }, // within 7d -> 7d, 30d, ytd
    { d: '2026-06-10T12:00:00Z' }, // within 30d -> 30d, ytd
    { d: '2026-02-01T12:00:00Z' }, // earlier this year -> ytd only
    { d: '2025-12-31T12:00:00Z' }, // last year -> none
  ];

  it('places a row in every window whose range contains its event date', () => {
    const out = bucketByWindow(rows, (r) => r.d, asOf, 'Europe/London');
    expect(out.yesterday).toHaveLength(1);
    expect(out.last7d).toHaveLength(2);
    expect(out.last30d).toHaveLength(3);
    expect(out.ytd).toHaveLength(4);
  });
});
