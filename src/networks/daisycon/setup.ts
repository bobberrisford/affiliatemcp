/**
 * Daisycon setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Daisycon uses OAuth2. The publisher needs four values:
 *   - DAISYCON_CLIENT_ID      — from the OAuth credentials created in the console
 *   - DAISYCON_CLIENT_SECRET  — from the same place
 *   - DAISYCON_REFRESH_TOKEN  — obtained via the one-time authorisation step
 *   - DAISYCON_PUBLISHER_ID   — the numeric publisher ID, visible in the console
 *
 * The refresh-token step performs a live token-exchange validation so the
 * publisher learns immediately if the credentials are wrong, rather than at
 * first API use.
 *
 * Why we cannot auto-derive DAISYCON_PUBLISHER_ID: Daisycon does not expose the
 * publisher id in the token response. The publisher must supply it manually. It
 * is visible in the Daisycon publisher console URL and account settings.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'DAISYCON_CLIENT_ID',
      label: 'Daisycon OAuth Client ID',
      type: 'text',
      description:
        'Your Daisycon OAuth Client ID. To create one:\n' +
        '  1. Sign in to the Daisycon publisher console at https://www.daisycon.com/.\n' +
        '  2. Open Settings → API / OAuth.\n' +
        '  3. Create a new OAuth client (you set the redirect URI yourself).\n' +
        '  4. Copy the value shown as "Client ID".\n' +
        'The Client ID and Secret together identify your integration when exchanging tokens.',
      example: 'abc123def456',
      validateOnEntry: (v) => validateCredential('DAISYCON_CLIENT_ID', v),
    },
    {
      field: 'DAISYCON_CLIENT_SECRET',
      label: 'Daisycon OAuth Client Secret',
      type: 'password',
      description:
        'Your Daisycon OAuth Client Secret, shown on the same page as the Client ID:\n' +
        '  Settings → API / OAuth → your OAuth client → "Client Secret".\n' +
        'Copy it without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('DAISYCON_CLIENT_SECRET', v),
    },
    {
      field: 'DAISYCON_REFRESH_TOKEN',
      label: 'Daisycon OAuth Refresh Token',
      type: 'password',
      description:
        'Your Daisycon OAuth refresh token. Daisycon issues this after a one-time\n' +
        'authorisation (authorization_code with PKCE). To obtain it:\n' +
        '  1. Run the Daisycon OAuth authorisation step (see docs/networks/daisycon.md\n' +
        '     — Daisycon provides a CLI in DaisyconBV/oauth-examples that writes a\n' +
        '     tokens.json containing the refresh token).\n' +
        '  2. Copy the "refresh_token" value.\n' +
        'This step validates the Client ID, Secret and Refresh Token together against\n' +
        'the Daisycon token endpoint. If validation fails, re-check all three values.',
      validateOnEntry: (v) => validateCredential('DAISYCON_REFRESH_TOKEN', v),
    },
    {
      field: 'DAISYCON_PUBLISHER_ID',
      label: 'Daisycon Publisher ID',
      type: 'text',
      description:
        'Your numeric Daisycon Publisher ID. You can find it in:\n' +
        '  - The Daisycon publisher console URL when logged in.\n' +
        '  - The "Account" or "Settings" page in the console.\n' +
        'This ID scopes all publisher API calls (/publishers/{id}/...) to your account.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('DAISYCON_PUBLISHER_ID', v),
    },
  ];
}
