/**
 * Action capability map — network-neutral readiness helpers.
 *
 * See docs/decisions/2026-06-18-action-capability-map.md. These are pure,
 * non-probing helpers: they read local credential PRESENCE only (never a value)
 * and never issue a network call. The descriptor COLLECTOR that knows about
 * specific networks lives in the tool layer (src/tools/), not here, so this
 * shared module stays network-neutral.
 */

import { getCredential } from './config.js';
import type { ActionCredentialRequirement, ActionDescriptor, ActionReadiness } from './types.js';

/**
 * Presence-only snapshot of a descriptor's credential requirements for the
 * current process environment. Reports whether each label is configured —
 * never the value. A write action stays visible with its credential absent so
 * the operator can see the blast radius before opting in.
 */
export function snapshotCredentials(descriptor: ActionDescriptor): ActionCredentialRequirement[] {
  return descriptor.credentialRequirements.map((r) => ({
    label: r.label,
    configured: getCredential(r.label) !== undefined,
  }));
}

/** Per-entry readiness scope. Both flags are resolved without a network call. */
export interface ReadinessScope {
  /** Did the caller pass a brand filter? */
  brandProvided: boolean;
  /** Is that brand bound (in brands.json) to this descriptor's network? */
  brandBoundToNetwork: boolean;
}

/**
 * Compute runtime readiness for one descriptor against a scope. Fail-closed:
 * a missing required credential is `missing_credentials`; an advertiser action
 * with no brand named cannot be confirmed ready, so it is `unknown`; a brand
 * named but not bound to this network is `unsupported`; otherwise `ready`.
 *
 * Takes the already-computed credential snapshot (from `snapshotCredentials`)
 * so it stays pure and unit-testable without touching the environment.
 */
export function computeReadiness(
  credentials: ActionCredentialRequirement[],
  scope: ReadinessScope,
): ActionReadiness {
  if (credentials.some((c) => !c.configured)) return 'missing_credentials';
  if (!scope.brandProvided) return 'unknown';
  if (!scope.brandBoundToNetwork) return 'unsupported';
  return 'ready';
}
