/**
 * PartnerStack (partner side) setup steps.
 *
 * One credential: the Partner API key. Reference: `src/networks/awin/setup.ts`.
 * The description names the verbatim dashboard navigation so a partner who has
 * never opened the API screen can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'PARTNERSTACK_API_KEY',
      label: 'PartnerStack Partner API key',
      type: 'password',
      description:
        'Generate a Partner API key in the PartnerStack dashboard:\n' +
        '  1. Log in to your PartnerStack partner account.\n' +
        '  2. Open your user menu (top-right) → Settings.\n' +
        '  3. Open the "API keys" section.\n' +
        '  4. Generate a key and copy the value.\n' +
        'The key is long-lived and sent as a Bearer token on every request.',
      validateOnEntry: (v) => validateCredential('PARTNERSTACK_API_KEY', v),
    },
  ];
}
