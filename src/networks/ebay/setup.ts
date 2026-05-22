/**
 * eBay Partner Network setup steps.
 *
 * Three credentials, prompted in order:
 *   1. EBAY_CLIENT_ID     — App ID (Client ID) from the developer portal.
 *   2. EBAY_CLIENT_SECRET — Cert ID (Client Secret) from the developer portal.
 *   3. EBAY_CAMPAIGN_ID   — numeric campaign ID from the EPN dashboard.
 *
 * The first two are an OAuth2 pair: validating the client ID alone is
 * insufficient because eBay's token endpoint requires both. We follow the
 * Rakuten precedent of "format-validate the id, defer live validation until
 * the secret is entered, then exercise the full exchange at the secret step".
 *
 * EPN gates production API access behind a one-time enrolment review. The
 * first step's description mentions the typical 1-3 day wait so a user with
 * a fresh developer account learns about it before the wizard fails to
 * validate.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EBAY_CLIENT_ID',
      label: 'eBay App ID (Client ID)',
      type: 'password',
      description:
        'Generate a Production application key set in the eBay developer portal:\n' +
        '  1. Sign in at https://developer.ebay.com/.\n' +
        '  2. Open My Account → Application Keys.\n' +
        '  3. If you have no Production keys yet, click "Create a keyset" → Production.\n' +
        '  4. Copy the "App ID (Client ID)" value.\n' +
        'Your application must be enrolled in the Partner Network — enrolment typically takes 1-3 ' +
        'working days and is the same process as joining EPN itself at https://partnernetwork.ebay.com/.',
      validateOnEntry: (v) => validateCredential('EBAY_CLIENT_ID', v),
    },
    {
      field: 'EBAY_CLIENT_SECRET',
      label: 'eBay Cert ID (Client Secret)',
      type: 'password',
      description:
        'On the same Application Keys page, copy the "Cert ID (Client Secret)" value from the ' +
        'Production key set. The secret is paired with the App ID you entered in the previous step; ' +
        'both must come from the same key set. eBay validates the pair by issuing a short-lived ' +
        'OAuth2 access token — the wizard performs that exchange to confirm the credentials work.',
      validateOnEntry: (v) => validateCredential('EBAY_CLIENT_SECRET', v),
    },
    {
      field: 'EBAY_CAMPAIGN_ID',
      label: 'eBay Partner Network Campaign ID',
      type: 'text',
      example: '5338000000',
      description:
        'Find your numeric campaign ID at https://partnernetwork.ebay.com/ → Campaigns.\n' +
        'It is the value in the "Campaign ID" column; not the campaign name. EPN tracking links ' +
        'require this value (it becomes the `campid` query parameter on every Smart Link the adapter ' +
        'constructs). If you have multiple campaigns, pick the one this client should attribute clicks to.',
      validateOnEntry: (v) => validateCredential('EBAY_CAMPAIGN_ID', v),
    },
  ];
}
