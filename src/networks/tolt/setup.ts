/**
 * Tolt setup steps. One credential: the API key (Bearer token).
 * Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TOLT_API_KEY',
      label: 'Tolt API key',
      type: 'password',
      description:
        'Find your API key in Tolt:\n' +
        '  1. Log in to your Tolt account.\n' +
        '  2. Open Settings.\n' +
        '  3. Open the Integrations tab.\n' +
        '  4. Copy the API key.\n' +
        'It is sent as a Bearer token on every request. Keep it secret — it ' +
        'grants full access to your Tolt data.',
      validateOnEntry: (v) => validateCredential('TOLT_API_KEY', v),
    },
  ];
}
