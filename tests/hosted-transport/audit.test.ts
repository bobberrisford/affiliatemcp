/**
 * Unit test for the hosted-transport audit log's "never payloads" contract
 * (H4). `recordHostedAudit`'s own signature (`HostedAuditEvent`) cannot
 * accept tool arguments or a result at all — there is no parameter to smuggle
 * them through — but this test proves what actually reaches the logger, by
 * mocking `../../src/shared/logging.js` rather than trying to intercept
 * `pino`'s real destination. `src/shared/logging.ts` binds its logger to
 * `pino.destination({fd: 2, sync: false})`, which writes via a raw file
 * descriptor (sonic-boom) and bypasses `process.stderr.write` entirely, so it
 * cannot be reliably captured from a test — the same limitation
 * `tests/shared/logging.test.ts` already documents.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above every other statement in this file,
// so `infoSpy` must be created inside `vi.hoisted` — a plain `const` here
// would still be in its temporal dead zone when the factory below runs.
const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));

vi.mock('../../src/shared/logging.js', () => ({
  createLogger: () => ({ info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { recordHostedAudit } from '../../src/hosted-transport/audit.js';

beforeEach(() => {
  infoSpy.mockClear();
});

describe('recordHostedAudit', () => {
  it('logs exactly userId, network, operation, timestamp, and outcome — nothing else', () => {
    recordHostedAudit({ userId: 'hosted_usr_abc', network: 'cj', operation: 'verify_auth', outcome: 'success' });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [fields, message] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('hosted tool call');
    expect(Object.keys(fields).sort()).toEqual(
      ['network', 'operation', 'outcome', 'timestamp', 'userId'].sort(),
    );
    expect(fields['userId']).toBe('hosted_usr_abc');
    expect(fields['network']).toBe('cj');
    expect(fields['operation']).toBe('verify_auth');
    expect(fields['outcome']).toBe('success');
    expect(typeof fields['timestamp']).toBe('string');
    expect(() => new Date(fields['timestamp'] as string).toISOString()).not.toThrow();
  });

  it.each(['success', 'error', 'denied', 'rate_limited'] as const)(
    'accepts the "%s" outcome and logs it verbatim',
    (outcome) => {
      recordHostedAudit({ userId: 'u', network: 'awin', operation: 'list_transactions', outcome });
      const [fields] = infoSpy.mock.calls[0] as [Record<string, unknown>];
      expect(fields['outcome']).toBe(outcome);
    },
  );
});
