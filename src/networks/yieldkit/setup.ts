/**
 * Yieldkit setup steps.
 *
 * Defines the prompts the wizard (`affiliate-networks-mcp setup yieldkit`)
 * shows. Yieldkit needs two credentials, both copied from the same dashboard
 * screen: an API key and an API secret. Neither can be derived from the other,
 * so both are prompted.
 *
 * The descriptions are user-facing copy — reference the exact dashboard labels
 * so a person who has never used Yieldkit can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'YIELDKIT_API_KEY',
    label: 'Yieldkit API key',
    type: 'password',
    description:
      'Find your API key in the Yieldkit dashboard:\n' +
      '  1. Log in at https://www.yieldkit.com/.\n' +
      '  2. Open "Account" in the left-hand menu.\n' +
      '  3. Click "API access".\n' +
      '  4. Copy the "API key" value.\n' +
      'The key is verified together with the API secret in the next step.',
    validateOnEntry: (v) => validateCredential('YIELDKIT_API_KEY', v),
  },
  {
    field: 'YIELDKIT_API_SECRET',
    label: 'Yieldkit API secret',
    type: 'password',
    description:
      'On the same "Account → API access" screen, copy the "API secret" value. ' +
      'Entering it verifies both credentials against the Advertiser API.',
    validateOnEntry: (v) => validateCredential('YIELDKIT_API_SECRET', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
