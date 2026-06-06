/**
 * ShareASale setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup shareasale`.
 * The wizard consumes the step list and each step's `validateOnEntry`.
 * ShareASale has no derivable credential — all three fields are entered
 * directly.
 *
 * Order matters: the affiliate id and token are prompted first, then the
 * secret. The secret step runs a live signed probe (it needs all three halves
 * to sign), so the user learns immediately if any value is wrong.
 *
 * Treat the descriptions as user-facing copy: reference exact dashboard labels
 * so a person who has never used ShareASale can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'SHAREASALE_AFFILIATE_ID',
    label: 'ShareASale affiliate id',
    type: 'text',
    example: '1234567',
    description:
      'Your numeric ShareASale affiliate (publisher) id:\n' +
      '  1. Log in to the ShareASale dashboard at https://account.shareasale.com/.\n' +
      '  2. Your affiliate id is shown in the account header and on the API Manager screen.\n' +
      'It is sent on every request as the affiliateId query parameter.',
    validateOnEntry: (v) => validateCredential('SHAREASALE_AFFILIATE_ID', v),
  },
  {
    field: 'SHAREASALE_API_TOKEN',
    label: 'ShareASale API token',
    type: 'password',
    description:
      'Your ShareASale API token (the public half of the API credentials):\n' +
      '  1. Open API Manager at https://account.shareasale.com/a-apimanager.cfm.\n' +
      '  2. Copy the "API Token" value (generate one if none exists).\n' +
      'The token is sent as the token query parameter and is also mixed into the ' +
      'request signature.',
    validateOnEntry: (v) => validateCredential('SHAREASALE_API_TOKEN', v),
  },
  {
    field: 'SHAREASALE_API_SECRET',
    label: 'ShareASale API secret key',
    type: 'password',
    description:
      'Your ShareASale API secret key (the secret half of the API credentials):\n' +
      '  1. On the same API Manager screen, copy the "Secret Key" value.\n' +
      'The secret never leaves your machine — it is used locally to sign each ' +
      'request (HMAC-SHA256) and is never transmitted. The wizard verifies it by ' +
      'making one signed call to the merchant-status report.',
    validateOnEntry: (v) => validateCredential('SHAREASALE_API_SECRET', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
