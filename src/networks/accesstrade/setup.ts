/**
 * AccessTrade setup steps.
 *
 * AccessTrade publishers authenticate with an access key copied from their
 * profile page, plus a site (website) ID that scopes the campaign and product
 * feed endpoints. Both are prompted; neither can be derived from the other, so
 * there is no `derivedValues` flow.
 *
 * The access key is validated against a site-scoped endpoint, so the site id is
 * prompted FIRST. Order matters: `validateCredential('ACCESSTRADE_ACCESS_KEY')`
 * returns a hint if the site id is not yet present.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so the step list stays a small,
 * side-effect-free module.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'ACCESSTRADE_SITE_ID',
    label: 'AccessTrade site ID',
    type: 'text',
    example: 'abc123',
    description:
      'The ID of one of your registered websites (sites):\n' +
      '  1. Log in to the AccessTrade publisher dashboard for your country.\n' +
      '  2. Open the "Websites" (sites) section.\n' +
      '  3. Copy the ID of the site you want to report on.\n' +
      'Campaign and product-feed endpoints are scoped to a single site; the conversion ' +
      'report covers the whole account.',
    validateOnEntry: (v) => validateCredential('ACCESSTRADE_SITE_ID', v),
  },
  {
    field: 'ACCESSTRADE_ACCESS_KEY',
    label: 'AccessTrade access key',
    type: 'password',
    description:
      'Your publisher API access key:\n' +
      '  1. Log in to the AccessTrade publisher dashboard.\n' +
      '  2. Open your profile page (your account / profile settings).\n' +
      '  3. Copy the API access key shown there.\n' +
      'The key is long-lived but can be regenerated from the same page, which revokes the old one. ' +
      'It is sent on every request as the "Authorization: Token <access_key>" header.\n' +
      'Note: enter the site ID above first — the key is validated against a site-scoped endpoint.',
    validateOnEntry: (v) => validateCredential('ACCESSTRADE_ACCESS_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
