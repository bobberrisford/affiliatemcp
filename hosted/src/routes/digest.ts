/**
 * `POST /digest/send` (H6): the one route that turns a composed digest into
 * an actual email. Service-secret gated (`requireServiceSecret`, shared with
 * `routes/admin.ts`) — the hosted-digest job (root workspace,
 * `src/hosted-digest/`) calls this with `{ userId, digestType, subject,
 * body }`; it never holds, sees, or is passed the user's email address. This
 * Worker resolves the email itself, from `HOSTED_BILLING` (populated at
 * Stripe Checkout — see `src/billing.ts`'s file-header comment for why that
 * is the one place in this Worker that holds a plaintext address), and sends
 * via Resend, reusing the exact `fetch`-to-Resend pattern `src/index.ts`
 * already uses for the magic-link email.
 *
 * Entitlement is re-checked HERE, not trusted from the caller: even though
 * the digest job is expected to only ask for digests a user's tier already
 * allows (it reads the same roster this Worker's `/admin/subscribers` route
 * produced), a stale roster snapshot or a job-side bug must not be able to
 * over-send a Pro-only unpaid-commissions digest to a Solo subscriber. This
 * route is the actual enforcement point.
 *
 * Never logs the email address or the digest body. The one audit line per
 * send carries exactly `userId`, `digestType`, `timestamp`, and `outcome` —
 * mirroring `src/hosted-transport/audit.ts`'s "never payloads" contract on
 * the root-workspace side of this same slice.
 */

import type { Env } from '../env.js';
import { json } from '../http.js';
import { getSubscriptionRecord, resolveEntitlement, tierEntitledToDigest, type DigestType } from '../billing.js';
import { requireServiceSecret } from './admin.js';

const RESEND_API_BASE = 'https://api.resend.com';
const DIGEST_FROM_ADDRESS = 'affiliate-mcp <digest@agenticaffiliate.ai>';

interface DigestSendBody {
  userId?: unknown;
  digestType?: unknown;
  subject?: unknown;
  body?: unknown;
}

function isDigestType(value: unknown): value is DigestType {
  return value === 'earnings' || value === 'unpaid-commissions';
}

export type DigestSendOutcome = 'sent' | 'denied' | 'no_email' | 'send_failed';

/** One append-only stderr line per send attempt. NEVER the email address, NEVER the digest
 * subject or body — only what the audit contract needs. */
function recordDigestAudit(userId: string, digestType: string, outcome: DigestSendOutcome): void {
  console.log(
    JSON.stringify({
      event: 'hosted_digest_send',
      userId,
      digestType,
      timestamp: new Date().toISOString(),
      outcome,
    }),
  );
}

export async function handleDigestSend(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const denied = await requireServiceSecret(request, env, cors);
  if (denied) return denied;

  let body: DigestSendBody;
  try {
    body = (await request.json()) as DigestSendBody;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }
  const { userId, subject, digestType } = body;
  const content = body.body;
  if (typeof userId !== 'string' || userId.length === 0) {
    return json({ error: 'invalid_user_id' }, { status: 400 }, cors);
  }
  if (!isDigestType(digestType)) {
    return json({ error: 'invalid_digest_type' }, { status: 400 }, cors);
  }
  if (typeof subject !== 'string' || subject.length === 0 || typeof content !== 'string' || content.length === 0) {
    return json({ error: 'invalid_content' }, { status: 400 }, cors);
  }

  const entitlement = await resolveEntitlement(env.HOSTED_BILLING, userId);
  if (!tierEntitledToDigest(entitlement.tier, digestType)) {
    recordDigestAudit(userId, digestType, 'denied');
    return json({ error: 'entitlement_denied', tier: entitlement.tier }, { status: 403 }, cors);
  }

  const record = await getSubscriptionRecord(env.HOSTED_BILLING, userId);
  if (!record?.email) {
    // No billing email on file (e.g. a manually-set admin entitlement with no
    // Stripe Checkout behind it yet). Not the digest job's fault and not a
    // 5xx — an honest, specific refusal so the caller can tell this apart
    // from a transient Resend failure.
    recordDigestAudit(userId, digestType, 'no_email');
    return json({ error: 'no_billing_email_on_file' }, { status: 422 }, cors);
  }

  try {
    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: DIGEST_FROM_ADDRESS,
        to: record.email,
        subject,
        text: content,
      }),
    });
    if (!res.ok) {
      // Status only, never the address or body.
      console.error(`[digest] resend send failed userId=${userId} status=${res.status}`);
      recordDigestAudit(userId, digestType, 'send_failed');
      return json({ error: 'send_failed' }, { status: 502 }, cors);
    }
  } catch (err) {
    console.error(`[digest] resend send error userId=${userId} message=${(err as Error).message}`);
    recordDigestAudit(userId, digestType, 'send_failed');
    return json({ error: 'send_failed' }, { status: 502 }, cors);
  }

  recordDigestAudit(userId, digestType, 'sent');
  return json({ ok: true }, { status: 200 }, cors);
}
