/**
 * consent.ts — the authorisation layer for the doing layer.
 *
 * Design: `docs/product/doing-layer.md` → "Graduated trust". The doing layer
 * never executes a surprising change. Confirmation is the default; a standing
 * grant recorded here is what lets a trusted agent proceed without a prompt,
 * always within bounds, always auditable.
 *
 * This module is the single place that decides, for one `(brand, network,
 * actionClass)`, whether to prompt the human, proceed silently, or refuse:
 *
 *   - no matching grant            → `prompt` (the safe default; ask the human)
 *   - matching standing grant,
 *     within bounds                → `proceed` (skip the prompt)
 *   - matching standing grant,
 *     expired / out of bounds      → `prompt` (fall back to asking)
 *   - matching `deny` grant        → `deny` (explicit client prohibition; wins
 *                                     over any standing grant)
 *
 * Lives at `$AFFILIATE_MCP_CONFIG_DIR/consent.json` (default
 * `~/.affiliate-mcp/consent.json`), owned by the setup wizard, read by the MCP
 * server before dispatching an action. Local-first, exactly like `brands.json`
 * — see `src/shared/brands.ts`, whose load/save/register shape this mirrors.
 *
 * The consent *types* live here rather than in `src/shared/types.ts`: that file
 * is the stable cross-adapter contract and AGENTS.md gates changes to it behind
 * an issue. Nothing in the read path imports these, so co-locating them keeps
 * the contract untouched while the doing layer is still a proposal.
 *
 * NOTE: this module decides; it does not act. `usedToday` (for per-day caps) is
 * supplied by the caller from the audit log — consent.ts has no dependency on
 * the audit module and stays a pure decision function over its inputs.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { NetworkSlug } from './types.js';
import { isValidBrandSlug } from './brands.js';

// ---------------------------------------------------------------------------
// Types (co-located — see file header)
// ---------------------------------------------------------------------------

/**
 * A coarse class of action a client reasons about, `domain.verb`, e.g.
 * `publisher.approve`, `commission.adjust`, `transaction.validate`,
 * `link.generate`. The map from class to concrete adapter operation lives in
 * the adapter / tool layer, not here. Kept a string (not a closed union) so a
 * new network can introduce a class without a contract change.
 */
export type ActionClass = string;

/**
 * `standing` — within bounds, lets the action proceed without a prompt.
 * `deny`     — an explicit prohibition that wins over any standing grant.
 */
export type ConsentMode = 'standing' | 'deny';

export interface ConsentBounds {
  /** Maximum applied actions of this class per calendar day (caller supplies the running count). */
  maxPerDay?: number;
  /** ISO timestamp after which the grant is inactive. */
  expiresAt?: string;
  /**
   * Maximum permitted magnitude of a single action, in the unit the action
   * class defines (percentage points for `commission.adjust`, a count for bulk
   * approvals, etc.). Checked against the `magnitude` passed to the evaluator.
   */
  maxMagnitude?: number;
}

export interface ConsentGrant {
  /** Logical brand slug from brands.json. */
  brand: string;
  /** A network slug, or `*` for every network bound to the brand. */
  network: NetworkSlug | '*';
  actionClass: ActionClass;
  mode: ConsentMode;
  bounds?: ConsentBounds;
  /** Who authorised this (informational; e.g. a client email). */
  grantedBy?: string;
  /** ISO timestamp the grant was recorded. */
  grantedAt?: string;
  note?: string;
}

/** The shape of `~/.affiliate-mcp/consent.json`. */
export interface ConsentFile {
  version: 1;
  grants: ConsentGrant[];
}

export type ConsentDecision = 'prompt' | 'proceed' | 'deny';

export interface ConsentEvaluation {
  decision: ConsentDecision;
  /** Human-readable why, suitable for surfacing to the operator. */
  reason: string;
  /** The grant that drove a `proceed` or `deny`, when one did. */
  grant?: ConsentGrant;
}

export interface ConsentRequest {
  brand: string;
  network: NetworkSlug;
  actionClass: ActionClass;
  /** Magnitude of this specific action, checked against `bounds.maxMagnitude`. */
  magnitude?: number;
  /** Count of this class already applied today, from the audit log, for `bounds.maxPerDay`. */
  usedToday?: number;
  /** Injectable clock for tests. Defaults to now. */
  now?: Date;
}

const ACTION_CLASS_RE = /^[a-z0-9]+\.[a-z0-9]+$/;

// ---------------------------------------------------------------------------
// Path + load + save (mirrors brands.ts)
// ---------------------------------------------------------------------------

/** Resolve the active consent.json path. Honours `AFFILIATE_MCP_CONFIG_DIR`. */
export function resolveConsentFile(): string {
  const override = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  const dir = override && override.trim() !== '' ? override : path.join(homedir(), '.affiliate-mcp');
  return path.join(dir, 'consent.json');
}

/**
 * Load consent.json. Returns the empty default when the file is missing.
 * Throws if the file exists but cannot be read or parsed — a silent fallback
 * would hide a misconfiguration. Callers on the dispatch hot path should use
 * {@link assertAuthorised}, which degrades a broken file to `prompt` rather
 * than throwing.
 */
export function loadConsent(): ConsentFile {
  const file = resolveConsentFile();
  if (!existsSync(file)) return { version: 1, grants: [] };
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`consent.json at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isConsentFile(parsed)) {
    throw new Error(`consent.json at ${file} has an unrecognised shape (expected version 1).`);
  }
  return parsed;
}

/** Write consent.json atomically (temp + rename) at mode 0600. */
export function saveConsent(consent: ConsentFile): void {
  const file = resolveConsentFile();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(consent, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort; some filesystems do not support modes.
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide whether an action may proceed without a prompt. Never throws: a
 * missing file yields `prompt`, and an unreadable file degrades to `prompt`
 * (with the parse error surfaced in `reason`) rather than blocking dispatch on
 * an opaque error. It refuses to *skip* a prompt it cannot justify; it does not
 * silently swallow the misconfiguration.
 *
 * `deny` grants are evaluated first and win: an explicit client prohibition is
 * never overridden by a standing grant.
 */
export function assertAuthorised(req: ConsentRequest): ConsentEvaluation {
  let file: ConsentFile;
  try {
    file = loadConsent();
  } catch (err) {
    return {
      decision: 'prompt',
      reason: `Consent store unreadable, defaulting to prompt: ${(err as Error).message}`,
    };
  }

  const now = req.now ?? new Date();
  const matches = file.grants.filter((g) => grantMatches(g, req));

  const denial = matches.find((g) => g.mode === 'deny');
  if (denial) {
    return {
      decision: 'deny',
      reason: `Client has explicitly denied ${req.actionClass} on ${req.brand} (${describeNetwork(denial.network)}).`,
      grant: denial,
    };
  }

  for (const grant of matches.filter((g) => g.mode === 'standing')) {
    const verdict = withinBounds(grant, req, now);
    if (verdict.ok) {
      return {
        decision: 'proceed',
        reason: `Standing grant covers ${req.actionClass} on ${req.brand}${grant.note ? ` (${grant.note})` : ''}.`,
        grant,
      };
    }
    // A standing grant that exists but does not cover this action falls back to
    // prompt with the specific reason — it never escalates to deny.
    return {
      decision: 'prompt',
      reason: `Standing grant for ${req.actionClass} on ${req.brand} does not cover this action: ${verdict.reason}.`,
      grant,
    };
  }

  return {
    decision: 'prompt',
    reason: `No standing grant for ${req.actionClass} on ${req.brand}; confirm with the user.`,
  };
}

// ---------------------------------------------------------------------------
// Register / revoke / list (mirrors brands.ts register semantics)
// ---------------------------------------------------------------------------

/**
 * Record a grant. Additive and idempotent on `(brand, network, actionClass)`:
 * a second call with the same triple replaces the grant in place rather than
 * stacking a duplicate. `grantedAt` is stamped when absent.
 */
export function grantConsent(grant: ConsentGrant): void {
  validateGrant(grant);
  const file = loadConsent();
  const next: ConsentGrant = { ...grant, grantedAt: grant.grantedAt ?? new Date().toISOString() };
  const idx = file.grants.findIndex(
    (g) => g.brand === grant.brand && g.network === grant.network && g.actionClass === grant.actionClass,
  );
  if (idx >= 0) file.grants[idx] = next;
  else file.grants.push(next);
  saveConsent(file);
}

/**
 * Remove grants matching `(brand, network, actionClass)`. Returns the number
 * removed. Revoking a standing grant returns the action to prompt-always
 * immediately, by design.
 */
export function revokeConsent(
  brand: string,
  network: NetworkSlug | '*',
  actionClass: ActionClass,
): number {
  const file = loadConsent();
  const before = file.grants.length;
  file.grants = file.grants.filter(
    (g) => !(g.brand === brand && g.network === network && g.actionClass === actionClass),
  );
  const removed = before - file.grants.length;
  if (removed > 0) saveConsent(file);
  return removed;
}

/** List recorded grants, optionally filtered by brand. For the doctor surface. */
export function listGrants(filter?: { brand?: string }): ConsentGrant[] {
  const file = loadConsent();
  if (!filter?.brand) return file.grants.slice();
  return file.grants.filter((g) => g.brand === filter.brand);
}

/** Validate a `domain.verb` action-class string. */
export function isValidActionClass(value: string): boolean {
  return ACTION_CLASS_RE.test(value);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function grantMatches(grant: ConsentGrant, req: ConsentRequest): boolean {
  if (grant.brand !== req.brand) return false;
  if (grant.actionClass !== req.actionClass) return false;
  return grant.network === '*' || grant.network === req.network;
}

function withinBounds(
  grant: ConsentGrant,
  req: ConsentRequest,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  const b = grant.bounds;
  if (!b) return { ok: true };

  if (b.expiresAt !== undefined) {
    const expiry = Date.parse(b.expiresAt);
    if (Number.isNaN(expiry)) return { ok: false, reason: `bounds.expiresAt "${b.expiresAt}" is not a valid date` };
    if (now.getTime() > expiry) return { ok: false, reason: `grant expired at ${b.expiresAt}` };
  }

  if (b.maxMagnitude !== undefined && req.magnitude !== undefined && req.magnitude > b.maxMagnitude) {
    return { ok: false, reason: `magnitude ${req.magnitude} exceeds the permitted ${b.maxMagnitude}` };
  }

  if (b.maxPerDay !== undefined && req.usedToday !== undefined && req.usedToday >= b.maxPerDay) {
    return { ok: false, reason: `daily cap of ${b.maxPerDay} already reached (${req.usedToday} used today)` };
  }

  return { ok: true };
}

function describeNetwork(network: NetworkSlug | '*'): string {
  return network === '*' ? 'all networks' : network;
}

function validateGrant(grant: ConsentGrant): void {
  if (!isValidBrandSlug(grant.brand)) {
    throw new Error(
      `Consent grant brand "${grant.brand}" is invalid. Use lowercase letters, digits, and hyphens only.`,
    );
  }
  if (grant.network !== '*' && (typeof grant.network !== 'string' || grant.network.trim() === '')) {
    throw new Error('Consent grant network must be a network slug or "*".');
  }
  if (!isValidActionClass(grant.actionClass)) {
    throw new Error(
      `Consent grant actionClass "${grant.actionClass}" is invalid. Expected "domain.verb" (e.g. "publisher.approve").`,
    );
  }
  if (grant.mode !== 'standing' && grant.mode !== 'deny') {
    throw new Error(`Consent grant mode "${String(grant.mode)}" is invalid. Expected "standing" or "deny".`);
  }
  if (grant.bounds) validateBounds(grant.bounds);
}

function validateBounds(b: ConsentBounds): void {
  if (b.maxPerDay !== undefined && (!Number.isInteger(b.maxPerDay) || b.maxPerDay < 0)) {
    throw new Error('bounds.maxPerDay must be a non-negative integer.');
  }
  if (b.maxMagnitude !== undefined && (typeof b.maxMagnitude !== 'number' || b.maxMagnitude < 0)) {
    throw new Error('bounds.maxMagnitude must be a non-negative number.');
  }
  if (b.expiresAt !== undefined && Number.isNaN(Date.parse(b.expiresAt))) {
    throw new Error(`bounds.expiresAt "${b.expiresAt}" is not a valid ISO date.`);
  }
}

function isConsentFile(value: unknown): value is ConsentFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) return false;
  if (!Array.isArray(v['grants'])) return false;
  for (const g of v['grants']) {
    if (!g || typeof g !== 'object') return false;
    const gg = g as Record<string, unknown>;
    if (typeof gg['brand'] !== 'string') return false;
    if (typeof gg['network'] !== 'string') return false;
    if (typeof gg['actionClass'] !== 'string') return false;
    if (gg['mode'] !== 'standing' && gg['mode'] !== 'deny') return false;
  }
  return true;
}
