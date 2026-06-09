/**
 * Adrecord setup steps.
 *
 * Defines the prompts the wizard (`affiliate-mcp setup`) shows. Adrecord has a
 * single credential — the private API key — so there is one step. The key is
 * validated live against `GET /programs?limit=1` via `validateCredential`.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so the step list must be a
 * small, side-effect-free module that cannot trigger an API call from the
 * wizard's module graph.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, ADRECORD_API_KEY_FIELD } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: ADRECORD_API_KEY_FIELD,
      label: 'Adrecord API key',
      type: 'password',
      description:
        'Generate a private API key in the Adrecord publisher dashboard:\n' +
        '  1. Log in at https://www.adrecord.com/.\n' +
        '  2. Open Settings (the account / cog menu).\n' +
        '  3. Open the "API" section.\n' +
        '  4. Generate a private API key and copy the value.\n' +
        'The key is long-lived (no auto-expiry) but can be regenerated from the same screen.',
      validateOnEntry: (v) => validateCredential(ADRECORD_API_KEY_FIELD, v),
    },
  ];
}
