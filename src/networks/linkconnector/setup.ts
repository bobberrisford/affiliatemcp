/**
 * LinkConnector setup steps.
 *
 * LinkConnector needs a single credential: the API key generated in-dashboard.
 * The wizard reads the step list and each step's `validateOnEntry` (which calls
 * `validateCredential` in `auth.ts`). There is no derived credential to skip.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so the step list must be a
 * small, side-effect-free module that cannot trigger an API call from the
 * wizard's module graph.
 *
 * The descriptions are user-facing copy: reference the exact dashboard
 * navigation (Tools -> API -> Create API Key) so a person who has never used
 * the LinkConnector API can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'LINKCONNECTOR_API_KEY',
    label: 'LinkConnector API key',
    type: 'password',
    description:
      'Generate an API key in the LinkConnector affiliate dashboard:\n' +
      '  1. Sign in at https://www.linkconnector.com/.\n' +
      '  2. Open the Tools menu and click API.\n' +
      '  3. Click Create API Key and copy the value shown.\n' +
      'The key is long-lived and can be revoked from the same screen.',
    validateOnEntry: (v) => validateCredential('LINKCONNECTOR_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
