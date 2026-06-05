/**
 * Commission Factory advertiser (merchant-side) setup steps.
 *
 * One required credential: the merchant API key, self-issued under Account
 * Settings. One optional credential: a merchant id hint, used only as a stable
 * brand label — the key already scopes data to one merchant.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, API_KEY_FIELD, MERCHANT_ID_FIELD } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: API_KEY_FIELD,
      label: 'Commission Factory merchant API key',
      type: 'password',
      description:
        'Your Commission Factory API key, generated from your MERCHANT account.\n' +
        'Find it at: Commission Factory dashboard → Account Settings → API → generate key.\n' +
        'The key is sent as the `apiKey` query parameter on every request. This adapter is\n' +
        'read-only: the HTTP client refuses any non-GET method, so the key is used for\n' +
        'reporting (merchant transactions) only.\n' +
        'On submit the wizard probes GET /Merchant/Transactions over a 1-day window to confirm\n' +
        'the key is accepted.',
      validateOnEntry: (v) => validateCredential(API_KEY_FIELD, v),
    },
    {
      field: MERCHANT_ID_FIELD,
      label: 'Commission Factory merchant id (optional)',
      type: 'text',
      description:
        'OPTIONAL. The merchant key already scopes data to one merchant, so this is not needed\n' +
        'to address the API. Provide it only if you want a stable brand identifier and display\n' +
        'label for `listBrands` and the brand resolver. Leave blank to let the adapter derive\n' +
        'the merchant identity (MerchantId / MerchantName) from a sample transaction.',
      validateOnEntry: (v) => validateCredential(MERCHANT_ID_FIELD, v),
    },
  ];
}
