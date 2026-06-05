/**
 * Hotmart setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Hotmart uses 2-legged OAuth2 client-credentials. The user needs two values
 * (a third is optional):
 *   - HOTMART_CLIENT_ID     — from Hotmart → Tools → Developer Tools
 *   - HOTMART_CLIENT_SECRET — from the same page
 *   - HOTMART_BASIC_TOKEN   — OPTIONAL precomputed base64(client_id:client_secret),
 *                             also shown on that page; the adapter derives it
 *                             when omitted.
 *
 * The client secret step performs a live token-exchange validation so the user
 * learns immediately if the credentials are wrong, rather than at first API use.
 *
 * Why we cannot auto-derive anything: Hotmart's 2-legged OAuth returns only a
 * token; there is no account identity to derive into a second credential. The
 * user supplies the id and secret; the optional Basic token is computed locally.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'HOTMART_CLIENT_ID',
      label: 'Hotmart Client ID',
      type: 'text',
      description:
        'Your Hotmart API Client ID. To find it:\n' +
        '  1. Log in at https://app.hotmart.com/.\n' +
        '  2. Open the "Tools" menu.\n' +
        '  3. Select "Developer Tools" (Credentials / Hotmart API).\n' +
        '  4. Create or open a set of credentials.\n' +
        '  5. Copy the value shown as "Client ID".\n' +
        'The Client ID and Secret together obtain a bearer token for API calls.',
      example: 'a1b2c3d4-0000-0000-0000-000000000000',
      validateOnEntry: (v) => validateCredential('HOTMART_CLIENT_ID', v),
    },
    {
      field: 'HOTMART_CLIENT_SECRET',
      label: 'Hotmart Client Secret',
      type: 'password',
      description:
        'Your Hotmart API Client Secret. Find it on the same page as the Client ID:\n' +
        '  Tools → Developer Tools → your credentials → "Client Secret".\n' +
        'This step validates both the Client ID and Secret against the Hotmart\n' +
        'OAuth2 token endpoint. If validation fails, double-check both values are\n' +
        'copied without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('HOTMART_CLIENT_SECRET', v),
    },
    {
      field: 'HOTMART_BASIC_TOKEN',
      label: 'Hotmart Basic token (optional)',
      type: 'password',
      description:
        'OPTIONAL. The precomputed "Basic" token shown on the Developer Tools page.\n' +
        'It is exactly base64(Client ID:Client Secret), which the adapter computes\n' +
        'for you — so you can safely leave this blank. Only set it if you prefer to\n' +
        'paste the value Hotmart displays rather than the raw Client ID and Secret.',
      example: 'YTFiMmMzZDQ6c2VjcmV0',
      validateOnEntry: (v) => validateCredential('HOTMART_BASIC_TOKEN', v),
    },
  ];
}
