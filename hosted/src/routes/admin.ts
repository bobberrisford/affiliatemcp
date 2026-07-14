/**
 * Service-authenticated admin routes (H6): the digest job's (and, for the
 * manual-set path, Rob's) entry points into the hosted Worker. Every route
 * here is gated by `requireServiceSecret`, never by a user's own session
 * token — this is the one place in the hosted Worker that accepts a
 * different kind of credential than "this user's own session".
 *
 * ── Why a service secret exists at all, and what it can do ──────────────
 *
 * H4's vault-reveal route (`routes/vault.ts`) was built so that "there is no
 * service-level credential or elevated scope that could read a different
 * user's vault" — every read is scoped to the caller's own session. The
 * scheduled digest job breaks that assumption's premise: it runs unattended,
 * on a cron schedule, with no user present to hold a session token, for
 * potentially many subscribed users in one run. Something has to authorise
 * it, and that something is, unavoidably, a credential broader than any one
 * user's session.
 *
 * This route set narrows that as much as the job's actual job allows:
 *   - `GET /admin/subscribers` returns ids and tiers only. No emails, no
 *     credentials, nothing account-identifying beyond the opaque userId the
 *     digest job already needs to operate on.
 *   - `POST /admin/session` mints a session token SCOPED to one named userId,
 *     short-lived (`SERVICE_SESSION_TTL_SECONDS`, default 10 minutes — see
 *     `env.ts`), using the exact same `signSession` primitive H2's real
 *     sign-in flow uses. It is not a master key or a bypass: once minted, it
 *     is verified by the SAME `resolveValidSession` every other route uses,
 *     and every downstream call (vault reveal, network list) still enforces
 *     "serves only that token's own userId" exactly as before. What changes
 *     is WHO can mint a valid token for a given user without that user's own
 *     sign-in flow — and the answer, with this route, is "anyone holding
 *     `HOSTED_SERVICE_SECRET`".
 *   - `POST /admin/entitlement` is the MVP manual-tier-set path the workstream
 *     brief asked for, ahead of a live Stripe integration.
 *
 * This is a genuine widening of the custody record's threat model, not a
 * detail — the same category of decision H3 left explicit for Rob (see
 * `hosted/README.md`, "Vault threat model": "Decision: Rob accepted the
 * Worker-secret design for the MVP on 2026-07-14"). It is flagged the same
 * way here rather than silently assumed: see `hosted/README.md`, "H6: digest
 * and billing", for the full threat-model write-up and the explicit
 * acceptance this PR asks Rob for before merge.
 *
 * Compensating controls in place today: `HOSTED_SERVICE_SECRET` is a single
 * purpose-built secret distinct from `SESSION_SIGNING_KEY` and
 * `VAULT_MASTER_KEY` (compromising one does not compromise the others); the
 * minted session is short-lived and carries no elevated scope beyond a
 * normal session; and every admin route only ever accepts this one secret,
 * never a user session, so a leaked user session token can never reach these
 * routes. What this does NOT yet have: per-call audit of admin-route use
 * beyond the existing `console.error` failure logging, and no automatic
 * secret rotation procedure (a manual `wrangler secret put` is the rotation
 * path today, same as every other Worker secret in this repo).
 */

import type { Env } from '../env.js';
import { json } from '../http.js';
import { listActiveSubscribers, setEntitlementManual, type PaidHostedTier } from '../billing.js';
import { buildSessionPayload, signSession } from '../token.js';

const DEFAULT_SERVICE_SESSION_TTL_SECONDS = 600; // 10 minutes

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies the `Authorization: Bearer <HOSTED_SERVICE_SECRET>` header with a
 * constant-time comparison (timing-safe: this is a bearer-secret check, not a
 * public-key signature, so an early-exit `===` would leak how many leading
 * characters matched to a network-timing attacker). Returns `undefined` when
 * valid, or a ready-to-return `401`/`503` `Response` otherwise.
 */
async function requireServiceSecret(request: Request, env: Env, cors: Record<string, string>): Promise<Response | undefined> {
  if (!env.HOSTED_SERVICE_SECRET) {
    return json({ error: 'admin_not_configured' }, { status: 503 }, cors);
  }
  const header = request.headers.get('authorization');
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (!presented || !(await timingSafeEqual(presented, env.HOSTED_SERVICE_SECRET))) {
    return json({ error: 'invalid_service_secret' }, { status: 401 }, cors);
  }
  return undefined;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  return diff === 0;
}

// ── GET /admin/subscribers ────────────────────────────────────────────────
// Returns { subscribers: [{ userId, tier }] } — ids and tiers only, never
// emails. The digest job's roster.
export async function handleAdminListSubscribers(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const denied = await requireServiceSecret(request, env, cors);
  if (denied) return denied;

  const subscribers = await listActiveSubscribers(env.HOSTED_BILLING);
  return json({ subscribers }, { status: 200 }, cors);
}

interface ServiceSessionBody {
  userId?: unknown;
}

// ── POST /admin/session ───────────────────────────────────────────────────
// Mints a short-lived session token for one named userId, for the digest
// job to reuse every existing session-gated route (vault list, vault
// reveal) unmodified, under the target user's own identity. See the
// file-header comment for the threat-model trade-off this represents.
export async function handleAdminIssueSession(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const denied = await requireServiceSecret(request, env, cors);
  if (denied) return denied;

  let body: ServiceSessionBody;
  try {
    body = (await request.json()) as ServiceSessionBody;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (typeof body.userId !== 'string' || body.userId.length === 0) {
    return json({ error: 'invalid_user_id' }, { status: 400 }, cors);
  }

  const ttl = env.SERVICE_SESSION_TTL_SECONDS ? Number(env.SERVICE_SESSION_TTL_SECONDS) : DEFAULT_SERVICE_SESSION_TTL_SECONDS;
  const iss = nowSeconds();
  const exp = iss + ttl;
  const token = await signSession(buildSessionPayload({ sub: body.userId, iss, exp }), env.SESSION_SIGNING_KEY);
  return json({ token, exp }, { status: 200 }, cors);
}

interface AdminEntitlementBody {
  userId?: unknown;
  tier?: unknown;
}

function isPaidTierInput(value: unknown): value is PaidHostedTier {
  return value === 'solo' || value === 'pro';
}

// ── POST /admin/entitlement ────────────────────────────────────────────────
// The MVP manual-set path: grants or changes a user's tier directly, with no
// live Stripe subscription behind it. Documented in hosted/README.md as a
// pre-Stripe-integration and support/testing tool, not the steady-state path.
export async function handleAdminSetEntitlement(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const denied = await requireServiceSecret(request, env, cors);
  if (denied) return denied;

  let body: AdminEntitlementBody;
  try {
    body = (await request.json()) as AdminEntitlementBody;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (typeof body.userId !== 'string' || body.userId.length === 0) {
    return json({ error: 'invalid_user_id' }, { status: 400 }, cors);
  }
  if (!isPaidTierInput(body.tier)) {
    return json({ error: 'invalid_tier' }, { status: 400 }, cors);
  }

  const record = await setEntitlementManual(env.HOSTED_BILLING, body.userId, body.tier);
  return json({ ok: true, userId: body.userId, tier: record.tier }, { status: 200 }, cors);
}

export { requireServiceSecret };
