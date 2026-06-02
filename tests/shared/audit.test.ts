/**
 * Tests for `src/shared/audit.ts`.
 *
 * Covers:
 *   - path resolution honouring AFFILIATE_MCP_CONFIG_DIR
 *   - append + read round-trip, timestamp stamping, JSON Lines format, 0600
 *   - missing-log default, malformed-line throw
 *   - countAppliedToday: matches subject/network/actionClass + UTC day, counts
 *     only `applied`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendAudit,
  countAppliedToday,
  readAudit,
  resolveAuditLog,
} from '../../src/shared/audit.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-audit-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

const applied = (over: Partial<Parameters<typeof appendAudit>[0]> = {}) => ({
  event: 'applied' as const,
  network: 'awin',
  operation: 'generateTrackingLink',
  subject: 'self',
  actionClass: 'link.generate',
  via: 'token' as const,
  ...over,
});

describe('resolveAuditLog', () => {
  it('honours AFFILIATE_MCP_CONFIG_DIR', () => {
    expect(resolveAuditLog()).toBe(path.join(tmp, 'audit.log'));
  });
});

describe('readAudit', () => {
  it('returns [] when the log is missing', () => {
    expect(readAudit()).toEqual([]);
  });

  it('throws on a malformed line, naming the line number', () => {
    appendAudit(applied());
    // Corrupt by appending a bad line through the raw file.
    appendFileSync(path.join(tmp, 'audit.log'), 'not json\n');
    expect(() => readAudit()).toThrow(/line 2 is not valid JSON/);
  });
});

describe('appendAudit + readAudit', () => {
  it('round-trips and stamps a timestamp', () => {
    appendAudit(applied());
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('applied');
    expect(rows[0]?.timestamp).toBeTypeOf('string');
  });

  it('preserves an explicit timestamp', () => {
    appendAudit(applied({ timestamp: '2026-06-01T12:00:00Z' }));
    expect(readAudit()[0]?.timestamp).toBe('2026-06-01T12:00:00Z');
  });

  it('appends rather than overwrites', () => {
    appendAudit(applied());
    appendAudit({ event: 'denied', network: 'awin', operation: 'x', subject: 'self', actionClass: 'a.b' });
    expect(readAudit()).toHaveLength(2);
  });

  it('writes JSON Lines (one record per line)', () => {
    appendAudit(applied());
    appendAudit(applied());
    const text = readFileSync(path.join(tmp, 'audit.log'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('writes the log at mode 0600', () => {
    appendAudit(applied());
    expect(statSync(path.join(tmp, 'audit.log')).mode & 0o077).toBe(0);
  });
});

describe('countAppliedToday', () => {
  const now = new Date('2026-06-02T09:00:00Z');

  it('counts applied entries for the matching triple on the UTC day', () => {
    appendAudit(applied({ timestamp: '2026-06-02T01:00:00Z' }));
    appendAudit(applied({ timestamp: '2026-06-02T23:00:00Z' }));
    expect(
      countAppliedToday({ subject: 'self', network: 'awin', actionClass: 'link.generate', now }),
    ).toBe(2);
  });

  it('ignores other days', () => {
    appendAudit(applied({ timestamp: '2026-06-01T23:59:59Z' }));
    expect(
      countAppliedToday({ subject: 'self', network: 'awin', actionClass: 'link.generate', now }),
    ).toBe(0);
  });

  it('ignores non-applied events and other triples', () => {
    appendAudit(applied({ timestamp: '2026-06-02T01:00:00Z', event: 'proposed' }));
    appendAudit(applied({ timestamp: '2026-06-02T01:00:00Z', network: 'cj' }));
    appendAudit(applied({ timestamp: '2026-06-02T01:00:00Z', actionClass: 'commission.adjust' }));
    expect(
      countAppliedToday({ subject: 'self', network: 'awin', actionClass: 'link.generate', now }),
    ).toBe(0);
  });
});
