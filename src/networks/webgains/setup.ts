/**
 * Webgains setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Webgains uses an OAuth2 Personal Access Token. The publisher needs:
 *   - WEBGAINS_API_KEY      — the Personal Access Token (bearer secret).
 *   - WEBGAINS_PUBLISHER_ID — the numeric publisher account ID.
 *   - WEBGAINS_CAMPAIGN_ID  — the publisher campaign (Site) ID, used only for
 *       generateTrackingLink (the wgcampaignid deeplink parameter).
 *
 * The API-key step performs a live Get Publisher call (once the Publisher ID is
 * known) so the publisher learns immediately if the token is wrong.
 *
 * BLOCKED(verify): the precise in-dashboard navigation to generate a Personal
 * Access Token could not be confirmed (the Webgains documentation host returned
 * HTTP 403 from the build environment). The wording below points to the account
 * / developer settings area of the Smart Publisher Platform and should be
 * verified against the live dashboard before promotion beyond `experimental`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'WEBGAINS_API_KEY',
      label: 'Webgains API Key (Personal Access Token)',
      type: 'password',
      description:
        'Your Webgains Smart Platform API Personal Access Token. To generate it:\n' +
        '  1. Log in to the Webgains Smart Publisher Platform at https://platform.webgains.io/.\n' +
        '  2. Open your account / developer settings (the API or "Personal Access\n' +
        '     Tokens" section).\n' +
        '  3. Generate a new Personal Access Token and copy it.\n' +
        'The token is sent as a bearer credential on every API request. Treat it as a\n' +
        'secret; anyone holding it can read your account data.',
      validateOnEntry: (v) => validateCredential('WEBGAINS_API_KEY', v),
    },
    {
      field: 'WEBGAINS_PUBLISHER_ID',
      label: 'Webgains Publisher ID',
      type: 'text',
      description:
        'Your numeric Webgains publisher account ID. You can find it in the Smart\n' +
        'Publisher Platform under your account settings (it also appears in the\n' +
        'platform URL). This ID scopes reporting and programme calls to your account.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('WEBGAINS_PUBLISHER_ID', v),
    },
    {
      field: 'WEBGAINS_CAMPAIGN_ID',
      label: 'Webgains Campaign (Site) ID',
      type: 'text',
      description:
        'Your numeric Webgains campaign (Site) ID. This is used ONLY to build tracking\n' +
        'deeplinks (the mandatory wgcampaignid parameter). Find it in the Smart\n' +
        'Publisher Platform under your site/campaign settings, or read it from an\n' +
        'existing tracking link (the wgcampaignid value in\n' +
        'https://track.webgains.com/click.html?wgcampaignid=...).',
      example: '789012',
      validateOnEntry: (v) => validateCredential('WEBGAINS_CAMPAIGN_ID', v),
    },
  ];
}
