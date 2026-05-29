/**
 * Tradedoubler advertiser setup steps.
 *
 * Two credentials are required:
 *   1. TRADEDOUBLER_ADV_TOKEN — the 40-character REPORTS system API token.
 *   2. TRADEDOUBLER_ADV_ORGANIZATION_ID — the numeric organisation ID.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TRADEDOUBLER_ADV_TOKEN',
      label: 'Tradedoubler API token (REPORTS system)',
      type: 'password',
      description:
        'Your Tradedoubler REPORTS API token. Steps to find it:\n' +
        '  1. Log in to the Tradedoubler advertiser portal.\n' +
        '  2. Click Account (top-right) → Manage tokens.\n' +
        '  3. Locate the row where the "System" column shows "REPORTS".\n' +
        '  4. Copy the 40-character hex token from that row.\n' +
        'If no REPORTS token exists, click "Generate new token" and select\n' +
        'the REPORTS system.',
      example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_ADV_TOKEN', v),
    },
    {
      field: 'TRADEDOUBLER_ADV_ORGANIZATION_ID',
      label: 'Tradedoubler Organisation ID',
      type: 'text',
      description:
        'Your Tradedoubler Organisation ID (a numeric identifier). Steps to find it:\n' +
        '  1. Log in to the Tradedoubler advertiser portal.\n' +
        '  2. Click Account (top-right) → Organisation Settings.\n' +
        '  3. The Organisation ID appears near the top of that page.\n' +
        'This ID scopes all report queries to your advertiser account.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('TRADEDOUBLER_ADV_ORGANIZATION_ID', v),
    },
  ];
}
