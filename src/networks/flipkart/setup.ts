/**
 * Flipkart Affiliate setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup flipkart`.
 * Flipkart needs two credentials, both copied from the same dashboard screen:
 * the affiliate tracking ID and the self-generated API token.
 *
 * Why this file exists separately from `adapter.ts`: the wizard imports the
 * steps statically without instantiating the adapter, so the step list must be
 * a small, side-effect-free module (no risk of triggering an API call from the
 * wizard's module graph).
 *
 * The token's live check is paired with the tracking ID (the verify call sends
 * both), so we prompt the tracking ID FIRST and validate the token against it.
 * The descriptions reference the literal dashboard labels a user will see.
 *
 * Reference: src/networks/awin/setup.ts.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'FLIPKART_AFFILIATE_ID',
    label: 'Flipkart affiliate tracking ID',
    type: 'text',
    example: 'myaffiliateid',
    description:
      'Your Flipkart affiliate tracking ID:\n' +
      '  1. Sign in at https://affiliate.flipkart.com/.\n' +
      '  2. Open the "API" menu, then "API Token".\n' +
      '  3. Copy the value shown in the "Affiliate Tracking ID" field.\n' +
      'New affiliate signups are periodically paused by Flipkart; if you cannot ' +
      'register, the programme may be closed to new applicants at the moment.',
    validateOnEntry: (v) => validateCredential('FLIPKART_AFFILIATE_ID', v),
  },
  {
    field: 'FLIPKART_AFFILIATE_TOKEN',
    label: 'Flipkart API token',
    type: 'password',
    description:
      'Generate an API token on the same screen:\n' +
      '  1. At affiliate.flipkart.com -> API -> API Token, click "Generate API Token".\n' +
      '  2. Copy the generated token.\n' +
      'Only one token is active per account: generating a new token disables the previous one. ' +
      'The token is validated against the tracking ID entered in the previous step.',
    validateOnEntry: (v) => validateCredential('FLIPKART_AFFILIATE_TOKEN', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
