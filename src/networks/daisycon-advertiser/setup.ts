/**
 * Daisycon advertiser setup steps.
 *
 * Three OAuth credentials, the same as the publisher Daisycon adapter but with
 * advertiser-scoped env-var names. The advertiser ids themselves are NOT
 * collected here — they are discovered via `listBrands()` (GET /advertisers)
 * after auth verifies, and bound to logical brand slugs in `brands.json`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'DAISYCON_ADVERTISER_CLIENT_ID',
      label: 'Daisycon advertiser OAuth Client ID',
      type: 'text',
      description:
        'Your Daisycon OAuth Client ID. Create OAuth credentials in the Daisycon console under\n' +
        'Settings → API / OAuth. STRONGLY RECOMMENDED: limit the OAuth scope to reading advertiser,\n' +
        'campaign and user-profile data — this adapter only ever issues GET requests, so a read-only\n' +
        'scope plus the client-side read-only guard gives you defence in depth.',
      validateOnEntry: (v) => validateCredential('DAISYCON_ADVERTISER_CLIENT_ID', v),
    },
    {
      field: 'DAISYCON_ADVERTISER_CLIENT_SECRET',
      label: 'Daisycon advertiser OAuth Client Secret',
      type: 'password',
      description:
        'Your Daisycon OAuth Client Secret, shown alongside the Client ID when you create the OAuth\n' +
        'credentials in the Daisycon console. On submit the wizard performs a live token exchange\n' +
        'against https://login.daisycon.com/oauth/access-token to confirm the credentials work.',
      validateOnEntry: (v) => validateCredential('DAISYCON_ADVERTISER_CLIENT_SECRET', v),
    },
    {
      field: 'DAISYCON_ADVERTISER_REFRESH_TOKEN',
      label: 'Daisycon advertiser OAuth Refresh Token',
      type: 'password',
      description:
        'Your Daisycon OAuth refresh token. Obtain it once by completing the interactive\n' +
        'authorization_code + PKCE consent (see docs/networks/daisycon-advertiser.md). The adapter\n' +
        'then exchanges this refresh token for short-lived access tokens automatically; it never\n' +
        'performs the interactive redirect itself. The refresh token may expire and then requires\n' +
        're-authorisation.',
      validateOnEntry: (v) => validateCredential('DAISYCON_ADVERTISER_REFRESH_TOKEN', v),
    },
  ];
}
