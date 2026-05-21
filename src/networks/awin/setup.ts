/**
 * Awin setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`, Chunk 4) shows during
 * `affiliate-mcp setup`. The wizard consumes:
 *   - The step list (this file).
 *   - Each step's optional `validateOnEntry` (calls `validateCredential` in
 *     `auth.ts`).
 *   - The `derivedValues` returned by `verifyAuth()` to skip prompts whose
 *     value can be auto-extracted.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - The wizard imports the steps statically without instantiating the
 *     adapter. Keeping the step list in a small, side-effect-free module means
 *     no risk of accidentally triggering an Awin API call from the wizard's
 *     module graph.
 *   - The descriptions matter: the user reads them while making the choice.
 *     Treat them as user-facing copy. Reference exact dashboard labels so a
 *     person who has never used Awin can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

/**
 * The two Awin credentials. AWIN_PUBLISHER_ID is declared even though the
 * `derivedValues` flow usually fills it for us — declaring it means:
 *   - Users editing config by hand have a known field name to use.
 *   - The wizard can re-prompt if derivation fails (token attached to no
 *     publishers, or schema change in Awin's API).
 */
export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'AWIN_API_TOKEN',
      label: 'Awin OAuth2 API Token',
      type: 'password',
      description:
        'Generate a long-lived API token in the Awin publisher dashboard:\n' +
        '  1. Log in at https://ui.awin.com/.\n' +
        '  2. Click your user menu (top-right) → Account.\n' +
        '  3. Open the "API credentials" tab.\n' +
        '  4. Click "Generate new token" and copy the value.\n' +
        'The token is long-lived (no auto-expiry) but can be revoked from the same screen.',
      validateOnEntry: (v) => validateCredential('AWIN_API_TOKEN', v),
    },
    {
      field: 'AWIN_PUBLISHER_ID',
      label: 'Awin Publisher ID (auto-derived from the token; edit if needed)',
      type: 'text',
      example: '123456',
      description:
        'Your numeric Awin publisher ID. The wizard normally extracts this from the GET /publishers ' +
        'response after the token validates — you only need to set it manually if your token has access ' +
        'to multiple publisher accounts and the wrong one was picked.',
      validateOnEntry: (v) => validateCredential('AWIN_PUBLISHER_ID', v),
    },
  ];
}
