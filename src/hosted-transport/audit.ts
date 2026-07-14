/**
 * Per-user audit log for the hosted MCP transport (H4).
 *
 * One append-only stderr line per tool call: `userId`, `network`,
 * `operation`, `timestamp`, `outcome`. NEVER tool arguments, NEVER results —
 * this is the audit trail the workstream brief scoped ("network, operation,
 * timestamp; never payloads"), not a debugging log. `createLogger` (shared
 * with every other component) already redacts any field whose key looks like
 * a token/secret/key/password, but the real control here is simpler and
 * stronger: this module is never handed the arguments or the result in the
 * first place, so there is nothing sensitive for redaction to catch or miss.
 *
 * This is stderr, not durable storage — a restart loses history. A durable,
 * queryable audit store (so a user or Rob can review "what ran against my
 * account") is later hardening, not part of this slice's contract.
 */

import { createLogger } from '../shared/logging.js';

const log = createLogger('hosted-transport');

export type AuditOutcome = 'success' | 'error' | 'denied' | 'rate_limited';

export interface HostedAuditEvent {
  userId: string;
  network: string;
  operation: string;
  outcome: AuditOutcome;
}

/** Record one audit line. `timestamp` is stamped here, in ISO-8601, so callers never have to. */
export function recordHostedAudit(event: HostedAuditEvent): void {
  log.info(
    {
      userId: event.userId,
      network: event.network,
      operation: event.operation,
      timestamp: new Date().toISOString(),
      outcome: event.outcome,
    },
    'hosted tool call',
  );
}
