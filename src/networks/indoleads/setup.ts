/**
 * Indoleads setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Indoleads uses a single self-issued API token. The publisher needs one value:
 *   - INDOLEADS_API_TOKEN — from Account → API Settings in the Indoleads app.
 *
 * The token step performs a live validation call so the publisher learns
 * immediately if the token is wrong, rather than at first API use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'INDOLEADS_API_TOKEN',
      label: 'Indoleads API Token',
      type: 'password',
      description:
        'Your Indoleads API token. To find it:\n' +
        '  1. Log in at https://app.indoleads.com/.\n' +
        '  2. Open "Account" from the main menu.\n' +
        '  3. Select the "API Settings" page.\n' +
        '  4. Copy the token shown there (generate one if none exists).\n' +
        'The token authenticates every API call (sent as an Authorization: Bearer header).\n' +
        'This step validates the token against the Indoleads API immediately after you enter it.',
      example: 'a1b2c3d4e5f6...',
      validateOnEntry: (v) => validateCredential('INDOLEADS_API_TOKEN', v),
    },
  ];
}
