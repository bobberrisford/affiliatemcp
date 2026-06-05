/**
 * Admitad advertiser setup steps.
 *
 * Three values: the OAuth2 application Client ID and Client Secret (self-
 * registered in the advertiser account), plus the numeric advertiser id that
 * Admitad uses in the /advertiser/{id}/... reporting paths. The wizard validates
 * the secret with a live token exchange once both credentials are in env.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'ADMITAD_ADVERTISER_CLIENT_ID',
      label: 'Admitad advertiser Client ID (OAuth2 app id)',
      type: 'text',
      description:
        'The Client ID of an API application registered in your Admitad ADVERTISER account.\n' +
        'Create one in your Admitad account, then click "Show credentials" to reveal the Client ID\n' +
        '(app id) and Client Secret (secret key). The application must have the advertiser_statistics,\n' +
        'advertiser_info and advertiser_websites scopes enabled.',
      validateOnEntry: (v) => validateCredential('ADMITAD_ADVERTISER_CLIENT_ID', v),
    },
    {
      field: 'ADMITAD_ADVERTISER_CLIENT_SECRET',
      label: 'Admitad advertiser Client Secret (OAuth2 secret key)',
      type: 'password',
      description:
        'The Client Secret (secret key) of the same Admitad API application. Treat it as a password.\n' +
        'On submit the wizard exchanges it for an OAuth2 access token via POST https://api.admitad.com/token/\n' +
        'to confirm the credentials and scopes work. This adapter only ever issues GET requests.',
      validateOnEntry: (v) => validateCredential('ADMITAD_ADVERTISER_CLIENT_SECRET', v),
    },
    {
      field: 'ADMITAD_ADVERTISER_ID',
      label: 'Admitad advertiser id',
      type: 'text',
      description:
        'Your numeric advertiser id. Admitad uses it in the advertiser API paths\n' +
        '(e.g. GET /advertiser/{id}/statistics/actions/). It scopes every reporting call.\n' +
        'It is the networkBrandId for the brand this credential set addresses; the wizard binds it\n' +
        'to a local brand slug in brands.json so advertiser tools can resolve it.',
      validateOnEntry: (v) => validateCredential('ADMITAD_ADVERTISER_ID', v),
    },
  ];
}
