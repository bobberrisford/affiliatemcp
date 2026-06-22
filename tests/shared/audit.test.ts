import { describe, expect, it } from 'vitest';
import {
  recordActionAudit,
  toAuditLine,
  type ActionAuditEntry,
  type ActionAuditEvent,
} from '../../src/shared/audit.js';

// The logger redacts any property whose key matches this pattern (see
// src/shared/logging.ts). Fields we intend to keep visible must not match it.
const REDACT_KEY = /token|secret|key|password|authorization/i;

describe('audit event vocabulary', () => {
  it('has no generic `succeeded` event — success is only ever `applied`', () => {
    const events: ActionAuditEvent[] = [
      'proposed',
      'dry_run',
      'applied',
      'apply_failed',
      'handoff_emitted',
    ];
    // @ts-expect-error `succeeded` is deliberately not part of the vocabulary.
    const bad: ActionAuditEvent = 'succeeded';
    expect(events).not.toContain(bad);
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
      event: 'applied',
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
  it('records every event type without throwing', () => {
    const events: ActionAuditEvent[] = [
      'proposed',
      'dry_run',
      'applied',
      'apply_failed',
      'handoff_emitted',
    ];
    for (const event of events) {
      expect(() =>
        recordActionAudit({ event, action: 'test.action', network: 'test' }),
      ).not.toThrow();
    }
  });
});
