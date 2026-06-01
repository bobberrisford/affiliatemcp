/**
 * Skimlinks setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Skimlinks uses OAuth2 client-credentials. The publisher needs three values:
 *   - SKIMLINKS_CLIENT_ID     — from Skimlinks Hub → Toolbox → API → API Auth Credentials
 *   - SKIMLINKS_CLIENT_SECRET — from the same page
 *   - SKIMLINKS_PUBLISHER_ID  — the numeric publisher ID, visible in the Hub dashboard
 *
 * The client secret step performs a live token-exchange validation so the
 * publisher learns immediately if the credentials are wrong, rather than at
 * first API use.
 *
 * Why we cannot auto-derive SKIMLINKS_PUBLISHER_ID: Skimlinks does not expose
 * a /me-style endpoint that returns the publisher ID from an access token. The
 * publisher must supply it manually. It is prominently visible in the Skimlinks
 * Hub URL (e.g. https://hub.skimlinks.com/publisher/123456/dashboard).
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'SKIMLINKS_CLIENT_ID',
      label: 'Skimlinks API Client ID',
      type: 'text',
      description:
        'Your Skimlinks API Client ID. To find it:\n' +
        '  1. Log in at https://hub.skimlinks.com/.\n' +
        '  2. Click "Toolbox" in the top navigation.\n' +
        '  3. Select "API" from the dropdown.\n' +
        '  4. Open the "API Authentication Credentials" tab.\n' +
        '  5. Copy the value shown as "Client ID".\n' +
        'The Client ID and Secret together are used to obtain a bearer token for API calls.',
      example: 'abc123def456',
      validateOnEntry: (v) => validateCredential('SKIMLINKS_CLIENT_ID', v),
    },
    {
      field: 'SKIMLINKS_CLIENT_SECRET',
      label: 'Skimlinks API Client Secret',
      type: 'password',
      description:
        'Your Skimlinks API Client Secret. Find it on the same page as the Client ID:\n' +
        '  Toolbox → API → API Authentication Credentials → "Client Secret".\n' +
        'This step will validate both the Client ID and Secret against the Skimlinks\n' +
        'OAuth2 token endpoint. If validation fails, double-check both values are\n' +
        'copied without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('SKIMLINKS_CLIENT_SECRET', v),
    },
    {
      field: 'SKIMLINKS_PUBLISHER_ID',
      label: 'Skimlinks Publisher ID',
      type: 'text',
      description:
        'Your numeric Skimlinks Publisher ID. You can find it in:\n' +
        '  - The Skimlinks Hub URL when logged in (e.g. /publisher/123456/dashboard).\n' +
        '  - The "Account" or "Settings" page in the Skimlinks Hub.\n' +
        '  - The API Authentication Credentials page under "Publisher ID".\n' +
        'This ID is required for all Reporting API calls to scope results to your account.',
      example: '123456',
      validateOnEntry: (v) => validateCredential('SKIMLINKS_PUBLISHER_ID', v),
    },
    {
      field: 'SKIMLINKS_DOMAIN_ID',
      label: 'Skimlinks Domain ID',
      type: 'text',
      description:
        'Your numeric Skimlinks Domain ID — the number AFTER the X in your Site ID.\n' +
        'To find it:\n' +
        '  1. Log in at https://hub.skimlinks.com/.\n' +
        '  2. Go to Settings → Sites.\n' +
        '  3. Your Site ID shows in the format "{PublisherID}X{DomainID}"\n' +
        '     e.g. "123456X789012" — the Domain ID is "789012".\n' +
        'This ID is used in tracking deeplinks (go.skimresources.com/?id={PublisherID}X{DomainID}).',
      example: '789012',
      validateOnEntry: (v) => validateCredential('SKIMLINKS_DOMAIN_ID', v),
    },
  ];
}
