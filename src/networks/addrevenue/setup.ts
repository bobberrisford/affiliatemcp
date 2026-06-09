/**
 * Addrevenue setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup`. The
 * descriptions are user-facing copy: reference the exact dashboard labels so a
 * person who has never used Addrevenue can complete setup.
 *
 * Kept in a small, side-effect-free module (no adapter instantiation) so the
 * wizard's module graph never accidentally triggers an Addrevenue API call.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'ADDREVENUE_API_TOKEN',
    label: 'Addrevenue API token',
    type: 'password',
    description:
      'Generate a lifetime API token in the Addrevenue publisher dashboard:\n' +
      '  1. Sign in at https://addrevenue.io/.\n' +
      '  2. Open "Tools" in the left-hand menu, then "API Tokens".\n' +
      '  3. If no token is listed, click "Generate new token" and copy the value.\n' +
      'The token is a long-lived OAuth2 token (no auto-expiry) but can be revoked from the same screen.',
    validateOnEntry: (v) => validateCredential('ADDREVENUE_API_TOKEN', v),
  },
  {
    field: 'ADDREVENUE_CHANNEL_ID',
    label: 'Addrevenue channel ID',
    type: 'text',
    example: '123456',
    description:
      'Your numeric Addrevenue channel ID. It is shown in the dashboard and is the `c` parameter in your ' +
      'tracking links (https://addrevenue.io/t?c=<channelId>&a=<advertiserId>). It is used to scope reporting ' +
      'queries and to build tracking links.',
    validateOnEntry: (v) => validateCredential('ADDREVENUE_CHANNEL_ID', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
