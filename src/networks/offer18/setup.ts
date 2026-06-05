/**
 * Offer18 setup steps.
 *
 * Offer18 is a tenant network engine: the same API powers many Offer18-hosted
 * networks, each on its own instance host. The user must therefore supply the
 * per-tenant base URL plus three affiliate credentials, all of which come from
 * the affiliate dashboard under Account » Security.
 *
 * Verbatim navigation (affiliate dashboard):
 *   1. Log in to your Offer18 affiliate dashboard (the network operator's host).
 *   2. Open Account » Security.
 *   3. Click "view" next to the Secret key to reveal it.
 *   4. Note the API key, the Secret key, and your MID shown in the same panel.
 *   5. The base URL is your instance API host, e.g. https://api.offer18.com, or
 *      the white-label API host your network operator gave you.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'OFFER18_BASE_URL',
      label: 'Offer18 instance API base URL',
      type: 'text',
      description:
        'Offer18 powers many networks, each on its own host, so there is no shared default.\n' +
        '  - If your network runs on the main Offer18 platform, use https://api.offer18.com.\n' +
        '  - If your network operator gave you a white-label API host, use that instead.\n' +
        'Enter the absolute URL of the API host (http or https).',
      example: 'https://api.offer18.com',
      validateOnEntry: (v) => validateCredential('OFFER18_BASE_URL', v),
    },
    {
      field: 'OFFER18_API_KEY',
      label: 'Offer18 affiliate API key',
      type: 'password',
      description:
        'In your Offer18 affiliate dashboard:\n' +
        '  1. Open Account » Security.\n' +
        '  2. Copy the API key shown in the API credentials panel.\n' +
        'This becomes the `key` parameter on every affiliate API call.',
      example: '0123456789abcdef',
      validateOnEntry: (v) => validateCredential('OFFER18_API_KEY', v),
    },
    {
      field: 'OFFER18_SECRET_KEY',
      label: 'Offer18 Secret key (affiliate id)',
      type: 'password',
      description:
        'In your Offer18 affiliate dashboard:\n' +
        '  1. Open Account » Security.\n' +
        '  2. Click "view" next to the Secret key to reveal it, then copy it.\n' +
        'Offer18 affiliate API calls carry this as the `aid` parameter alongside the API key.',
      example: '000000',
      validateOnEntry: (v) => validateCredential('OFFER18_SECRET_KEY', v),
    },
    {
      field: 'OFFER18_MID',
      label: 'Offer18 MID (network/advertiser account id)',
      type: 'number',
      description:
        'Your numeric MID, shown alongside the API credentials under Account » Security.\n' +
        'It is sent as the `mid` parameter on every affiliate API call.',
      example: '1234',
      validateOnEntry: (v) => validateCredential('OFFER18_MID', v),
    },
  ];
}
