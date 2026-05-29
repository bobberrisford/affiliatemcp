/**
 * Partnerize setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 * The wizard consumes:
 *   - This step list.
 *   - Each step's optional `validateOnEntry` callback (calls `validateCredential`
 *     in `auth.ts`).
 *   - The `derivedValues` returned by `verifyAuth()` to fill in
 *     PARTNERIZE_PUBLISHER_ID without asking the user.
 *
 * Why this file exists separately from `adapter.ts`: the wizard imports the
 * steps statically without instantiating the adapter. Keeping them here means
 * no risk of triggering a Partnerize API call from the wizard's module graph.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

/**
 * The three Partnerize credentials. PARTNERIZE_PUBLISHER_ID is declared even
 * though the `derivedValues` flow usually fills it — declaring it ensures:
 *   - Users who edit config by hand have a known field name.
 *   - The wizard can re-prompt if derivation fails (no publisher accounts on key).
 */
export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'PARTNERIZE_APPLICATION_KEY',
      label: 'Partnerize Application Key',
      type: 'password',
      description:
        'Your network-level application key from the Partnerize console:\n' +
        '  1. Log in at https://console.partnerize.com/.\n' +
        '  2. Click your user menu (top-right) → Settings → Account Settings.\n' +
        '  3. Copy the value under "User Application Key".\n' +
        'The application key identifies the Partnerize network partition and does not rotate.',
      example: 'a1b2c3d4e5f6g7h8',
      validateOnEntry: (v) => validateCredential('PARTNERIZE_APPLICATION_KEY', v),
    },
    {
      field: 'PARTNERIZE_USER_API_KEY',
      label: 'Partnerize User API Key',
      type: 'password',
      description:
        'Your personal API key from the Partnerize console:\n' +
        '  1. Log in at https://console.partnerize.com/.\n' +
        '  2. Click your user menu (top-right) → Settings → Account Settings.\n' +
        '  3. Copy the value under "User API Key".\n' +
        'The user API key is the Basic-auth password used alongside the Application Key.',
      example: 'z9y8x7w6v5u4t3s2',
      validateOnEntry: (v) => validateCredential('PARTNERIZE_USER_API_KEY', v),
    },
    {
      field: 'PARTNERIZE_PUBLISHER_ID',
      label: 'Partnerize Publisher ID (auto-derived from credentials; edit if needed)',
      type: 'text',
      description:
        'Your numeric Partnerize publisher ID. The wizard normally derives this from the ' +
        'GET /user/publisher response after the credentials validate — you only need to set it ' +
        'manually if your credentials have access to multiple publisher accounts and the wrong ' +
        'one was auto-selected.\n' +
        'You can also find this ID in the Partnerize console URL after login, e.g. /publisher/1234567.',
      example: '1234567',
      validateOnEntry: (v) => validateCredential('PARTNERIZE_PUBLISHER_ID', v),
    },
  ];
}
