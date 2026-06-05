/**
 * Rewardful setup steps. One credential: the API Secret (HTTP Basic username,
 * empty password). Reference: `src/networks/awin/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'REWARDFUL_API_SECRET',
      label: 'Rewardful API Secret',
      type: 'password',
      description:
        'Find your API Secret in Rewardful:\n' +
        '  1. Log in to your Rewardful account.\n' +
        '  2. Open Company Settings.\n' +
        '  3. Copy the API Secret.\n' +
        'It is sent as the HTTP Basic username (with an empty password) on every request. ' +
        'Keep it secret — it grants full access to your Rewardful data.',
      validateOnEntry: (v) => validateCredential('REWARDFUL_API_SECRET', v),
    },
  ];
}
