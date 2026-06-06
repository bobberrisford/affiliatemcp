/**
 * Optimise Media (OMG Network API) setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup`. The OMG
 * Network API uses a single credential: an `apikey` minted by creating a
 * Service Account in the Insights Dashboard.
 *
 * Reference: src/networks/awin/setup.ts and src/networks/everflow/setup.ts.
 *
 * The descriptions are user-facing copy. They name the dashboard steps so a
 * person who has never used Optimise can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'OPTIMISE_MEDIA_API_TOKEN',
    label: 'Optimise Media API key',
    type: 'password',
    description:
      'Generate an API key from a Service Account in the Optimise Insights Dashboard:\n' +
      '  1. Log in to the Insights Dashboard.\n' +
      '  2. Open Settings → Service Accounts.\n' +
      '  3. Create a Service Account (or open an existing one).\n' +
      '  4. Generate an API key and copy the value.\n' +
      'The key is sent in the "apikey" request header. It can be revoked from the same screen.',
    validateOnEntry: (v) => validateCredential('OPTIMISE_MEDIA_API_TOKEN', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
