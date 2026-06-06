/**
 * Digistore24 setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-networks-mcp setup`. Digistore24 needs a single credential: the
 * API key. There is no second derivable identifier (unlike Awin's publisher
 * ID), so the step list has one entry.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - The wizard imports the steps statically without instantiating the
 *     adapter. Keeping the step list in a small, side-effect-free module means
 *     no risk of accidentally triggering a Digistore24 API call from the
 *     wizard's module graph.
 *   - The descriptions are user-facing copy. Reference the exact dashboard
 *     labels so a person who has never used Digistore24 can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'DIGISTORE24_API_KEY',
    label: 'Digistore24 API key',
    type: 'password',
    description:
      'Create an API key for your Digistore24 account:\n' +
      '  1. Sign in at https://www.digistore24.com/.\n' +
      '  2. Open the developer portal at https://dev.digistore24.com/ and click "Create API key"\n' +
      '     (in the main dashboard the same screen is under Settings → API keys).\n' +
      '  3. Give the key at least read access, create it, and copy the value.\n' +
      'The key is long-lived (no auto-expiry) but can be revoked from the same screen. The key is\n' +
      'sent in the X-DS-API-KEY header on every request.',
    validateOnEntry: (v) => validateCredential('DIGISTORE24_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
