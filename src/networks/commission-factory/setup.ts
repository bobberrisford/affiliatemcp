/**
 * Commission Factory setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Commission Factory uses a single API key. The publisher needs one value:
 *   - COMMISSION_FACTORY_API_KEY — generated under their user profile in the
 *     Commission Factory dashboard (Account Settings → API).
 *
 * The step performs a live probe against GET /Affiliate/Merchants so the
 * publisher learns immediately if the key is wrong, rather than at first API use.
 *   Source: https://dev.commissionfactory.com/V1/GeneratingApiKeys/
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'COMMISSION_FACTORY_API_KEY',
      label: 'Commission Factory API Key',
      type: 'password',
      description:
        'Your Commission Factory API key. To generate it:\n' +
        '  1. Log in to the Commission Factory dashboard at https://app.commissionfactory.com/.\n' +
        '  2. Open your user profile (top-right menu) and go to Account Settings.\n' +
        '  3. Select the "API" section.\n' +
        '  4. Generate (or copy an existing) API key.\n' +
        'The key authenticates every request as the `apiKey` query parameter. This\n' +
        'step validates the key live against GET /Affiliate/Merchants. If validation\n' +
        'fails, check the key was copied without leading or trailing spaces.',
      example: 'cf_live_0000000000000000',
      validateOnEntry: (v) => validateCredential('COMMISSION_FACTORY_API_KEY', v),
    },
  ];
}
