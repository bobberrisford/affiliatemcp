import { describe, expect, it } from 'vitest';
import {
  ACTION_AUDIT_EVENTS,
  countMutatingHandoffsOn,
  recordActionAudit,
  toAuditLine,
  type ActionAuditEntry,
  type ActionAuditEvent,
} from '../../src/shared/audit.js';

// The logger redacts any property whose key matches this pattern (see
// src/shared/logging.ts). Fields we intend to keep visible must not match it.
const REDACT_KEY = /token|secret|key|password|authorization/i;

describe('audit event vocabulary', () => {
  it('keeps denied, dispatched, rejected, unknown, and verified writes distinct', () => {
    const events: ActionAuditEvent[] = [
      'proposed',
      'dry_run',
      'write_denied',
      'write_dispatched',
      'write_rejected',
      'write_unknown',
      'write_verified',
      'handoff_emitted',
      'verified',
      'verify_failed',
    ];
    expect(ACTION_AUDIT_EVENTS).toEqual(events);
    // @ts-expect-error `succeeded` is deliberately not part of the vocabulary.
    const bad: ActionAuditEvent = 'succeeded';
    expect(events).not.toContain(bad);
    expect(events).not.toContain('applied');
    expect(events).not.toContain('apply_failed');
  });

  it('accepts the verify-closure events that close the handoff arc', () => {
    const verified: ActionAuditEvent = 'verified';
    const verifyFailed: ActionAuditEvent = 'verify_failed';
    expect(ACTION_AUDIT_EVENTS).toContain(verified);
    expect(ACTION_AUDIT_EVENTS).toContain(verifyFailed);
  });
});

describe('toAuditLine', () => {
  it('prefixes the message with the event and echoes the entry', () => {
    const entry: ActionAuditEntry = {
      event: 'proposed',
      action: 'impact-advertiser.proposeContract',
      network: 'impact-advertiser',
      brand: 'acme',
      programmeId: 'CMP-42',
      summary: 'Update contract CT-1',
    };
    const line = toAuditLine(entry);
    expect(line.msg).toBe('action_audit:proposed');
    expect(line.audit).toEqual(entry);
  });

  it('uses redaction-safe key names for the hash and tier', () => {
    const entry: ActionAuditEntry = {
      event: 'write_verified',
      action: 'impact-advertiser.applyContract',
      network: 'impact-advertiser',
      credentialTier: 'write',
      planHash: 'a'.repeat(64),
    };
    // planHash / credentialTier must survive the logger's key redaction so the
    // plan -> apply trail stays auditable (a token-named key would be redacted).
    for (const key of Object.keys(entry)) {
      expect(REDACT_KEY.test(key), `audit key "${key}" would be redacted`).toBe(false);
    }
  });
});

describe('recordActionAudit', () => {
  it('records every event type without throwing for the active logger', () => {
    for (const event of ACTION_AUDIT_EVENTS) {
      expect(() =>
        recordActionAudit({ event, action: 'test.action', network: 'test' }),
      ).not.toThrow();
    }
  });

  it('round-trips verify-closure entries through toAuditLine', () => {
    for (const event of ['verified', 'verify_failed'] as const) {
      const entry: ActionAuditEntry = {
        event,
        action: 'impact-advertiser.applyContract',
        network: 'impact-advertiser',
        contractId: 'CT-1',
        summary: 'Revisited the verify target',
      };
      const line = toAuditLine(entry);
      expect(line.msg).toBe(`action_audit:${event}`);
      expect(line.audit).toEqual(entry);
      expect(() => recordActionAudit(entry)).not.toThrow();
    }
  });
});

describe('countMutatingHandoffsOn', () => {
  const day = '2026-06-23';
  const mutatingHandoff = (occurredAt: string): ActionAuditEntry => ({
    event: 'handoff_emitted',
    action: 'impact-advertiser.applyContract',
    network: 'impact-advertiser',
    intendedAfterState: { status: 'pending' },
    occurredAt,
  });

  it('counts only mutating handoffs emitted on the given day', () => {
    const entries: ActionAuditEntry[] = [
      mutatingHandoff(`${day}T09:00:00.000Z`),
      mutatingHandoff(`${day}T23:59:59.000Z`),
    ];
    expect(countMutatingHandoffsOn(entries, day)).toBe(2);
  });

  it('ignores handoffs on other days', () => {
    const entries: ActionAuditEntry[] = [
      mutatingHandoff(`${day}T09:00:00.000Z`),
      mutatingHandoff('2026-06-22T23:59:59.000Z'),
      mutatingHandoff('2026-06-24T00:00:00.000Z'),
    ];
    expect(countMutatingHandoffsOn(entries, day)).toBe(1);
  });

  it('ignores non-mutating handoffs (no intendedAfterState)', () => {
    const readOnlyHandoff: ActionAuditEntry = {
      event: 'handoff_emitted',
      action: 'impact-advertiser.viewReport',
      network: 'impact-advertiser',
      occurredAt: `${day}T10:00:00.000Z`,
    };
    expect(countMutatingHandoffsOn([readOnlyHandoff], day)).toBe(0);
  });

  it('ignores other events and entries without an occurredAt', () => {
    const entries: ActionAuditEntry[] = [
      {
        event: 'write_verified',
        action: 'impact-advertiser.applyContract',
        network: 'impact-advertiser',
        intendedAfterState: { status: 'approved' },
        occurredAt: `${day}T11:00:00.000Z`,
      },
      {
        event: 'handoff_emitted',
        action: 'impact-advertiser.applyContract',
        network: 'impact-advertiser',
        intendedAfterState: { status: 'pending' },
      },
    ];
    expect(countMutatingHandoffsOn(entries, day)).toBe(0);
  });

  it('returns zero for an empty trail', () => {
    expect(countMutatingHandoffsOn([], day)).toBe(0);
  });
});
