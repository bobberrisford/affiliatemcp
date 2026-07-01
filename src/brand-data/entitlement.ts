/**
 * Brand Data Layer — the entitlement gate (stub).
 *
 * One local check governs the paid brand-data tools. Per
 * `docs/decisions/2026-06-30-paid-tier-entitlement-gate.md` this is a STUB: it
 * reads an environment flag and performs no network call, reads no licence file,
 * and verifies no signature. It is the single seam a future payment PR replaces.
 *
 * The gate ships DORMANT in v1 (maintainer decision): `isEntitled` defaults to
 * `true`, so every tool is available and the product is effectively free. Only
 * an explicit off value (`AFFILIATE_MCP_ENTITLED=0|false|off|no`) withholds the
 * paid tier — useful for exercising the visible-but-locked path. When real
 * payments land behind their own decision, they replace this function.
 */

export type EntitlementTier = 'free' | 'paid';

export interface EntitlementState {
  entitled: boolean;
  tier: EntitlementTier;
  reason: string;
}

/** Whether the caller may use the paid brand-data tools. Defaults to `true`. */
export function isEntitled(_userId?: string): boolean {
  const flag = process.env['AFFILIATE_MCP_ENTITLED'];
  if (flag === undefined || flag.trim() === '') return true; // dormant: default access
  const v = flag.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Structured entitlement state for surfacing in tool responses. */
export function entitlementState(userId?: string): EntitlementState {
  return isEntitled(userId)
    ? { entitled: true, tier: 'paid', reason: 'entitled (gate dormant: default access in v1)' }
    : { entitled: false, tier: 'free', reason: 'no active entitlement' };
}

/**
 * The paid brand-data tools gated by the single entitlement check. Kept as one
 * set so a tool author cannot forget to apply the gate and the decision is
 * auditable in one place. `affiliate_build_brand_snapshot` is deliberately NOT
 * here — snapshot viewing is free. The AI-action bundle joins this set when it
 * ships (PR-5).
 */
export const GATED_TOOLS: ReadonlySet<string> = new Set<string>(['affiliate_get_brand_rows']);

/** The structured result returned when a gated tool is called without entitlement. */
export interface EntitlementRequired {
  error: 'entitlement_required';
  entitled: false;
  tier: 'paid';
  message: string;
  upgradeHint: string;
}

export function buildEntitlementRequired(toolName: string): EntitlementRequired {
  return {
    error: 'entitlement_required',
    entitled: false,
    tier: 'paid',
    message: `The tool "${toolName}" is part of the paid brand-data tier and requires an active entitlement.`,
    upgradeHint:
      'Set AFFILIATE_MCP_ENTITLED to enable the paid tier locally; a hosted payment flow is a separate, future step.',
  };
}
