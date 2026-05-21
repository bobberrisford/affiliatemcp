/**
 * Impact setup steps.
 *
 * Both credentials are surfaced together on a single dashboard screen, so the
 * descriptions reference identical navigation. The wizard prompts for the SID
 * first (it has a format-only validator and no API dependency) and then the
 * token (whose validator does the live API call once the SID is in env).
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'IMPACT_ACCOUNT_SID',
      label: 'Impact Account SID',
      type: 'text',
      description:
        'Your Impact Account SID. It is also the path prefix for every API call.\n' +
        '  1. Log in at https://app.impact.com/.\n' +
        '  2. Open Settings (gear icon) → API.\n' +
        '  3. The page is titled "Account SID and Auth Token".\n' +
        '  4. Copy the value from the "Account SID" field.\n' +
        'The SID is an alphanumeric string; copy it exactly without trimming.',
      validateOnEntry: (v) => validateCredential('IMPACT_ACCOUNT_SID', v),
    },
    {
      field: 'IMPACT_AUTH_TOKEN',
      label: 'Impact Auth Token (Basic-auth password)',
      type: 'password',
      description:
        'Your Impact Auth Token. This is the Basic-auth password paired with the Account SID.\n' +
        '  1. Same screen as above — Settings → API → "Account SID and Auth Token".\n' +
        '  2. Click "Show" next to "Auth Token" and copy the value.\n' +
        '  3. If you rotate the token from the dashboard, re-run setup to update.\n' +
        'The token is long-lived but rotatable; if a call starts returning 401, regenerate here.',
      validateOnEntry: (v) => validateCredential('IMPACT_AUTH_TOKEN', v),
    },
  ];
}
