/**
 * Affiliate Future setup steps.
 *
 * Affiliate Future authenticates publisher API calls with an API key and an API
 * password, both shown on the "Reporting APIs" page inside the publisher
 * account dashboard. There is no derived second identifier (the credentials are
 * already scoped to a single publisher account), so both values are prompted.
 *
 * The key cannot be verified on its own — a live check needs both the key and
 * the password — so the live validation runs on the password step (entered
 * second). See `validateCredential` in auth.ts.
 *
 * Reference: src/networks/awin/setup.ts and src/networks/everflow/setup.ts.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'AFFILIATE_FUTURE_API_KEY',
    label: 'Affiliate Future API key',
    type: 'password',
    description:
      'Find your publisher API key in the Affiliate Future account dashboard:\n' +
      '  1. Sign in at https://affiliates.affiliatefuture.com/.\n' +
      '  2. Open the Account menu and select the "Reporting APIs" page.\n' +
      '  3. Copy the API key shown for your account.\n' +
      'The key is paired with the API password entered in the next step.',
    validateOnEntry: (v) => validateCredential('AFFILIATE_FUTURE_API_KEY', v),
  },
  {
    field: 'AFFILIATE_FUTURE_PASSWORD',
    label: 'Affiliate Future API password',
    type: 'password',
    description:
      'On the same "Reporting APIs" page in the Affiliate Future account dashboard, copy the API ' +
      'password shown alongside the API key. The wizard validates the key and password together ' +
      'against the Merchant List endpoint once both are entered.',
    validateOnEntry: (v) => validateCredential('AFFILIATE_FUTURE_PASSWORD', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
