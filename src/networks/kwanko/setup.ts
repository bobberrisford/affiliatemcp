/**
 * Kwanko setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Kwanko uses a single API token. The publisher needs one value:
 *   - KWANKO_API_TOKEN — generated in the Kwanko platform → Features and API.
 *
 * The token step performs a live validation (a minimal authenticated call) so
 * the publisher learns immediately if the token is wrong, rather than at first
 * API use. The token can optionally be IP-restricted in platform settings.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'KWANKO_API_TOKEN',
      label: 'Kwanko API token',
      type: 'password',
      description:
        'Your Kwanko Web Service API token. To generate it:\n' +
        '  1. Log in to the Kwanko platform at https://platform.kwanko.com/.\n' +
        '  2. Open the main menu and click "Features and API".\n' +
        '  3. Generate an API token (or copy the existing one).\n' +
        '  4. Optionally restrict the token by IP in the platform settings.\n' +
        'This step validates the token live against the Kwanko API. If it fails,\n' +
        'check for trailing spaces and confirm any IP restriction allows this host.',
      example: 'kw_live_xxxxxxxxxxxxxxxx',
      validateOnEntry: (v) => validateCredential('KWANKO_API_TOKEN', v),
    },
  ];
}
