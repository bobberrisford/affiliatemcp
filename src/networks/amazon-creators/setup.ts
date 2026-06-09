/**
 * Amazon Creators API setup steps.
 *
 * The Creators API (successor to PA-API 5.0) authenticates with OAuth 2.0
 * client-credentials issued from Associates Central. The user enters:
 *   - the Credential ID + Credential Secret (the OAuth2 client pair),
 *   - their Associates partner tag,
 *   - their marketplace storefront domain.
 *
 * Access to the Creators API is gated: Amazon requires a qualifying number of
 * referred sales in the trailing 30 days before issuing credentials. The first
 * step's description flags this so a user without API access learns about it
 * before the wizard fails to validate.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'AMAZON_CREATORS_CLIENT_ID',
    label: 'Amazon Creators Credential ID',
    type: 'text',
    example: 'amzn1.application-oa2-client.xxxxxxxx',
    description:
      'Generate Creators API credentials in Amazon Associates Central:\n' +
      '  1. Sign in at https://affiliate-program.amazon.com/.\n' +
      '  2. Open Tools → Creators API (or visit /creatorsapi).\n' +
      '  3. Under Applications, click "Create App", name it, then "Add New Credential".\n' +
      '  4. Copy the Credential ID.\n' +
      'Note: Amazon gates Creators API access behind recent qualifying sales, so the ' +
      'credential section may be unavailable on a brand-new Associates account.',
    validateOnEntry: (v) => validateCredential('AMAZON_CREATORS_CLIENT_ID', v),
  },
  {
    field: 'AMAZON_CREATORS_CLIENT_SECRET',
    label: 'Amazon Creators Credential Secret',
    type: 'password',
    description:
      'The Credential Secret shown once when you add a new credential in Associates Central → ' +
      'Creators API → Applications. It is displayed only at creation time; if you did not copy ' +
      'it, delete the credential and add a new one.',
    validateOnEntry: (v) => validateCredential('AMAZON_CREATORS_CLIENT_SECRET', v),
  },
  {
    field: 'AMAZON_PARTNER_TAG',
    label: 'Amazon Associates partner tag',
    type: 'text',
    example: 'yoursite-20',
    description:
      'Your Associates store/tracking ID. Find it in Associates Central → Account Settings → ' +
      'Manage Your Tracking IDs. Most tags end in a country suffix such as "-20" (US) or "-21" (UK).',
    validateOnEntry: (v) => validateCredential('AMAZON_PARTNER_TAG', v),
  },
  {
    field: 'AMAZON_MARKETPLACE',
    label: 'Amazon marketplace domain',
    type: 'text',
    example: 'www.amazon.com',
    description:
      'The storefront domain for your Associates marketplace, e.g. "www.amazon.com" (US), ' +
      '"www.amazon.co.uk" (UK), "www.amazon.de" (DE). This selects the marketplace via the ' +
      'x-marketplace header and determines which OAuth token region is used. Defaults to ' +
      'www.amazon.com if left blank.',
    validateOnEntry: (v) => validateCredential('AMAZON_MARKETPLACE', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
