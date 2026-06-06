/**
 * financeAds setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup financeads`.
 * financeAds needs two credentials, both entered by the user:
 *   FINANCEADS_API_KEY  — the API key from the platform.
 *   FINANCEADS_USER_ID  — the numeric publisher / user ID.
 *
 * Unlike Awin, the user ID is not derivable from the auth response (it is
 * required for the auth call itself), so both fields are prompted. The API key
 * step defers live validation until the user ID is also present — see
 * `validateCredential` in `auth.ts`.
 *
 * Why this file exists separately from `adapter.ts`: the wizard imports the
 * steps statically without instantiating the adapter, so no financeAds API call
 * can be triggered from the wizard's module graph.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'FINANCEADS_API_KEY',
    label: 'financeAds API key',
    type: 'password',
    description:
      'Your financeAds reporting API key:\n' +
      '  1. Sign in to the financeAds platform at https://www.financeads.net/.\n' +
      '  2. Open your account settings and look for the API or "Schnittstellen" section.\n' +
      '  3. Copy the API key shown there.\n' +
      'If no API key is shown, contact financeAds support and request access to the\n' +
      '"Leads & Sales API" before continuing. Some accounts must have sales,\n' +
      'merchants, and daily-statistics access enabled separately.',
    validateOnEntry: (v) => validateCredential('FINANCEADS_API_KEY', v),
  },
  {
    field: 'FINANCEADS_USER_ID',
    label: 'financeAds user (publisher) ID',
    type: 'text',
    example: '123456',
    description:
      'Your numeric financeAds user ID. Sign in to the financeAds platform; the\n' +
      'user ID is shown at the top right of the page once you are logged in.',
    validateOnEntry: (v) => validateCredential('FINANCEADS_USER_ID', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
