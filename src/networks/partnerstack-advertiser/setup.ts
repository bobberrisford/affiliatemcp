/**
 * PartnerStack (vendor / advertiser side) setup steps.
 *
 * Two credentials: the Vendor API public + secret key pair. Reference:
 * `src/networks/impact/setup.ts` (two HTTP Basic values prompted together).
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'PARTNERSTACK_PUBLIC_KEY',
      label: 'PartnerStack Vendor API public key',
      type: 'text',
      description:
        'Find your Vendor API keys in the PartnerStack dashboard:\n' +
        '  1. Log in to your PartnerStack vendor account.\n' +
        '  2. Open Settings → API keys.\n' +
        '  3. Copy the public key.\n' +
        'The public key is the HTTP Basic username.',
      validateOnEntry: (v) => validateCredential('PARTNERSTACK_PUBLIC_KEY', v),
    },
    {
      field: 'PARTNERSTACK_SECRET_KEY',
      label: 'PartnerStack Vendor API secret key',
      type: 'password',
      description:
        'On the same Settings → API keys screen, copy the secret key. It is the HTTP Basic\n' +
        'password and is paired with the public key on every request. One key pair scopes a\n' +
        'single vendor account.',
      validateOnEntry: (v) => validateCredential('PARTNERSTACK_SECRET_KEY', v),
    },
  ];
}
