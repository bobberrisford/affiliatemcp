/**
 * Rakuten Advertising setup steps.
 *
 * The wizard (`src/cli/setup.ts`, future chunk) consumes these to prompt the
 * user. Step descriptions are user-facing — keep them factual and reference
 * exact dashboard labels so a person unfamiliar with the Rakuten portal can
 * complete setup without context-switching to find an identifier.
 *
 * Three credentials are required:
 *   - RAKUTEN_CLIENT_ID
 *   - RAKUTEN_CLIENT_SECRET
 *   - RAKUTEN_SID (the publisher Site ID)
 *
 * None can be auto-derived: `verifyAuth()` returns `derivedValues: {}` because
 * the SID is not extractable from the token response.
 *
 * Approval friction: Rakuten typically gates API access behind a Publisher
 * Solutions approval step. We surface that requirement explicitly in the
 * first step's description so the user knows what to expect before they hunt
 * for credentials that may not yet exist on their account.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'RAKUTEN_CLIENT_ID',
      label: 'Rakuten OAuth2 Client ID',
      type: 'text',
      description:
        'Your Rakuten Advertising OAuth2 client ID. To obtain it:\n' +
        '  1. Log in at https://rakutenadvertising.com/ → switch to the Publisher view.\n' +
        '  2. Navigate to Account → API Credentials.\n' +
        '  3. If the "API Credentials" tab does not exist, your account does not yet have ' +
        'API access — request it from the Publisher Solutions team. Typical turnaround is ' +
        '3–7 business days; the orchestrator estimates 5.\n' +
        '  4. Once provisioned, the Client ID is shown at the top of the credentials panel.',
      validateOnEntry: (v) => validateCredential('RAKUTEN_CLIENT_ID', v),
    },
    {
      field: 'RAKUTEN_CLIENT_SECRET',
      label: 'Rakuten OAuth2 Client Secret',
      type: 'password',
      description:
        'Paired with the Client ID above. The secret is shown once when the credential ' +
        'pair is generated; if you have lost it, regenerate the pair from the same ' +
        'Account → API Credentials screen (note this will invalidate the previous secret).',
      validateOnEntry: (v) => validateCredential('RAKUTEN_CLIENT_SECRET', v),
    },
    {
      field: 'RAKUTEN_SID',
      label: 'Rakuten Publisher Site ID (SID)',
      type: 'text',
      example: '4567890',
      description:
        'The numeric identifier of the publisher site you want to attribute traffic to. ' +
        'Find it in the Rakuten publisher dashboard under Account → Sites — each site ' +
        'has its own SID. The SID is required because a single OAuth2 client may have ' +
        'access to multiple sites; we cannot derive it automatically.',
      validateOnEntry: (v) => validateCredential('RAKUTEN_SID', v),
    },
  ];
}
