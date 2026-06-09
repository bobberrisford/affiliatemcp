/**
 * Travelpayouts setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-mcp setup`. The wizard consumes the step list and each step's
 * optional `validateOnEntry` (which calls `validateCredential` in `auth.ts`).
 *
 * Travelpayouts needs a single credential: the personal API token. There is no
 * separate account/publisher id to derive, so this is a one-step flow.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so keeping the step list in a
 * small, side-effect-free module avoids accidentally triggering an API call
 * from the wizard's module graph. The descriptions are user-facing copy — they
 * reference the exact dashboard labels so a first-time user can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TRAVELPAYOUTS_ACCESS_TOKEN',
      label: 'Travelpayouts API token',
      type: 'password',
      description:
        'Generate a personal API token in the Travelpayouts dashboard:\n' +
        '  1. Log in at https://www.travelpayouts.com/.\n' +
        '  2. Open your Profile from the top-right user menu.\n' +
        '  3. Find the "API token" section.\n' +
        '  4. Copy the token value (generate one if none is shown).\n' +
        'The token is long-lived (no auto-expiry) but can be regenerated from the same screen.',
      validateOnEntry: (v) => validateCredential('TRAVELPAYOUTS_ACCESS_TOKEN', v),
    },
  ];
}
