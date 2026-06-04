/**
 * Admitad setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Admitad uses OAuth2 client_credentials. The publisher needs three values:
 *   - ADMITAD_CLIENT_ID     — the API application's app id ("Show credentials")
 *   - ADMITAD_CLIENT_SECRET — the API application's secret key (same page)
 *   - ADMITAD_WEBSITE_ID    — the numeric ad space (website) id, used for deeplinks
 *
 * The client secret step performs a live token-exchange validation so the
 * publisher learns immediately if the credentials are wrong, rather than at
 * first API use.
 *
 * Why we cannot auto-derive ADMITAD_WEBSITE_ID: a single account can have several
 * ad spaces (websites), each with its own id, and the deeplink generator is
 * scoped to one ad space. The publisher must choose and supply it.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'ADMITAD_CLIENT_ID',
      label: 'Admitad API Client ID',
      type: 'text',
      description:
        'Your Admitad API application Client ID (app id). To get it:\n' +
        '  1. Log in to your Admitad account.\n' +
        '  2. Open the API applications / advertising settings section and register a\n' +
        '     new API application (self-serve; no approval needed).\n' +
        '  3. Grant the application the scopes: statistics, advcampaigns,\n' +
        '     deeplink_generator, private_data.\n' +
        '  4. Click "Show credentials" and copy the value shown as the Client ID (app id).\n' +
        'The Client ID and Secret together obtain a bearer token for API calls.',
      example: 'cb281d918a37e346b45e9aea1c6eb7',
      validateOnEntry: (v) => validateCredential('ADMITAD_CLIENT_ID', v),
    },
    {
      field: 'ADMITAD_CLIENT_SECRET',
      label: 'Admitad API Client Secret',
      type: 'password',
      description:
        'Your Admitad API application Client Secret (secret key). Find it on the same\n' +
        '"Show credentials" panel as the Client ID.\n' +
        'This step validates both the Client ID and Secret against the Admitad OAuth2\n' +
        'token endpoint. If validation fails, double-check both values are copied\n' +
        'without leading or trailing spaces, and that the application has the required\n' +
        'scopes enabled.',
      validateOnEntry: (v) => validateCredential('ADMITAD_CLIENT_SECRET', v),
    },
    {
      field: 'ADMITAD_WEBSITE_ID',
      label: 'Admitad Website (ad space) ID',
      type: 'text',
      description:
        'Your numeric Admitad ad space (website) ID. To find it:\n' +
        '  1. Log in to your Admitad account.\n' +
        '  2. Open your ad spaces (websites) list.\n' +
        '  3. Copy the numeric ID of the ad space you want to attribute traffic to.\n' +
        'This ID is required for deeplink generation\n' +
        '(GET /deeplink/{website_id}/advcampaign/{campaign_id}/).',
      example: '123456',
      validateOnEntry: (v) => validateCredential('ADMITAD_WEBSITE_ID', v),
    },
  ];
}
