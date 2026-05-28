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
      label: 'Tradedoubler API Bearer Token',
      type: 'password',
      description:
        'The OAuth2 bearer token for the connect.tradedoubler.com API.\n' +
        '\n' +
        'How to obtain:\n' +
        '  1. Log in at https://publishers.tradedoubler.com/.\n' +
        '  2. Go to Tools → API Info → Clients.\n' +
        '  3. Click "Add client" to create an API client — save the Client ID and\n' +
        '     Client Secret (the secret is shown only once).\n' +
        '  4. Use the OAuth2 Resource Owner Password Credentials flow to obtain a\n' +
        '     bearer token:\n' +
        '       POST https://connect.tradedoubler.com/uaa/oauth/token\n' +
        '       grant_type=password&client_id=<id>&client_secret=<secret>\n' +
        '       &username=<your-email>&password=<your-password>\n' +
        '  5. Copy the `access_token` from the response.\n' +
        '\n' +
        'This is the connect.tradedoubler.com bearer token, distinct from the\n' +
        'per-product tokens (PRODUCTS, CONVERSIONS, VOUCHERS) used by the\n' +
        'older api.tradedoubler.com surface.',
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
