/**
 * LeadDyno setup steps. One credential: the private API key, sent as the `key`
 * query parameter on every request. Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'LEADDYNO_API_KEY',
      label: 'LeadDyno private API key',
      type: 'password',
      description:
        'Find your private API key in LeadDyno:\n' +
        '  1. Log in to your LeadDyno account.\n' +
        '  2. Open Account → Profile.\n' +
        '  3. Copy the private API key.\n' +
        'It is sent as the `key` query parameter on every request. ' +
        'Keep it secret — it grants full access to your LeadDyno data.',
      validateOnEntry: (v) => validateCredential('LEADDYNO_API_KEY', v),
    },
  ];
}
