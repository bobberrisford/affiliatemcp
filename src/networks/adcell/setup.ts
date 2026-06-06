/**
 * Adcell setup steps.
 *
 * Adcell issues a dedicated API password (separate from the login password)
 * from the publisher dashboard, paired with the numeric publisher (affiliate)
 * account ID. Both are entered by the user; neither is auto-derived because
 * Adcell's verify-auth response shape is not documented publicly.
 *
 * The descriptions reference the dashboard labels reported by public sources
 * ("My ADCELL → Settings → API-Password"). They are best-effort: the API is
 * dashboard-gated and the exact wording may differ on a live account.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'ADCELL_API_TOKEN',
    label: 'Adcell API password',
    type: 'password',
    description:
      'Your Adcell API password (a dedicated key, NOT your normal login password):\n' +
      '  1. Sign in at https://www.adcell.com/ (publisher / "Affiliate" login).\n' +
      '  2. Open My ADCELL → Settings.\n' +
      '  3. Click "API-Password" and create / copy the value.\n' +
      'Note: API access may need to be enabled via Adcell support on some accounts.',
    example: 'adcell_api_xxxxxxxxxxxxxxxxxxxx',
    validateOnEntry: (v) => validateCredential('ADCELL_API_TOKEN', v),
  },
  {
    field: 'ADCELL_AFFILIATE_ID',
    label: 'Adcell publisher (affiliate) ID',
    type: 'text',
    description:
      'Your numeric Adcell publisher ID. It is shown in the My ADCELL dashboard and in most ' +
      'dashboard URLs after login. Adcell scopes API calls to this account, so it is required.',
    example: '123456',
    validateOnEntry: (v) => validateCredential('ADCELL_AFFILIATE_ID', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
