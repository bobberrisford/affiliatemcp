/**
 * Everflow setup steps.
 *
 * Everflow affiliate API keys are created by the network admin, not by the
 * affiliate themselves. Users must contact their Everflow network admin and
 * request that an API key be generated for their affiliate account from the
 * Manage Affiliate → API tab in the Everflow control panel.
 *
 * The affiliate ID is optional: it is surfaced in the identity string returned
 * by verifyAuth() but is not required for any API call (the API key itself is
 * scoped to a single affiliate account by the network admin). Include it for
 * richer diagnostic output.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EVERFLOW_API_KEY',
      label: 'Everflow Affiliate API Key',
      type: 'password',
      description:
        'Your Everflow affiliate API key is created by your network admin:\n' +
        '  1. Contact the Everflow network operator managing your account.\n' +
        '  2. Ask them to navigate to Manage Affiliate → (your account) → API tab.\n' +
        '  3. They click "+ API Key" to generate a key and must copy it immediately — ' +
        'the full key is only shown once.\n' +
        '  4. They send the key to you securely; paste it here.\n' +
        'Note: the key is long-lived and scoped to your affiliate account by the admin.',
      example: 'ef_aff_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      validateOnEntry: (v) => validateCredential('EVERFLOW_API_KEY', v),
    },
    {
      field: 'EVERFLOW_AFFILIATE_ID',
      label: 'Everflow Affiliate ID (optional — for richer diagnostics)',
      type: 'text',
      description:
        'Your numeric Everflow affiliate ID. This is optional: the API key itself is ' +
        'already scoped to your account. Providing it enables richer identity strings ' +
        'in verifyAuth() output.\n' +
        'You can find your affiliate ID in the Everflow dashboard URL after logging in, ' +
        'or ask your network admin.',
      example: '12345',
      validateOnEntry: (v) => validateCredential('EVERFLOW_AFFILIATE_ID', v),
    },
  ];
}
