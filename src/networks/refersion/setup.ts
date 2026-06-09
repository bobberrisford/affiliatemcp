/**
 * Refersion setup steps. Two credentials: the public API key and the secret
 * key, sent as the `Refersion-Public-Key` / `Refersion-Secret-Key` headers.
 * Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'REFERSION_API_KEY',
      label: 'Refersion Public Key',
      type: 'password',
      description:
        'Find your API keys in Refersion:\n' +
        '  1. Log in to your Refersion account.\n' +
        '  2. Open Account > Settings.\n' +
        '  3. Copy the Public Key.\n' +
        'It is sent as the Refersion-Public-Key header on every request.',
      validateOnEntry: (v) => validateCredential('REFERSION_API_KEY', v),
    },
    {
      field: 'REFERSION_SECRET_KEY',
      label: 'Refersion Secret Key',
      type: 'password',
      description:
        'On the same Account > Settings page, click Show to reveal the Secret Key, ' +
        'then copy it. It is sent as the Refersion-Secret-Key header on every request. ' +
        'Keep it secret — together with the public key it grants full access to your ' +
        'Refersion data.',
      validateOnEntry: (v) => validateCredential('REFERSION_SECRET_KEY', v),
    },
  ];
}
