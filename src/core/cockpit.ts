/**
 * Cockpit summary — the desktop app's daily "attention flags" view.
 *
 * Provider-neutral, model-free domain logic. It calls a registered adapter's
 * existing canonical read operations and folds the results into a small set of
 * flags the desktop renderer paints. It performs NO model call and costs no
 * tokens; the heavy reasoning and any "doing" happen later, when the user
 * deep-links into Claude from a cockpit button.
 *
 * It is a pure registry consumer: it never imports the network index, so a test
 * can register a stub adapter and drive it directly. Credential loading
 * (`loadConfig`) is the caller's responsibility; the desktop IPC handler runs it
 * once before calling in.
 */

import type { EarningsByStatus, NetworkSlug } from '../shared/types.js';
import { getAdapter } from '../shared/registry.js';
import { getCredential } from '../shared/config.js';
import { NetworkError } from '../shared/errors.js';

export type CockpitFlagKind =
  | 'unpaid_over_threshold'
  | 'wow_swing'
  | 'pending_applications'
  | 'health';

export type CockpitSeverity = 'info' | 'warning' | 'error';

export interface CockpitFlag {
  kind: CockpitFlagKind;
  severity: CockpitSeverity;
  title: string;
  detail?: string;
}

export interface CockpitHeadline {
  totalEarnings: number;
  currency: string;
  byStatus: EarningsByStatus;
  periodFrom: string;
  periodTo: string;
}

export interface CockpitSummary {
  generatedAt: string;
  network: NetworkSlug;
  /** False when the adapter is unregistered or its credentials are not present. */
  configured: boolean;
  headline?: CockpitHeadline;
  flags: CockpitFlag[];
}

export interface ComputeCockpitOptions {
  /** Which network to summarise. Defaults to the reference publisher adapter. */
  slug?: NetworkSlug;
  /** Unpaid age (days) that raises a flag. Default 90. */
  unpaidThresholdDays?: number;
  /** Absolute week-over-week percentage change that raises a flag. Default 25. */
  wowThresholdPct?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number, base: Date): Date {
  return new Date(base.getTime() - n * 24 * 60 * 60 * 1000);
}

/** Dependency-free, deterministic money string. The renderer prettifies for display. */
function money(value: number, currency: string): string {
  return `${currency} ${value.toFixed(2)}`;
}

/**
 * Compute the daily attention-flag summary for one network from its read
 * operations. Never throws on a read failure: a failed read folds into a health
 * flag so the dashboard always renders.
 */
export async function computeCockpit(
  options: ComputeCockpitOptions = {},
): Promise<CockpitSummary> {
  const slug = options.slug ?? 'awin';
  const unpaidThresholdDays = options.unpaidThresholdDays ?? 90;
  const wowThresholdPct = options.wowThresholdPct ?? 25;
  const generatedAt = new Date().toISOString();

  const adapter = getAdapter(slug);
  if (!adapter) {
    return {
      generatedAt,
      network: slug,
      configured: false,
      flags: [
        {
          kind: 'health',
          severity: 'error',
          title: `${slug} is not connected`,
          detail: 'Run setup to connect this network.',
        },
      ],
    };
  }

  // Cheap, network-free configured check: are this adapter's credential fields
  // present? Reuses the adapter's own setup contract rather than hardcoding env
  // names, and lets an unconfigured app boot straight to onboarding without a
  // single outbound call.
  const missing = adapter.setupSteps().filter((step) => !getCredential(step.field));
  if (missing.length > 0) {
    return {
      generatedAt,
      network: slug,
      configured: false,
      flags: [
        {
          kind: 'health',
          severity: 'error',
          title: `Connect ${adapter.name}`,
          detail: 'Add your credentials in setup to see your numbers here.',
        },
      ],
    };
  }

  const now = new Date();
  const flags: CockpitFlag[] = [];
  let configured = true;
  let headline: CockpitHeadline | undefined;

  // Run a read, folding a failure into a health flag instead of throwing.
  const guard = async <T>(op: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      const envelope = err instanceof NetworkError ? err.envelope : undefined;
      if (envelope && (envelope.type === 'config_error' || envelope.type === 'auth_error')) {
        configured = false;
        flags.push({
          kind: 'health',
          severity: 'error',
          title:
            envelope.type === 'config_error'
              ? `Connect ${adapter.name}`
              : `${adapter.name} needs reconnecting`,
          detail: envelope.message,
        });
      } else {
        flags.push({
          kind: 'health',
          severity: 'warning',
          title: `${adapter.name}: ${op} unavailable`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    }
  };

  // Headline + unpaid: last 30 days.
  const last30 = await guard('earnings', () =>
    adapter.getEarningsSummary({ from: ymd(daysAgo(30, now)), to: ymd(now) }),
  );
  // A connection failure here makes every other read fail the same way; stop and
  // report once rather than stacking duplicate "connect" flags.
  if (!configured) {
    return { generatedAt, network: slug, configured, flags };
  }
  if (last30) {
    headline = {
      totalEarnings: last30.totalEarnings,
      currency: last30.currency,
      byStatus: last30.byStatus,
      periodFrom: last30.periodFrom,
      periodTo: last30.periodTo,
    };
    if (
      typeof last30.oldestUnpaidAgeDays === 'number' &&
      last30.oldestUnpaidAgeDays > unpaidThresholdDays &&
      last30.byStatus.pending > 0
    ) {
      flags.push({
        kind: 'unpaid_over_threshold',
        severity: 'warning',
        title: `${money(last30.byStatus.pending, last30.byStatus.currency)} unpaid past ${unpaidThresholdDays} days`,
        detail: `Oldest pending commission is ${last30.oldestUnpaidAgeDays} days old.`,
      });
    }
  }

  // Week-over-week swing: this 7 days vs the prior 7 days.
  const thisWeek = await guard('this week', () =>
    adapter.getEarningsSummary({ from: ymd(daysAgo(7, now)), to: ymd(now) }),
  );
  const priorWeek = await guard('prior week', () =>
    adapter.getEarningsSummary({ from: ymd(daysAgo(14, now)), to: ymd(daysAgo(7, now)) }),
  );
  if (thisWeek && priorWeek && priorWeek.totalEarnings > 0) {
    const pct = ((thisWeek.totalEarnings - priorWeek.totalEarnings) / priorWeek.totalEarnings) * 100;
    if (Math.abs(pct) >= wowThresholdPct) {
      const direction = pct < 0 ? 'down' : 'up';
      flags.push({
        kind: 'wow_swing',
        severity: pct < 0 ? 'warning' : 'info',
        title: `Earnings ${direction} ${Math.abs(Math.round(pct))}% week-on-week`,
        detail: `${money(priorWeek.totalEarnings, priorWeek.currency)} to ${money(thisWeek.totalEarnings, thisWeek.currency)}.`,
      });
    }
  }

  // Pending applications.
  const pending = await guard('programmes', () => adapter.listProgrammes({ status: 'pending' }));
  if (pending && pending.length > 0) {
    flags.push({
      kind: 'pending_applications',
      severity: 'info',
      title: `${pending.length} pending application${pending.length === 1 ? '' : 's'}`,
      detail: 'Programmes awaiting a decision.',
    });
  }

  // Health line (only when nothing above already flagged a connection problem).
  if (configured) {
    const auth = await guard('verifyAuth', () => adapter.verifyAuth());
    if (auth && auth.ok) {
      flags.push({
        kind: 'health',
        severity: 'info',
        title: `${adapter.name} connected`,
        detail: auth.identity ? `Signed in as ${auth.identity}.` : undefined,
      });
    } else if (auth && !auth.ok) {
      configured = false;
      flags.push({
        kind: 'health',
        severity: 'error',
        title: `${adapter.name} needs reconnecting`,
        detail: auth.reason,
      });
    }
  }

  return { generatedAt, network: slug, configured, headline, flags };
}
