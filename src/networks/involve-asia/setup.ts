/**
 * Involve Asia setup steps.
 *
 * Two credentials, both read from the publisher dashboard. The wizard validates
 * the key on entry (format only) and runs the full key + secret exchange when
 * the secret is entered — the secret cannot be checked without the key, so the
 * live verification is deferred to the secret step. See `validateCredential` in
 * `auth.ts`.
 *
 * Descriptions reference verbatim dashboard navigation so a user who has never
 * opened the Involve Asia API screen can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'INVOLVE_ASIA_API_KEY',
    label: 'Involve Asia API key',
    type: 'password',
    description:
      'Find your API key in the Involve Asia publisher dashboard:\n' +
      '  1. Log in at https://app.involve.asia/.\n' +
      '  2. Open the "Tools" menu and click "API".\n' +
      '  3. Copy the "API Key" value.\n' +
      'The key is paired with the API secret to obtain a short-lived token (it expires roughly every 2 hours; the adapter refreshes it for you).',
    validateOnEntry: (v) => validateCredential('INVOLVE_ASIA_API_KEY', v),
  },
  {
    field: 'INVOLVE_ASIA_API_SECRET',
    label: 'Involve Asia API secret',
    type: 'password',
    description:
      'On the same Dashboard → Tools → API screen, copy the "API Secret" value. ' +
      'The wizard verifies the key and secret together by requesting a token once the secret is entered.',
    validateOnEntry: (v) => validateCredential('INVOLVE_ASIA_API_SECRET', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
