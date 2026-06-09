/**
 * Howl setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup`. Howl needs
 * two credentials: the API key (a secret) and the numeric publisher id. Unlike
 * Awin, the publisher id is NOT auto-derivable from the key (Howl's tokeninfo
 * endpoint returns the owning user id, not the publisher id — see `auth.ts`),
 * so it is a prompted field rather than a derived one.
 *
 * The descriptions are user-facing copy. Reference the exact dashboard labels
 * so a person who has never used Howl can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'HOWL_API_KEY',
    label: 'Howl API key',
    type: 'password',
    description:
      'Generate an API key in the Howl dashboard:\n' +
      '  1. Sign in at https://app.planethowl.com/.\n' +
      '  2. Open your account menu and go to the "Developer Options" page.\n' +
      '  3. Follow the on-screen directions to create an API key and copy the value.\n' +
      'The key is long-lived but can be revoked from the same screen. Howl sends it in a custom ' +
      'Authorization header (NRTV-API-KEY); paste only the key value, not the prefix.',
    validateOnEntry: (v) => validateCredential('HOWL_API_KEY', v),
  },
  {
    field: 'HOWL_PUBLISHER_ID',
    label: 'Howl publisher ID',
    type: 'text',
    example: '12345',
    description:
      'Your numeric Howl publisher id. Howl addresses statistics and link creation by publisher id, ' +
      'which is distinct from the user id behind your key, so it cannot be auto-derived. Find it in the ' +
      'dashboard URL after signing in, or on the Developer Options page.',
    validateOnEntry: (v) => validateCredential('HOWL_PUBLISHER_ID', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
