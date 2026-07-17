/**
 * Browser-handoff constraint floor.
 *
 * See docs/decisions/2026-06-12-browser-handoff-contract.md, decision 4. The
 * `constraints` array on a `BrowserHandoff` is composed, not free-form per
 * adapter: a shared default floor, defined once here and inherited by every
 * handoff, always comes first and can never be removed or overridden. Adapters
 * append per-action additions but cannot weaken the floor.
 *
 * Rationale (decision 4): both prototype emitters independently re-typed
 * overlapping subsets of these rules. A floor every adapter must re-type is a
 * floor that will eventually be missed, and one missed constraint is a safety
 * hole. Defining the floor once removes that drift.
 *
 * This module is pure: no `fetch`, no session, no DOM, no side effects. It does
 * not drive a browser; it only describes the constraints a human or a future
 * consumer must honour when carrying out a handoff.
 */

/**
 * The shared safety floor every browser handoff inherits. The five categories
 * are settled by decision 4; the exact wording lives here. Floor rules always
 * precede per-action additions and cannot be removed.
 */
export const BROWSER_CONSTRAINT_FLOOR: readonly string[] = [
  // (a) payment and payout details are out of bounds entirely.
  'Do not enter, modify, or confirm payment or payout details.',
  // (b) authentication challenges are always the user's to resolve.
  'Stop and hand back to the user on any login, MFA, or re-authentication challenge.',
  // (c) never double-submit a mutation that already appears done.
  'Do not repeat a mutation that already appears completed (for example, do not re-apply when the state already reads pending or approved).',
  // (d) mutations require an explicit, informed confirmation before submitting.
  'When the action mutates state, show the user a summary of what will be submitted and wait for explicit confirmation before submitting.',
  // (e) never accept terms or consents the user has not seen.
  'Never accept terms, compliance checkboxes, or consents the user has not seen.',
];

/**
 * Compose the full constraint list for a handoff: the shared floor first
 * (always, in order), followed by the per-action additions. The floor is never
 * removable, so it is always the leading slice of the result. De-duplication is
 * intentionally not performed; an adapter that repeats a floor rule simply
 * states it twice, which is harmless.
 */
export function composeConstraints(perAction: string[]): string[] {
  return [...BROWSER_CONSTRAINT_FLOOR, ...perAction];
}
