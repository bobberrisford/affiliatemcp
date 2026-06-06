/**
 * CAKE setup steps.
 *
 * CAKE is a per-instance affiliate platform: each network runs on its own host.
 * The affiliate therefore supplies three values, all visible in the affiliate
 * portal once logged in:
 *
 *   1. CAKE_BASE_URL     — the instance host (the domain you log in to).
 *   2. CAKE_API_KEY      — the Affiliate API Key.
 *   3. CAKE_AFFILIATE_ID — the numeric Affiliate ID.
 *
 * Navigation: log in to the affiliate portal, then click "Reporting API" in the
 * top-right. That panel shows both the Affiliate ID and the API Key. The base
 * URL is simply the host of the portal you logged in to.
 *
 * The base URL and affiliate id are prompted before the key so that the key's
 * `validateOnEntry` can run a live OfferFeed probe against the instance.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'CAKE_BASE_URL',
    label: 'CAKE instance host',
    type: 'text',
    description:
      'Your CAKE instance host. CAKE is a per-instance platform: each network ' +
      'has its own host.\n' +
      '  1. Open the affiliate portal you log in to.\n' +
      '  2. Copy the host from the address bar, including the scheme.\n' +
      'Enter the host only (no path), e.g. https://your-network.cakemarketing.com.',
    example: 'https://your-network.cakemarketing.com',
    validateOnEntry: (v) => validateCredential('CAKE_BASE_URL', v),
  },
  {
    field: 'CAKE_AFFILIATE_ID',
    label: 'CAKE Affiliate ID',
    type: 'text',
    description:
      'Your numeric CAKE Affiliate ID.\n' +
      '  1. Log in to the affiliate portal.\n' +
      '  2. Click "Reporting API" in the top-right.\n' +
      '  3. Copy the Affiliate ID shown in that panel.',
    example: '12345',
    validateOnEntry: (v) => validateCredential('CAKE_AFFILIATE_ID', v),
  },
  {
    field: 'CAKE_API_KEY',
    label: 'CAKE Affiliate API Key',
    type: 'password',
    description:
      'Your CAKE Affiliate API Key.\n' +
      '  1. Log in to the affiliate portal.\n' +
      '  2. Click "Reporting API" in the top-right.\n' +
      '  3. Copy the API Key shown alongside your Affiliate ID.\n' +
      'The key is passed to CAKE as the api_key query parameter and is scoped to ' +
      'your affiliate account.',
    example: 'rYwtD48irQ0CiHRiuaB9abASO3e8O7GS',
    validateOnEntry: (v) => validateCredential('CAKE_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
