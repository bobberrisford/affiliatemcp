/**
 * Adtraction setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Adtraction uses a single API access token. The publisher generates it inside
 * their Adtraction account and pastes it here; the wizard validates it live
 * against the Adtraction API so the publisher learns immediately if the token
 * is wrong, rather than at first API use.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'ADTRACTION_API_TOKEN',
      label: 'Adtraction API access token',
      type: 'password',
      description:
        'Your unique Adtraction API access token. To find or generate it:\n' +
        '  1. Log in to your Adtraction account at https://adtraction.com/.\n' +
        '  2. Open Account settings (top-right menu).\n' +
        '  3. Find the "API" section.\n' +
        '  4. Copy the existing access token, or click to generate a new one.\n' +
        'This step validates the token live against the Adtraction API. If it\n' +
        'fails, re-copy the token and watch for leading or trailing spaces.',
      example: 'E0E6BF3556DB0D83C8B401EBACBD6F1B0670633E',
      validateOnEntry: (v) => validateCredential('ADTRACTION_API_TOKEN', v),
    },
  ];
}
