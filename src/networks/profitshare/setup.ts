/**
 * Profitshare setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup profitshare`.
 * The wizard consumes the step list, each step's `validateOnEntry`, and (where
 * applicable) the `derivedValues` returned by `verifyAuth()`. Profitshare has
 * no derivable credential — both fields are entered directly.
 *
 * Order matters: the API user is prompted first, then the key. The key step
 * runs a live signed probe (it needs the user to sign), so the user learns
 * immediately if either half is wrong.
 *
 * Treat the descriptions as user-facing copy: reference exact dashboard labels
 * so a person who has never used Profitshare can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'PROFITSHARE_API_USER',
    label: 'Profitshare API user',
    type: 'text',
    example: 'affiliate@example.com',
    description:
      'Your Profitshare API user (the public half of the credential pair):\n' +
      '  1. Log in to the Profitshare affiliate dashboard.\n' +
      '  2. Open Account → API.\n' +
      '  3. Copy the "API user" value.\n' +
      'This is sent on every request as the X-PS-Client header.',
    validateOnEntry: (v) => validateCredential('PROFITSHARE_API_USER', v),
  },
  {
    field: 'PROFITSHARE_API_KEY',
    label: 'Profitshare API key',
    type: 'password',
    description:
      'Your Profitshare API key (the secret half of the credential pair):\n' +
      '  1. On the same Account → API screen, copy the "API key" value.\n' +
      '  2. If you do not see one, click "Generate" and copy it.\n' +
      'The key never leaves your machine — it is used locally to sign each ' +
      'request (HMAC-SHA1) and is never transmitted. The wizard verifies it by ' +
      'making one signed call to the advertisers endpoint.',
    validateOnEntry: (v) => validateCredential('PROFITSHARE_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
