/**
 * Pepperjam (Ascend by Partnerize) setup steps.
 *
 * Defines the prompts the wizard (`affiliate-networks-mcp setup`) shows.
 * Pepperjam needs a single credential: the self-issued publisher API key.
 *
 * The description references the exact Ascend console navigation so a person
 * who has never used the dashboard can still complete setup. Treat the copy as
 * user-facing.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, PEPPERJAM_API_KEY_ENV } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: PEPPERJAM_API_KEY_ENV,
      label: 'Pepperjam (Ascend) Publisher API Key',
      type: 'password',
      description:
        'Generate a publisher API key in the Ascend console:\n' +
        '  1. Log in at https://ascend.pepperjam.com/.\n' +
        '  2. Open Resources → API Keys (https://ascend.pepperjam.com/affiliate/api/).\n' +
        '  3. Click "Generate New Key" and copy the value.\n' +
        'The key is long-lived (no auto-expiry) and is scoped to your publisher ' +
        'account. It is sent as a query parameter on every API request.',
      validateOnEntry: (v) => validateCredential(PEPPERJAM_API_KEY_ENV, v),
    },
  ];
}
