/**
 * mrge setup steps.
 *
 * Defines the prompts the setup wizard shows during `affiliate-mcp setup mrge`.
 *
 * mrge (Yieldkit/Metapic) uses three credentials:
 *   - MRGE_API_KEY    — found in Account → API access
 *   - MRGE_API_SECRET — found in Account → API access (same page)
 *   - MRGE_SITE_ID    — found in Account → Your Sites
 *
 * // TODO(verify): confirm the exact dashboard menu paths when testing against
 *   a live mrge publisher account. Dashboard navigation may have changed since
 *   the Yieldkit → mrge rebrand.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'MRGE_API_KEY',
      label: 'mrge API Key',
      type: 'password',
      example: 'yk_abc123...',
      description:
        'Find your API key in the mrge publisher dashboard:\n' +
        '  1. Log in at https://publisher.mrge.com/.\n' +
        '  2. Click your user menu (top-right) and select Account.\n' +
        '  3. Open the "API access" section.\n' +
        '  4. Copy the value labelled "API Key".\n' +
        '\n' +
        '// TODO(verify): confirm the exact navigation path in the current mrge dashboard.',
      validateOnEntry: (v) => validateCredential('MRGE_API_KEY', v),
    },
    {
      field: 'MRGE_API_SECRET',
      label: 'mrge API Secret',
      type: 'password',
      description:
        'Find your API secret on the same page as your API key:\n' +
        '  1. Log in at https://publisher.mrge.com/.\n' +
        '  2. Click your user menu → Account.\n' +
        '  3. Open the "API access" section.\n' +
        '  4. Copy the value labelled "API Secret".\n' +
        '\n' +
        'Keep this value confidential — it is a signing secret.',
      validateOnEntry: (v) => validateCredential('MRGE_API_SECRET', v),
    },
    {
      field: 'MRGE_SITE_ID',
      label: 'mrge Site ID',
      type: 'text',
      example: '12345',
      description:
        'Find your Site ID in the mrge publisher dashboard:\n' +
        '  1. Log in at https://publisher.mrge.com/.\n' +
        '  2. Click your user menu → Account.\n' +
        '  3. Open "Your Sites".\n' +
        '  4. Copy the numeric ID for the website you want to use.\n' +
        '\n' +
        'If you have multiple websites (sub-accounts), use the ID for your primary site.\n' +
        '// TODO(verify): confirm whether multiple site IDs need to be specified.',
      validateOnEntry: (v) => validateCredential('MRGE_SITE_ID', v),
    },
  ];
}
