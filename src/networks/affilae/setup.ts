/**
 * Affilae setup steps.
 *
 * Affilae needs a single credential: a bearer token generated from the
 * dashboard "API Tokens" menu. The descriptions are user-facing copy — they
 * reference the literal dashboard menu name so a person who has never used the
 * Affilae API can complete setup.
 *
 * This module is side-effect-free: the wizard imports `setupSteps()` without
 * instantiating the adapter, so there is no risk of triggering an Affilae API
 * call from the wizard's module graph.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'AFFILAE_API_TOKEN',
    label: 'Affilae API token',
    type: 'password',
    description:
      'Generate a bearer token from your Affilae publisher dashboard:\n' +
      '  1. Sign in at https://app.affilae.com/.\n' +
      '  2. Open the "API Tokens" menu (under your account settings).\n' +
      '  3. Click to create a new token and copy the value.\n' +
      'The token is long-lived (no auto-expiry) but can be revoked from the same screen. ' +
      'Use a publisher token, not an advertiser token.',
    validateOnEntry: (v) => validateCredential('AFFILAE_API_TOKEN', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
