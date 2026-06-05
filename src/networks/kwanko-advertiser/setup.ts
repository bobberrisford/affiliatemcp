/**
 * Kwanko advertiser setup steps.
 *
 * Defines the prompts the wizard shows during
 * `affiliate-networks-mcp setup kwanko-advertiser`.
 *
 * Kwanko uses a single API token. The advertiser needs one value:
 *   - KWANKO_ADVERTISER_API_TOKEN — generated in the Kwanko platform ->
 *     Features and API.
 *
 * The token step performs a live validation (a minimal authenticated call) so
 * the advertiser learns immediately if the token is wrong, rather than at first
 * API use. The token can optionally be IP-restricted in platform settings.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'KWANKO_ADVERTISER_API_TOKEN',
      label: 'Kwanko advertiser API token',
      type: 'password',
      description:
        'Your Kwanko advertiser API token. To generate it:\n' +
        '  1. Log in to the Kwanko platform at https://platform.kwanko.com/.\n' +
        '  2. Open the main menu and click "Features and API".\n' +
        '  3. Generate an API token (or copy the existing one).\n' +
        '  4. Optionally restrict the token by IP in the platform settings.\n' +
        'STRONGLY RECOMMENDED: use a read-only token. This adapter only ever issues GET\n' +
        'requests; the client refuses any other method. This step validates the token live\n' +
        'against the Kwanko advertiser API. If it fails, check for trailing spaces and confirm\n' +
        'any IP restriction allows this host.',
      example: 'kw_live_xxxxxxxxxxxxxxxx',
      validateOnEntry: (v) => validateCredential('KWANKO_ADVERTISER_API_TOKEN', v),
    },
  ];
}
