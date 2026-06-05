/**
 * Afilio setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Afilio uses two query-parameter credentials on every reporting call:
 *   - AFILIO_AFFILIATE_TOKEN — the self-issued API token (Login → "API token")
 *   - AFILIO_AFF_ID          — the numeric Affiliate ID
 *
 * The token step performs a live Sales API probe once the Aff ID is known, so
 * the publisher learns immediately if the credentials are wrong rather than at
 * first API use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'AFILIO_AFF_ID',
      label: 'Afilio Aff ID',
      type: 'text',
      description:
        'Your numeric Afilio Affiliate ID (Aff ID). To find it:\n' +
        '  1. Log in to the Afilio dashboard at https://v2.afilio.com.br/.\n' +
        '  2. Your Affiliate ID is shown in your account / profile area.\n' +
        'It is sent on every reporting API call as the "affid" parameter.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('AFILIO_AFF_ID', v),
    },
    {
      field: 'AFILIO_AFFILIATE_TOKEN',
      label: 'Afilio API Token',
      type: 'password',
      description:
        'Your Afilio Affiliate API token. To find it:\n' +
        '  1. Log in to the Afilio dashboard at https://v2.afilio.com.br/.\n' +
        '  2. Open the "Login" area of your account.\n' +
        '  3. Copy the value shown under "API token".\n' +
        'This step validates the token against the Afilio Sales API using the\n' +
        'Aff ID entered above. If validation fails, double-check both values are\n' +
        'copied without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('AFILIO_AFFILIATE_TOKEN', v),
    },
  ];
}
