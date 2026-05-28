/**
 * Everflow advertiser setup steps.
 *
 * Two credentials:
 *   1. EVERFLOW_API_KEY       — Network API key (created by a network admin)
 *   2. EVERFLOW_ADVERTISER_ID — The network_advertiser_id for the advertiser account
 *
 * The API key must be created by a network admin; the advertiser user cannot
 * create it themselves. See docs/networks/everflow-advertiser.md for the
 * full setup walkthrough.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EVERFLOW_API_KEY',
      label: 'Everflow Network API key',
      type: 'password',
      description:
        'Your Everflow Network API key. This key is created by a network admin, NOT by the advertiser directly.\n' +
        '  To generate one:\n' +
        '  1. Log in to the Everflow UI as a network admin.\n' +
        '  2. Navigate to Control Center → Security → API Keys.\n' +
        '  3. Click "Generate API Key", choose a descriptive label, and set appropriate permission scopes.\n' +
        '  4. Copy the key immediately — it is displayed only once.\n' +
        '  5. Share the key via a secure channel (e.g. a password manager) with the integration operator.\n' +
        'Note: Network API keys are scoped to the entire network and can access all advertiser data ' +
        'the key permissions allow. Create narrowly scoped keys per integration.',
      example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      validateOnEntry: (v) => validateCredential('EVERFLOW_API_KEY', v),
    },
    {
      field: 'EVERFLOW_ADVERTISER_ID',
      label: 'Everflow advertiser ID (network_advertiser_id)',
      type: 'text',
      description:
        'The numeric ID of the advertiser account to integrate with (network_advertiser_id).\n' +
        '  To find it:\n' +
        '  1. Log in to the Everflow UI.\n' +
        '  2. Navigate to Advertisers (left-hand menu).\n' +
        '  3. Click on the advertiser account.\n' +
        '  4. Read the ID from the URL bar (e.g. /advertisers/42 → use "42").\n' +
        'Alternatively, call listBrands() after auth is set up — it returns all advertisers ' +
        'visible under the API key with their network_advertiser_id values.',
      example: '42',
      validateOnEntry: (v) => validateCredential('EVERFLOW_ADVERTISER_ID', v),
    },
  ];
}
