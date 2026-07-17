/**
 * Scheduled digest orchestration (workstream slice H6, redesigned per Rob's
 * 2026-07-14 decision: `hosted/README.md`, "Digest orchestration and token
 * scopes"). The digest loop lives HERE, inside the Worker, as a Cloudflare
 * Cron Trigger (`scheduled` in `src/index.ts`; `[triggers]` in
 * `wrangler.toml`) — not in an externally-authenticated job. Rob rejected
 * the previous design's all-capability service secret; this inversion is
 * the replacement: the Worker already holds `SESSION_SIGNING_KEY`, so it
 * can mint per-user tokens by construction, and the subscriber roster is
 * enumerated in-process from `HOSTED_BILLING` KV, never over HTTP.
 *
 * Per scheduled run, for each active subscriber:
 *   1. Mint a DIGEST-SCOPED session token for exactly that userId, valid
 *      for at most 15 minutes (`DIGEST_TOKEN_TTL_SECONDS`). The scope claim
 *      (`src/token.ts`) confines it to the two vault READ routes
 *      (`requireSession` vs `requireFullSession`, `src/routes/guard.ts`);
 *      the hosted MCP transport also refuses it
 *      (`src/hosted-transport/session-auth.ts`, root workspace).
 *   2. `POST {DIGEST_SERVICE_URL}/compose` with `{ userId, digestType }`
 *      and that token as the bearer. The Node compose service
 *      (`src/hosted-digest/`, root workspace — it needs the 86-adapter
 *      registry this Worker cannot carry) uses the token against the vault
 *      list/reveal routes exactly as the MCP transport does, reads each
 *      network's earnings through the H1 seam, and returns the rendered
 *      `{ subject, body }` text. It never receives, resolves, or returns an
 *      email address.
 *   3. Re-check tier entitlement against the freshly-read record
 *      (`tierEntitledToDigest`) and send the rendered text via Resend, to
 *      the billing email held in `HOSTED_BILLING` — the email never leaves
 *      this Worker.
 *
 * Logging discipline: one audit line per send attempt (userId, digestType,
 * timestamp, outcome) via `console.error` (Workers' stderr-equivalent
 * stream, matching every other handler in this Worker). NEVER the email
 * address, NEVER the digest subject or body.
 *
 * If `DIGEST_SERVICE_URL` is unset the run no-ops with a single log line —
 * a deploy of this Worker before the compose service exists must not
 * error-spam or half-run.
 */

import type { Env } from './env.js';
import {
  getSubscriptionRecord,
  isActiveStatus,
  listActiveSubscribers,
  tierEntitledToDigest,
  type DigestType,
  type SubscriberSummary,
} from './billing.js';
import { buildSessionPayload, signSession } from './token.js';

const RESEND_API_BASE = 'https://api.resend.com';
const DIGEST_FROM_ADDRESS = 'affiliate-mcp <digest@agenticaffiliate.ai>';

/** Hard ceiling on the digest token's life: long enough for one compose call
 * (a handful of vault reads plus network API reads), nowhere near a session.
 * Rob's redesign directive set 15 minutes as the maximum. */
export const DIGEST_TOKEN_TTL_SECONDS = 15 * 60;

export type DigestSendOutcome = 'sent' | 'denied' | 'no_email' | 'compose_failed' | 'send_failed';

export interface DigestRunRecord {
  userId: string;
  digestType: DigestType;
  outcome: DigestSendOutcome;
}

export interface DigestRunSummary {
  subscriberCount: number;
  records: DigestRunRecord[];
  skippedReason?: 'digest_service_not_configured';
}

/** One append-only audit line per send attempt. NEVER the email address, NEVER the digest
 * subject or body — mirrors `src/hosted-transport/audit.ts`'s "never payloads" contract on the
 * root-workspace side of this slice. */
function recordDigestAudit(userId: string, digestType: DigestType, outcome: DigestSendOutcome): void {
  console.error(
    JSON.stringify({
      event: 'hosted_digest_send',
      userId,
      digestType,
      timestamp: new Date().toISOString(),
      outcome,
    }),
  );
}

/** Mint the short-lived, digest-scoped token for one userId. Exported for tests, which assert
 * the scope claim and the TTL ceiling on the exact token the run would use. */
export async function mintDigestToken(env: Env, userId: string, nowSeconds: number): Promise<string> {
  return signSession(
    buildSessionPayload({
      sub: userId,
      iss: nowSeconds,
      exp: nowSeconds + DIGEST_TOKEN_TTL_SECONDS,
      scope: 'digest',
    }),
    env.SESSION_SIGNING_KEY,
  );
}

interface ComposedDigest {
  subject: string;
  body: string;
}

/** Call the Node compose service for one user and digest type. Returns `null` on any failure —
 * the caller records `compose_failed` and moves on; one user's compose failure never aborts the
 * run. */
async function composeDigest(
  env: Env,
  serviceUrl: string,
  userId: string,
  digestType: DigestType,
  bearerToken: string,
): Promise<ComposedDigest | null> {
  let res: Response;
  try {
    res = await fetch(`${serviceUrl}/compose`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
        // The optional doorbell (see hosted/README.md, "Digest orchestration
        // and token scopes"): stops strangers from invoking the compose
        // service. Leaking it grants nothing on its own — data access needs
        // the per-user digest token above.
        ...(env.DIGEST_COMPOSE_SECRET ? { 'x-compose-auth': env.DIGEST_COMPOSE_SECRET } : {}),
      },
      body: JSON.stringify({ userId, digestType }),
    });
  } catch (err) {
    console.error(`[digest] compose unreachable userId=${userId} message=${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[digest] compose failed userId=${userId} digestType=${digestType} status=${res.status}`);
    return null;
  }
  const body = (await res.json()) as { subject?: unknown; body?: unknown };
  if (typeof body.subject !== 'string' || body.subject.length === 0 || typeof body.body !== 'string' || body.body.length === 0) {
    console.error(`[digest] compose returned a malformed body userId=${userId} digestType=${digestType}`);
    return null;
  }
  return { subject: body.subject, body: body.body };
}

async function sendViaResend(env: Env, email: string, digest: ComposedDigest): Promise<boolean> {
  try {
    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: DIGEST_FROM_ADDRESS,
        to: email,
        subject: digest.subject,
        text: digest.body,
      }),
    });
    if (!res.ok) {
      // Status only — never the address, never the Resend body (which could
      // echo the address back).
      console.error(`[digest] resend send failed status=${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[digest] resend send error: ${(err as Error).message}`);
    return false;
  }
}

function digestTypesForTier(tier: SubscriberSummary['tier']): DigestType[] {
  return tier === 'pro' ? ['earnings', 'unpaid-commissions'] : ['earnings'];
}

/** Run one digest cycle for one subscriber. A failure at any step records its outcome and
 * continues to the subscriber's next digest type; nothing throws out of here. */
async function runForSubscriber(
  env: Env,
  serviceUrl: string,
  subscriber: SubscriberSummary,
): Promise<DigestRunRecord[]> {
  const records: DigestRunRecord[] = [];
  const token = await mintDigestToken(env, subscriber.userId, Math.floor(Date.now() / 1000));

  for (const digestType of digestTypesForTier(subscriber.tier)) {
    // Re-read the record at send time: the roster was a snapshot, and a
    // subscription cancelled (or an account deleted) mid-run must not be
    // emailed. The Solo/Pro digest split is re-derived from the fresh
    // record's tier rather than trusting the snapshot's.
    const record = await getSubscriptionRecord(env.HOSTED_BILLING, subscriber.userId);
    if (!record || !isActiveStatus(record.status) || !tierEntitledToDigest(record.tier, digestType)) {
      recordDigestAudit(subscriber.userId, digestType, 'denied');
      records.push({ userId: subscriber.userId, digestType, outcome: 'denied' });
      continue;
    }
    if (!record.email) {
      // No billing email on file (e.g. a manually-granted tier with no
      // Stripe Checkout behind it — see hosted/README.md, "Manual tier
      // administration"). An honest, specific outcome, distinct from a
      // transient send failure.
      recordDigestAudit(subscriber.userId, digestType, 'no_email');
      records.push({ userId: subscriber.userId, digestType, outcome: 'no_email' });
      continue;
    }

    const composed = await composeDigest(env, serviceUrl, subscriber.userId, digestType, token);
    if (!composed) {
      recordDigestAudit(subscriber.userId, digestType, 'compose_failed');
      records.push({ userId: subscriber.userId, digestType, outcome: 'compose_failed' });
      continue;
    }

    const sent = await sendViaResend(env, record.email, composed);
    const outcome: DigestSendOutcome = sent ? 'sent' : 'send_failed';
    recordDigestAudit(subscriber.userId, digestType, outcome);
    records.push({ userId: subscriber.userId, digestType, outcome });
  }

  return records;
}

/**
 * One full scheduled digest run: enumerate the roster from KV, run each
 * subscriber, return a summary (counts and outcomes only — nothing
 * PII-bearing, so the summary itself is safe to log verbatim).
 */
export async function runScheduledDigest(env: Env): Promise<DigestRunSummary> {
  const serviceUrl = env.DIGEST_SERVICE_URL?.replace(/\/+$/, '');
  if (!serviceUrl) {
    console.error('[digest] DIGEST_SERVICE_URL is not configured; scheduled digest run skipped');
    return { subscriberCount: 0, records: [], skippedReason: 'digest_service_not_configured' };
  }

  const subscribers = await listActiveSubscribers(env.HOSTED_BILLING);
  const records: DigestRunRecord[] = [];
  for (const subscriber of subscribers) {
    records.push(...(await runForSubscriber(env, serviceUrl, subscriber)));
  }

  console.error(
    `[digest] scheduled run complete subscribers=${subscribers.length} sent=${records.filter((r) => r.outcome === 'sent').length} failed=${records.filter((r) => r.outcome !== 'sent').length}`,
  );
  return { subscriberCount: subscribers.length, records };
}
