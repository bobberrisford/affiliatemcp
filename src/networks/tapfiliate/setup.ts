/**
 * Tapfiliate setup steps. One credential: the API key (sent as the `X-Api-Key`
 * header). Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TAPFILIATE_API_KEY',
      label: 'Tapfiliate API key',
      type: 'password',
      description:
        'Find your API key in Tapfiliate:\n' +
        '  1. Log in to your Tapfiliate account.\n' +
        '  2. Open Settings, then the API tab.\n' +
        '  3. Create or copy an API key.\n' +
        'It is sent as the X-Api-Key header on every request. ' +
        'Keep it secret — it grants full access to your Tapfiliate data.',
      validateOnEntry: (v) => validateCredential('TAPFILIATE_API_KEY', v),
    },
  ];
}
