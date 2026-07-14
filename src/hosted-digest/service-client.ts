/**
 * Service-authenticated client for the hosted-digest job's three calls into
 * the hosted Worker (workstream slice H6). Every call here carries
 * `Authorization: Bearer <HOSTED_SERVICE_SECRET>` — never a user's own
 * session token — matching `hosted/src/routes/admin.ts` and
 * `hosted/src/routes/digest.ts`'s `requireServiceSecret` guard.
 *
 * This is the ONLY module in the digest job that holds the service secret.
 * `run.ts` calls through here for the roster, the per-user session, and the
 * final send; it never sees the secret itself.
 */

import type { DigestType } from './compose.js';

export interface Subscriber {
  userId: string;
  tier: 'solo' | 'pro';
}

export class HostedDigestServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HostedDigestServiceError';
  }
}

async function serviceFetch(url: string, serviceSecret: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${serviceSecret}` },
    });
  } catch (err) {
    throw new HostedDigestServiceError(`could not reach the hosted Worker at ${url}: ${(err as Error).message}`);
  }
  return res;
}

/** `GET /admin/subscribers` — the digest job's roster: ids and tiers only, never emails. */
export async function listSubscribers(authUrl: string, serviceSecret: string): Promise<Subscriber[]> {
  const res = await serviceFetch(`${authUrl}/admin/subscribers`, serviceSecret);
  if (!res.ok) {
    throw new HostedDigestServiceError(`GET /admin/subscribers returned HTTP ${res.status}`, res.status);
  }
  const body = (await res.json()) as { subscribers?: unknown };
  if (!Array.isArray(body.subscribers)) {
    throw new HostedDigestServiceError('GET /admin/subscribers returned a malformed body');
  }
  return body.subscribers as Subscriber[];
}

/**
 * `POST /admin/session` — mints a short-lived session token scoped to one
 * named userId, so the rest of the job can reuse the hosted MCP transport's
 * own `resolveCredentialOverlay`/`listConnectedNetworks` (both expect "the
 * caller's own session token") completely unmodified, under that user's
 * identity.
 */
export async function issueServiceSession(authUrl: string, serviceSecret: string, userId: string): Promise<string> {
  const res = await serviceFetch(`${authUrl}/admin/session`, serviceSecret, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new HostedDigestServiceError(`POST /admin/session returned HTTP ${res.status} for userId=${userId}`, res.status);
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new HostedDigestServiceError('POST /admin/session returned a malformed body');
  }
  return body.token;
}

export type DigestSendOutcome = 'sent' | 'denied' | 'no_email' | 'failed';

/**
 * `POST /digest/send` — hands the Worker exactly `{ userId, digestType,
 * subject, body }`. The job never receives, holds, or logs the recipient's
 * email address; the Worker resolves it internally (`hosted/src/routes/digest.ts`).
 */
export async function sendDigest(
  authUrl: string,
  serviceSecret: string,
  args: { userId: string; digestType: DigestType; subject: string; body: string },
): Promise<DigestSendOutcome> {
  const res = await serviceFetch(`${authUrl}/digest/send`, serviceSecret, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (res.status === 200) return 'sent';
  if (res.status === 403) return 'denied';
  if (res.status === 422) return 'no_email';
  return 'failed';
}
