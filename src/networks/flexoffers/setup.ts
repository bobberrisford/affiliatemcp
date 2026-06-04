/**
 * FlexOffers setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * FlexOffers uses a single account API Key for all Web Service API calls:
 *   - FLEXOFFERS_API_KEY    — required; from Tools → Web Services → API Keys.
 *   - FLEXOFFERS_ACCOUNT_ID — optional; surfaced in the verifyAuth identity
 *                             string. Not required for any API call.
 *
 * The API key step performs a live validation (a minimal /allsales call) so the
 * publisher learns immediately if the key is wrong, rather than at first use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'FLEXOFFERS_API_KEY',
      label: 'FlexOffers API Key',
      type: 'password',
      description:
        'Your FlexOffers Web Service API Key. To find it:\n' +
        '  1. Log in to your FlexOffers account at https://publishers.flexoffers.com/.\n' +
        '  2. Click "Tools" in the top navigation.\n' +
        '  3. Select "Web Services".\n' +
        '  4. Open the "API Keys" tab.\n' +
        '  5. Copy the value shown in the "API Key" column.\n' +
        'This step validates the key live against the FlexOffers API.',
      example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      validateOnEntry: (v) => validateCredential('FLEXOFFERS_API_KEY', v),
    },
    {
      field: 'FLEXOFFERS_ACCOUNT_ID',
      label: 'FlexOffers Account ID (optional)',
      type: 'text',
      description:
        'Your numeric FlexOffers Account ID. This is optional — it is used only\n' +
        'to label the account in the setup confirmation. Find it on the same\n' +
        'Tools → Web Services → API Keys page, shown alongside the Domain ID and\n' +
        'API Key. Leave blank if you are unsure; it is not required for any call.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('FLEXOFFERS_ACCOUNT_ID', v),
    },
  ];
}
