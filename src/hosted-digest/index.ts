/**
 * Public entrypoint for the hosted-digest job (H6). Re-exports the pieces a
 * caller needs: `runHostedDigest` for the CLI subcommand
 * (`src/index.ts`, `hosted-digest`) and for tests, and
 * `loadHostedDigestConfig` to read `process.env` the same way the CLI does.
 *
 * Runnable as `affiliate-networks-mcp hosted-digest` — a single run, then
 * exit. There is no in-process scheduler; run it on a schedule via cron or a
 * systemd timer. Example crontab entry (once a week, Monday 06:00):
 *
 *   0 6 * * 1 cd /path/to/affiliate-mcp && HOSTED_AUTH_URL=... HOSTED_VAULT_URL=... \
 *     HOSTED_SERVICE_SECRET=... /usr/bin/node dist/index.js hosted-digest >> /var/log/affiliate-mcp-digest.log 2>&1
 *
 * Example systemd timer/service pair (`affiliate-mcp-digest.timer` +
 * `affiliate-mcp-digest.service`), for a host that prefers systemd over cron:
 *
 *   # affiliate-mcp-digest.service
 *   [Service]
 *   Type=oneshot
 *   EnvironmentFile=/etc/affiliate-mcp/digest.env
 *   ExecStart=/usr/bin/node /opt/affiliate-mcp/dist/index.js hosted-digest
 *
 *   # affiliate-mcp-digest.timer
 *   [Timer]
 *   OnCalendar=Mon *-*-* 06:00:00
 *   Persistent=true
 *   [Install]
 *   WantedBy=timers.target
 *
 * Exit code is non-zero only when the job itself could not run at all (the
 * roster call failed); a per-user failure is recorded in the run summary and
 * logged to stderr, but does not fail the whole run — see `run.ts`.
 */

export { runDigestForSubscriber, runHostedDigest, type DigestRunSummary, type DigestSendRecord, type UserRunError } from './run.js';
export { loadHostedDigestConfig, type HostedDigestConfig } from './env.js';
export { composeEarningsDigest, composeUnpaidCommissionsDigest, type ComposedDigest, type DigestType, type NetworkEarningsResult } from './compose.js';
export { listSubscribers, issueServiceSession, sendDigest, HostedDigestServiceError, type Subscriber, type DigestSendOutcome } from './service-client.js';

import { createLogger } from '../shared/logging.js';
import { loadHostedDigestConfig } from './env.js';
import { runHostedDigest } from './run.js';

const log = createLogger('hosted-digest');

/** CLI entrypoint body: run once, log a summary, and signal failure via the return code. Called
 * by `src/index.ts`'s `hosted-digest` subcommand. */
export async function runHostedDigestCli(): Promise<number> {
  const config = loadHostedDigestConfig();
  try {
    const summary = await runHostedDigest(config);
    if (summary.errors.length > 0) {
      log.warn({ errorCount: summary.errors.length }, 'hosted digest run completed with per-user errors');
    }
    return 0;
  } catch (err) {
    log.error({ message: (err as Error).message }, 'hosted digest run failed to start');
    return 1;
  }
}
