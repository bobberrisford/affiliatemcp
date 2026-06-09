/**
 * Partnero setup steps. One credential: the API token (sent as a Bearer token).
 * The token is generated per programme, so it scopes a single programme.
 * Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'PARTNERO_API_KEY',
      label: 'Partnero API token',
      type: 'password',
      description:
        'Find your API token in Partnero:\n' +
        '  1. Log in to your Partnero account.\n' +
        '  2. Under the Programs section, open Integration.\n' +
        '  3. Switch to the API tab.\n' +
        '  4. Create a new API key (one per integration) and copy it.\n' +
        'The token is shown once. It is sent as a Bearer token on every request, and it ' +
        'scopes the single programme it was generated for. Keep it secret — it grants ' +
        'full access to that programme.',
      validateOnEntry: (v) => validateCredential('PARTNERO_API_KEY', v),
    },
  ];
}
