/**
 * Levanta setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-mcp setup`. Levanta needs a single credential: the Creator API
 * bearer token. There is no second identifier to derive, so no
 * `derivedValues` flow is wired.
 *
 * The descriptions are user-facing copy: they reference the exact Levanta
 * dashboard navigation so a person who has never opened the API screen can
 * still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'LEVANTA_API_KEY',
    label: 'Levanta Creator API token',
    type: 'password',
    description:
      'Generate a bearer token in the Levanta dashboard:\n' +
      '  1. Log in to your Levanta account.\n' +
      '  2. Open the navigation menu and click "Settings".\n' +
      '  3. Select the "API" tab. (You need Admin access to view it.)\n' +
      '  4. Copy the API token shown on screen.\n' +
      'The token is long-lived and can be revoked from the same screen.',
    validateOnEntry: (v) => validateCredential('LEVANTA_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
