/**
 * Webgains advertiser setup steps.
 *
 * Defines the prompts the wizard shows during
 * `affiliate-networks-mcp setup webgains-advertiser`.
 *
 * Webgains uses an OAuth2 Personal Access Token. The advertiser needs:
 *   - WEBGAINS_ADVERTISER_API_KEY     — the Personal Access Token (bearer secret).
 *   - WEBGAINS_ADVERTISER_ACCOUNT_ID  — the numeric advertiser account ID.
 *
 * The API-key step performs a live Get Programs call (once the Account ID is
 * known) so the advertiser learns immediately if the token is wrong.
 *
 * BLOCKED(verify): the precise in-dashboard navigation to generate a Personal
 * Access Token could not be confirmed (the Webgains documentation host returned
 * HTTP 403 to automated fetch). The wording below points to the account /
 * developer (API) settings area of the advertiser dashboard and should be
 * verified against the live dashboard before promotion beyond `experimental`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'WEBGAINS_ADVERTISER_API_KEY',
      label: 'Webgains advertiser API Key (Personal Access Token)',
      type: 'password',
      description:
        'Your Webgains Smart Platform API Personal Access Token. To generate it:\n' +
        '  1. Log in to the Webgains advertiser dashboard.\n' +
        '  2. Open your account / developer settings (the API or "Personal Access\n' +
        '     Tokens" section).\n' +
        '  3. Generate a new Personal Access Token and copy it. Prefer a read-only\n' +
        '     token where the dashboard offers one — this adapter only ever issues\n' +
        '     GET requests and the client refuses any other method.\n' +
        'The token is sent as a bearer credential on every API request. Treat it as a\n' +
        'secret; anyone holding it can read your account data.',
      validateOnEntry: (v) => validateCredential('WEBGAINS_ADVERTISER_API_KEY', v),
    },
    {
      field: 'WEBGAINS_ADVERTISER_ACCOUNT_ID',
      label: 'Webgains advertiser Account ID',
      type: 'text',
      description:
        'Your numeric Webgains advertiser account ID. You can find it in the advertiser\n' +
        'dashboard under your account settings (it also appears in the platform URL).\n' +
        'This ID scopes reporting and programme calls to your advertiser account.',
      example: '654321',
      validateOnEntry: (v) => validateCredential('WEBGAINS_ADVERTISER_ACCOUNT_ID', v),
    },
  ];
}
