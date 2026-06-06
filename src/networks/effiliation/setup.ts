/**
 * Effiliation setup steps.
 *
 * Effiliation issues a single long-lived API key that the publisher generates
 * from the dashboard. The key is passed on every request as the `key`
 * query-string parameter. There is no second credential to prompt for and none
 * to derive — the key is scoped to one publisher account.
 *
 * The description names the verbatim dashboard navigation so a publisher who
 * has never opened the API screen can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EFFILIATION_API_KEY',
      label: 'Effiliation API key',
      type: 'password',
      description:
        'Find your Effiliation (Effinity) API key from the publisher dashboard:\n' +
        '  1. Sign in at https://www.effiliation.com/.\n' +
        '  2. Open My account → Personal data → Credentials (the key also appears\n' +
        '     under Tools → API).\n' +
        '  3. Copy the API key value and paste it here.\n' +
        'The key is long-lived and scoped to your publisher account; it is sent as the\n' +
        '`key` query parameter on every API call.',
      validateOnEntry: (v) => validateCredential('EFFILIATION_API_KEY', v),
    },
  ];
}
