/**
 * 2Performant setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-networks-mcp setup 2performant`. 2Performant authenticates with the
 * account login (email + password): there is no static API key. The password is
 * stored locally in `~/.affiliate-mcp/.env` like any other secret and never
 * leaves the machine.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so the step list must stay a
 * small side-effect-free module (no risk of triggering a 2Performant API call
 * from the wizard's module graph).
 */

import type { SetupStep } from '../../shared/types.js';
import { EMAIL_ENV, PASSWORD_ENV, validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: EMAIL_ENV,
      label: '2Performant account email',
      type: 'text',
      example: 'you@example.com',
      description:
        'The email address you use to sign in to 2Performant at https://network.2performant.com/.\n' +
        '2Performant has no static API key: the adapter signs in with your account email and\n' +
        'password to obtain a session, exactly as the website does.',
      validateOnEntry: (v) => validateCredential(EMAIL_ENV, v),
    },
    {
      field: PASSWORD_ENV,
      label: '2Performant account password',
      type: 'password',
      description:
        'The password for your 2Performant account. It is stored locally in\n' +
        '~/.affiliate-mcp/.env and used only to obtain a session from the sign-in endpoint.\n' +
        'If you change your 2Performant password you must update this value.',
      validateOnEntry: (v) => validateCredential(PASSWORD_ENV, v),
    },
  ];
}
