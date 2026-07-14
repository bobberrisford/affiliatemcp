/**
 * Orchestrates one hosted-digest run (workstream slice H6:
 * `docs/product/hosted-mvp-workstream.md`). Cron-invoked, no in-process
 * scheduler — see `src/hosted-digest/README.md` for the crontab/systemd
 * timer this expects to be run under.
 *
 * For each subscribed user: mint a short-lived service session
 * (`service-client.ts`), list their connected networks and read each one's
 * `EarningsSummary` through the exact same H1 request-context seam and H4
 * vault-client the hosted MCP transport uses (`resolveCredentialOverlay`,
 * `listConnectedNetworks`, `runInRequestContext`) — this job is a second
 * caller of that seam, not a parallel reimplementation of it. Compose the
 * digest(s) the user's tier entitles them to (`compose.ts`), and hand the
 * composed text to the hosted Worker's `POST /digest/send`
 * (`service-client.ts`), which resolves the recipient's email itself — this
 * job never sees it.
 *
 * Never logs a composed digest's subject or body. The one line per send
 * carries exactly userId, digestType, timestamp, and outcome, mirroring
 * `src/hosted-transport/audit.ts`'s "never payloads" contract.
 */

import type { NetworkSlug } from '../shared/types.js';
import { getAdapter } from '../shared/registry.js';
import { runInRequestContext } from '../shared/request-context.js';
import { createLogger } from '../shared/logging.js';
import { resolveCredentialOverlay } from '../hosted-transport/dispatch.js';
import { listConnectedNetworks, VaultUnavailableError } from '../hosted-transport/vault-client.js';

// Side-effect import: registers every network adapter with the shared registry, matching
// `mcp-server.ts`'s own import — this job calls adapters directly, so it needs the same
// registration, not just the tool-generation layer.
import '../networks/index.js';

import type { HostedDigestConfig } from './env.js';
import { composeEarningsDigest, composeUnpaidCommissionsDigest, type DigestType, type NetworkEarningsResult } from './compose.js';
import {
  HostedDigestServiceError,
  issueServiceSession,
  listSubscribers,
  sendDigest,
  type DigestSendOutcome,
  type Subscriber,
} from './service-client.js';

const log = createLogger('hosted-digest');

const DIGEST_WINDOW_DAYS = 7;

function weekPeriod(): { from: string; to: string; label: string } {
  const to = new Date();
  const from = new Date(to.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => (d.toISOString().split('T')[0] as string);
  return { from: from.toISOString(), to: to.toISOString(), label: `${iso(from)} to ${iso(to)}` };
}

/** One audit line per send attempt. NEVER the composed subject/body. */
function recordDigestJobAudit(userId: string, digestType: DigestType, outcome: DigestSendOutcome | 'error'): void {
  log.info({ userId, digestType, timestamp: new Date().toISOString(), outcome }, 'hosted digest send');
}

/** Read one network's `EarningsSummary` under the given user's identity, using the caller's own
 * (service-minted) session token for the vault read — never invents a result on failure. */
async function readNetworkEarnings(
  userId: string,
  network: NetworkSlug,
  bearerToken: string,
  vaultUrl: string,
  period: { from: string; to: string },
): Promise<NetworkEarningsResult> {
  const overlay = await resolveCredentialOverlay(network, 'hosted_digest_earnings', bearerToken, vaultUrl);
  if (!overlay.ok) {
    return { network, ok: false, message: overlay.envelope.message };
  }
  const adapter = getAdapter(network);
  if (!adapter) {
    return { network, ok: false, message: `no adapter is registered for network "${network}"` };
  }
  try {
    const summary = await runInRequestContext({ identity: userId, credentials: overlay.credentials }, () =>
      adapter.getEarningsSummary({ from: period.from, to: period.to }),
    );
    return { network, ok: true, summary };
  } catch (err) {
    return { network, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface DigestSendRecord {
  userId: string;
  digestType: DigestType;
  outcome: DigestSendOutcome | 'error';
}

export interface UserRunError {
  userId: string;
  message: string;
}

export interface DigestRunSummary {
  subscriberCount: number;
  sends: DigestSendRecord[];
  errors: UserRunError[];
}

/** Run the digest job once for one subscriber. Exported separately from `runHostedDigest` so a
 * test can drive a single user's path without needing a full roster. */
export async function runDigestForSubscriber(
  config: HostedDigestConfig,
  subscriber: Subscriber,
): Promise<DigestSendRecord[]> {
  const period = weekPeriod();
  const sessionToken = await issueServiceSession(config.authUrl, config.serviceSecret, subscriber.userId);
  const networks = await listConnectedNetworks(sessionToken, config.vaultUrl);

  const results: NetworkEarningsResult[] = [];
  for (const network of networks) {
    results.push(await readNetworkEarnings(subscriber.userId, network, sessionToken, config.vaultUrl, period));
  }

  const records: DigestSendRecord[] = [];

  const earnings = composeEarningsDigest(results, period.label);
  const earningsOutcome = await sendDigest(config.authUrl, config.serviceSecret, {
    userId: subscriber.userId,
    digestType: 'earnings',
    subject: earnings.subject,
    body: earnings.body,
  });
  recordDigestJobAudit(subscriber.userId, 'earnings', earningsOutcome);
  records.push({ userId: subscriber.userId, digestType: 'earnings', outcome: earningsOutcome });

  if (subscriber.tier === 'pro') {
    const unpaid = composeUnpaidCommissionsDigest(results, period.label);
    const unpaidOutcome = await sendDigest(config.authUrl, config.serviceSecret, {
      userId: subscriber.userId,
      digestType: 'unpaid-commissions',
      subject: unpaid.subject,
      body: unpaid.body,
    });
    recordDigestJobAudit(subscriber.userId, 'unpaid-commissions', unpaidOutcome);
    records.push({ userId: subscriber.userId, digestType: 'unpaid-commissions', outcome: unpaidOutcome });
  }

  return records;
}

/** Run the digest job for every currently-subscribed user. Errors for one user (a vault outage,
 * an unreadable network) never abort the run for the rest of the roster — each user's failure is
 * recorded and the job continues, matching the brief's "for each subscribed user" framing. */
export async function runHostedDigest(config: HostedDigestConfig): Promise<DigestRunSummary> {
  const subscribers = await listSubscribers(config.authUrl, config.serviceSecret);
  const sends: DigestSendRecord[] = [];
  const errors: UserRunError[] = [];

  for (const subscriber of subscribers) {
    try {
      sends.push(...(await runDigestForSubscriber(config, subscriber)));
    } catch (err) {
      const message =
        err instanceof HostedDigestServiceError || err instanceof VaultUnavailableError || err instanceof Error
          ? err.message
          : String(err);
      log.warn({ userId: subscriber.userId, message }, 'hosted digest run failed for user');
      errors.push({ userId: subscriber.userId, message });
    }
  }

  log.info(
    { subscriberCount: subscribers.length, sent: sends.length, errored: errors.length },
    'hosted digest run complete',
  );
  return { subscriberCount: subscribers.length, sends, errors };
}
