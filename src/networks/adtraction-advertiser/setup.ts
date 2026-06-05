/**
 * Adtraction advertiser setup steps.
 *
 * Defines the prompts the wizard shows during
 * `affiliate-networks-mcp setup adtraction-advertiser`.
 *
 * Adtraction uses a single API access token. The advertiser generates it inside
 * their Adtraction account and pastes it here; the wizard validates it live
 * against the Adtraction advertiser API so the operator learns immediately if
 * the token is wrong, rather than at first API use.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'ADTRACTION_ADVERTISER_API_TOKEN',
      label: 'Adtraction advertiser API access token',
      type: 'password',
      description:
        'Your unique Adtraction API access token, taken from your ADVERTISER account. To find or\n' +
        'generate it:\n' +
        '  1. Log in to your Adtraction advertiser account at https://adtraction.com/.\n' +
        '  2. Open Account settings (top-right menu).\n' +
        '  3. Find the "API" section.\n' +
        '  4. Copy the existing access token, or click to generate a new one.\n' +
        'This adapter is read-only: it only calls Adtraction advertiser data-READ endpoints\n' +
        '(advertiser transactions and advertiser programmes), which are POST-with-body by design.\n' +
        'For defence in depth, prefer a read-only token if your Adtraction account offers token\n' +
        'scoping. This step validates the token live against the Adtraction advertiser API. If it\n' +
        'fails, re-copy the token and watch for leading or trailing spaces.',
      example: 'E0E6BF3556DB0D83C8B401EBACBD6F1B0670633E',
      validateOnEntry: (v) => validateCredential('ADTRACTION_ADVERTISER_API_TOKEN', v),
    },
  ];
}
