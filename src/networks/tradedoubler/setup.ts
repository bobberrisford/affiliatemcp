/**
 * Tradedoubler setup steps.
 *
 * Defines the wizard prompts for `affiliate-mcp setup tradedoubler`.
 *
 * Tradedoubler requires five credentials:
 *   1. TRADEDOUBLER_CLIENT_ID       — OAuth2 client ID
 *   2. TRADEDOUBLER_CLIENT_SECRET   — OAuth2 client secret
 *   3. TRADEDOUBLER_USERNAME        — account username / email
 *   4. TRADEDOUBLER_PASSWORD        — account password
 *   5. TRADEDOUBLER_ORGANIZATION_ID — numeric publisher organisation ID
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TRADEDOUBLER_CLIENT_ID',
      label: 'Tradedoubler Client ID',
      type: 'text',
      description:
        'The OAuth2 client ID for the connect.tradedoubler.com API.\n' +
        '\n' +
        'How to obtain:\n' +
        '  1. Log in at https://publishers.tradedoubler.com/.\n' +
        '  2. Go to Tools → API Info → Clients.\n' +
        '  3. Click "Add client" — copy the Client ID shown.',
      example: 'my-client-id',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_CLIENT_ID', v),
    },
    {
      field: 'TRADEDOUBLER_CLIENT_SECRET',
      label: 'Tradedoubler Client Secret',
      type: 'password',
      description:
        'The OAuth2 client secret for the connect.tradedoubler.com API.\n' +
        '\n' +
        'The secret is displayed only once when you create the API client in\n' +
        'Tools → API Info → Clients. Store it securely.',
      example: 's3cr3t…',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_CLIENT_SECRET', v),
    },
    {
      field: 'TRADEDOUBLER_USERNAME',
      label: 'Tradedoubler Username (email)',
      type: 'text',
      description: 'Your Tradedoubler account email address used to log in to the dashboard.',
      example: 'you@example.com',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_USERNAME', v),
    },
    {
      field: 'TRADEDOUBLER_PASSWORD',
      label: 'Tradedoubler Password',
      type: 'password',
      description: 'Your Tradedoubler account password.',
      example: '••••••••',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_PASSWORD', v),
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
