/**
 * confirmation.ts — single-use confirmation tokens for the doing layer.
 *
 * When the consent gate decides an action needs the user's say-so (decision
 * `prompt`), it issues a token bound to the *exact* action: a fingerprint over
 * the operation, network, subject, and payload. The calling agent shows the
 * user what will happen, and on a yes re-runs the same tool passing the token
 * back. The gate redeems it and lets the action through.
 *
 * This is the plan/apply seam from `docs/product/doing-layer.md`, in its
 * lightweight form: the first call is the plan (no side-effect, returns a
 * token), the second call with the token is the apply.
 *
 * Properties that make this safe:
 *   - **Bound to the action.** A token redeems only against the same
 *     fingerprint. Get a token to "generate a link to X" and you cannot reuse
 *     it to "generate a link to Y" — the request changed, the token is refused.
 *   - **Single use.** Redeeming deletes the token, so a confirmation authorises
 *     exactly one execution.
 *   - **Short lived.** Tokens expire (default 5 minutes); a stale confirmation
 *     cannot be replayed later.
 *   - **In memory, never persisted.** Confirmations are ephemeral by design and
 *     must not survive a server restart. No file, nothing to leak.
 */

import { createHash, randomUUID } from 'node:crypto';

interface TokenEntry {
  fingerprint: string;
  expiresAtMs: number;
}

const store = new Map<string, TokenEntry>();

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function ttlMs(): number {
  const raw = process.env['AFFILIATE_MCP_CONFIRMATION_TTL_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Stable fingerprint of an action. Object keys are sorted recursively so the
 * same logical action always hashes the same regardless of key order.
 */
export function actionFingerprint(input: {
  operation: string;
  network: string;
  subject: string;
  payload: unknown;
}): string {
  const canon = JSON.stringify(
    canonicalise({
      operation: input.operation,
      network: input.network,
      subject: input.subject,
      payload: input.payload ?? null,
    }),
  );
  return createHash('sha256').update(canon).digest('hex');
}

/** Issue a token for `fingerprint`. Returns the token and its ISO expiry. */
export function issueConfirmation(
  fingerprint: string,
  now: Date = new Date(),
): { token: string; expiresAt: string } {
  const token = randomUUID();
  const expiresAtMs = now.getTime() + ttlMs();
  store.set(token, { fingerprint, expiresAtMs });
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Redeem a token against the action being attempted. Succeeds only for a known,
 * unexpired token whose fingerprint matches. Consumes the token on success
 * (single use). Expired tokens are evicted; a fingerprint mismatch leaves the
 * token in place so the originally-confirmed action can still proceed.
 */
export function redeemConfirmation(
  token: string,
  fingerprint: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const entry = store.get(token);
  if (!entry) return { ok: false, reason: 'confirmation token is unknown or already used' };
  if (now.getTime() > entry.expiresAtMs) {
    store.delete(token);
    return { ok: false, reason: 'confirmation token has expired' };
  }
  if (entry.fingerprint !== fingerprint) {
    return { ok: false, reason: 'confirmation token does not match this action — the request changed since it was issued' };
  }
  store.delete(token);
  return { ok: true };
}

/** Test helper: drop all outstanding tokens. */
export function resetConfirmationStore(): void {
  store.clear();
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalise(obj[key]);
    return out;
  }
  return value;
}
