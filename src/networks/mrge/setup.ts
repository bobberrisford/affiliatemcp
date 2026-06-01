/**
 * mrge setup steps.
 *
 * Defines the prompts the setup wizard shows during `affiliate-mcp setup mrge`.
 *
 * mrge (Yieldkit/Metapic) uses three credentials:
 *   - MRGE_API_KEY    — found at https://home.yieldkit.com/account/api
 *   - MRGE_API_SECRET — found at https://home.yieldkit.com/account/api (same page)
 *   - MRGE_SITE_ID    — found at https://home.yieldkit.com/account/sites
 *
 * All three credentials are hexadecimal strings (24–32 characters), not plain
 * integers. Source: Yieldkit public documentation examples.
 *
 * BLOCKED(verify): confirm the exact dashboard menu labels and navigation paths
 *   in the current mrge-branded dashboard (publisher.mrge.com vs
 *   home.yieldkit.com). The yieldkit.com paths above are confirmed from the
 *   Yieldkit docs but may have been rebranded. Requires a live mrge account.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'MRGE_API_KEY',
      label: 'mrge API Key',
      type: 'password',
      example: 'c5c2398597a6adcd9b149ad745f207f4',
      description:
        'Find your API key in the Yieldkit/mrge publisher dashboard:\n' +
        '  1. Log in at https://home.yieldkit.com/ (or https://publisher.mrge.com/ if rebranded).\n' +
        '  2. Navigate to Account → API access, or go directly to:\n' +
        '     https://home.yieldkit.com/account/api\n' +
        '  3. Copy the value labelled "API Key".\n' +
        '\n' +
        'Your API key is a 32-character hexadecimal string (example: c5c2398597a6adcd9b149ad745f207f4).',
      validateOnEntry: (v) => validateCredential('MRGE_API_KEY', v),
    },
    {
      field: 'MRGE_API_SECRET',
      label: 'mrge API Secret',
      type: 'password',
      example: '74607007cdb6b0db4b3219c8adee3e09',
      description:
        'Find your API secret on the same page as your API key:\n' +
        '  1. Log in at https://home.yieldkit.com/ (or https://publisher.mrge.com/ if rebranded).\n' +
        '  2. Navigate to Account → API access, or go directly to:\n' +
        '     https://home.yieldkit.com/account/api\n' +
        '  3. Copy the value labelled "API Secret".\n' +
        '\n' +
        'Your API secret is a 32-character hexadecimal string. Keep it confidential.',
      validateOnEntry: (v) => validateCredential('MRGE_API_SECRET', v),
    },
    {
      field: 'MRGE_SITE_ID',
      label: 'mrge Site ID',
      type: 'text',
      example: '51e8ee76e4b0dc18d49a4337',
      description:
        'Find your Site ID in the Yieldkit/mrge publisher dashboard:\n' +
        '  1. Log in at https://home.yieldkit.com/ (or https://publisher.mrge.com/ if rebranded).\n' +
        '  2. Navigate to Account → Your Sites, or go directly to:\n' +
        '     https://home.yieldkit.com/account/sites\n' +
        '  3. Copy the ID for the website you want to use.\n' +
        '\n' +
        'Your Site ID is a 24- or 32-character hexadecimal string (example: 51e8ee76e4b0dc18d49a4337),\n' +
        'NOT a plain number. If you have multiple sites, use the ID for your primary site.',
      validateOnEntry: (v) => validateCredential('MRGE_SITE_ID', v),
    },
  ];
}
