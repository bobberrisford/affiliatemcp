/**
 * eHUB setup steps.
 *
 * Patterned on `src/networks/awin/setup.ts`. Defines the prompts the wizard
 * shows during `affiliate-mcp setup ehub`. Descriptions are user-facing copy:
 * reference exact dashboard labels so a person who has never used eHUB can
 * complete setup.
 *
 * eHUB needs two credentials:
 *   - EHUB_API_KEY        — the `apiKey` value used for every API call.
 *   - EHUB_PUBLISHER_ID   — the publisher's `a_aid`, needed to build tracking
 *                           links. eHUB does not return this from a cheap auth
 *                           call we can rely on, so it is prompted (not derived).
 *
 * Docs: https://ehub.docs.apiary.io/
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EHUB_API_KEY',
      label: 'eHUB API key',
      type: 'password',
      description:
        'Generate an API key in the eHUB dashboard:\n' +
        '  1. Sign in at https://ehub.cz/.\n' +
        '  2. Open your profile / account settings and find the API section.\n' +
        '  3. Generate (or copy) your API key.\n' +
        'The key is passed to the eHUB API v3 as the `apiKey` parameter on every request.',
      validateOnEntry: (v) => validateCredential('EHUB_API_KEY', v),
    },
    {
      field: 'EHUB_PUBLISHER_ID',
      label: 'eHUB publisher ID (a_aid)',
      type: 'text',
      example: '412289c2',
      description:
        'Your eHUB publisher ID — the `a_aid` value shown in your profile and embedded in your ' +
        'tracking links (for example a_aid=412289c2 in a click.php link). It is required to build ' +
        'tracking links; the other operations work without it.',
      validateOnEntry: (v) => validateCredential('EHUB_PUBLISHER_ID', v),
    },
  ];
}
