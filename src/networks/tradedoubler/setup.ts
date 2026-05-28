/**
 * Tradedoubler setup steps.
 *
 * Defines the wizard prompts for `affiliate-mcp setup tradedoubler`.
 *
 * Tradedoubler requires two credentials:
 *   1. TRADEDOUBLER_API_TOKEN  — OAuth2 bearer token from Account → Manage tokens.
 *   2. TRADEDOUBLER_ORGANIZATION_ID — the publisher's numeric organisation ID
 *      (visible in the dashboard URL and account settings).
 *
 * Why this file exists separately from adapter.ts: the wizard imports steps
 * statically without instantiating the adapter, preventing accidental
 * API calls at module-load time.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TRADEDOUBLER_API_TOKEN',
      label: 'Tradedoubler API Token (bearer)',
      type: 'password',
      description:
        'Generate an API token in the Tradedoubler publisher dashboard:\n' +
        '  1. Log in at https://login.tradedoubler.com/.\n' +
        '  2. Go to Account → Manage tokens.\n' +
        '  3. Create a new token for your publisher account and copy it.\n' +
        'This is the bearer token used by the connect.tradedoubler.com API. ' +
        'It is different from the per-product tokens (PRODUCTS, CONVERSIONS, VOUCHERS) ' +
        'used by the older api.tradedoubler.com surface.',
      example: 'eyJhbGciOiJSUzI1NiJ9...',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_API_TOKEN', v),
    },
    {
      field: 'TRADEDOUBLER_ORGANIZATION_ID',
      label: 'Tradedoubler Organisation ID (numeric)',
      type: 'text',
      example: '1234567',
      description:
        'Your numeric Tradedoubler organisation (publisher) ID. ' +
        'You can find it:\n' +
        '  • In the dashboard URL after login (e.g. /home/1234567).\n' +
        '  • In Account → Organisation settings.\n' +
        'All publisher API calls are scoped to this ID.',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_ORGANIZATION_ID', v),
    },
  ];
}
