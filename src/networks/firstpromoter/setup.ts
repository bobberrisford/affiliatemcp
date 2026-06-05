/**
 * FirstPromoter setup steps. Two credentials: the API key (Bearer token) and
 * the numeric account id (the `ACCOUNT-ID` header). Both are copied from the
 * same dashboard screen. Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, API_KEY_ENV, ACCOUNT_ID_ENV } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: API_KEY_ENV,
      label: 'FirstPromoter API key',
      type: 'password',
      description:
        'Find your API key in FirstPromoter:\n' +
        '  1. Log in to your FirstPromoter dashboard.\n' +
        '  2. Open Settings.\n' +
        '  3. Open Integrations, then Manage API Keys.\n' +
        '  4. Copy the API key.\n' +
        'It is sent as the HTTP Bearer token on every request. Keep it secret — ' +
        'it grants full access to your FirstPromoter account data.',
      validateOnEntry: (v) => validateCredential(API_KEY_ENV, v),
    },
    {
      field: ACCOUNT_ID_ENV,
      label: 'FirstPromoter account id',
      type: 'text',
      description:
        'On the same Manage API Keys screen (Settings › Integrations › Manage API Keys), ' +
        'copy the numeric account id shown next to the API key. It is sent in the ' +
        '`ACCOUNT-ID` request header and identifies which FirstPromoter account the key ' +
        'belongs to.',
      example: '123456',
      validateOnEntry: (v) => validateCredential(ACCOUNT_ID_ENV, v),
    },
  ];
}
