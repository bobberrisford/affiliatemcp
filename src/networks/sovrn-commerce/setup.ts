/**
 * Sovrn Commerce setup steps.
 *
 * Defines the prompts shown during `affiliate-networks-mcp setup sovrn-commerce`.
 *
 * Why this file is separate from adapter.ts: the wizard imports step lists
 * statically without instantiating the adapter. Keeping them here avoids
 * inadvertently triggering an API call at import time.
 *
 * Sovrn Commerce uses two credentials — one for reporting APIs, one for
 * tracking links. The setup order reflects their importance: the Secret key
 * is needed for any reporting; the API key is needed for generating links.
 *
 * Reference:
 *   https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis
 *   https://support.viglink.com/hc/en-us/articles/360007678554
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'SOVRN_SECRET_KEY',
      label: 'Sovrn Commerce Secret Key',
      type: 'password',
      description:
        'Your Secret key enables access to Sovrn Commerce reporting APIs. To find it:\n' +
        '  1. Log in at https://platform.sovrn.com/.\n' +
        '  2. Click Settings in the left navigation.\n' +
        '  3. Find your site in the list and click the Key icon in the Actions column.\n' +
        '  4. Click "Generate Secret Key" if you have not already done so.\n' +
        '  5. Copy the full Secret key value.\n' +
        'The Secret key covers all sites in your account; you need only one.\n' +
        'Keep it server-side only — unlike the API key, it is not for embedding in pages.',
      example: 'a1b2c3d4e5f6...',
      validateOnEntry: (v) => validateCredential('SOVRN_SECRET_KEY', v),
    },
    {
      field: 'SOVRN_API_KEY',
      label: 'Sovrn Commerce Site API Key',
      type: 'text',
      description:
        'Your site API key is used when generating affiliate tracking links. To find it:\n' +
        '  1. Log in at https://platform.sovrn.com/.\n' +
        '  2. Click Settings in the left navigation.\n' +
        '  3. Find your site in the list and click the Key icon in the Actions column.\n' +
        '  4. Copy the API key value shown (this is the short alphanumeric key, not the Secret key).\n' +
        'This key is embedded in the redirect.viglink.com tracking URLs. Each site has its own key;\n' +
        'if you manage multiple sites, use the key for your primary site here.',
      example: 'abc123',
      validateOnEntry: (v) => validateCredential('SOVRN_API_KEY', v),
    },
  ];
}
