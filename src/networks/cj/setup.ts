/**
 * CJ Affiliate setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`, Chunk 4) shows during
 * `affiliate-mcp setup`. The wizard consumes:
 *   - The step list (this file).
 *   - Each step's optional `validateOnEntry` (calls `validateCredential` in
 *     `auth.ts`).
 *   - The `derivedValues` returned by `verifyAuth()` to skip prompts whose
 *     value can be auto-extracted.
 *
 * Keep this file side-effect-free — the wizard imports it statically without
 * instantiating the adapter.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

/**
 * Two CJ credentials. CJ_COMPANY_ID is declared even though the
 * `derivedValues` flow usually fills it from the `{ me { companyId } }`
 * GraphQL response — declaring it means:
 *   - Users editing config by hand have a known field name.
 *   - The wizard can re-prompt if derivation fails (token attached to a
 *     publisher with no company, or schema drift in CJ's `me` payload).
 */
export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'CJ_API_TOKEN',
      label: 'CJ Personal Access Token',
      type: 'password',
      description:
        'Generate a Personal Access Token (PAT) in the CJ publisher dashboard:\n' +
        '  1. Log in at https://members.cj.com/.\n' +
        '  2. Open the "Account" menu (top-right user avatar) → click "Account".\n' +
        '  3. Open the "Personal Access Tokens" tab in the sidebar.\n' +
        '  4. Click "Create Token" (or "Generate New Token" — label varies by tenant).\n' +
        '  5. Copy the value shown; CJ does not show it again.\n' +
        'The token is long-lived. Revoke from the same screen if it leaks.',
      validateOnEntry: (v) => validateCredential('CJ_API_TOKEN', v),
    },
    {
      field: 'CJ_COMPANY_ID',
      label: 'CJ Publisher Company ID (auto-derived from the token; edit if needed)',
      type: 'text',
      example: '1234567',
      description:
        'Your numeric CJ publisher Company ID. The wizard normally extracts this from the GraphQL ' +
        '`{ me { companyId } }` response after the token validates — you only need to set it manually ' +
        'if your token has access to multiple companies and the wrong one was picked.',
      validateOnEntry: (v) => validateCredential('CJ_COMPANY_ID', v),
    },
  ];
}
