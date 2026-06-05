/**
 * Scaleo setup steps.
 *
 * Scaleo is a tenant affiliate-platform engine: every Scaleo-powered network
 * runs the same API at its own per-tenant host. Two credentials are therefore
 * required, and the base URL is entered first because validating the API key
 * needs it:
 *
 *   1. SCALEO_BASE_URL — the network's tracking URL (the API host).
 *   2. SCALEO_API_KEY  — the affiliate API key.
 *
 * API access is gated by the platform administrator: the affiliate cannot
 * self-issue a key. The administrator enables the API Access switcher on the
 * affiliate's profile, after which the key is shown under Account → API.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'SCALEO_BASE_URL',
    label: 'Scaleo tracking URL',
    type: 'text',
    description:
      'Your network\'s Scaleo tracking URL. Each Scaleo-powered network runs on its own ' +
      'domain, so this is part of your credentials rather than a fixed value.\n' +
      '  - As an affiliate: open any offer, go to the Tracking section and generate an ' +
      'affiliate tracking link (e.g. https://yournetwork.scaletrk.com/click?o=1&a=1). ' +
      'The scheme + host portion (https://yournetwork.scaletrk.com) is your tracking URL.\n' +
      '  - If you are an administrator: Settings → General → Domain for Tracking.\n' +
      'Enter only the scheme and host, with no path.',
    example: 'https://yournetwork.scaletrk.com',
    validateOnEntry: (v) => validateCredential('SCALEO_BASE_URL', v),
  },
  {
    field: 'SCALEO_API_KEY',
    label: 'Scaleo affiliate API key',
    type: 'password',
    description:
      'Your Scaleo affiliate API key. API access is enabled by your network administrator:\n' +
      '  1. Ask the administrator to open your affiliate profile edit page and turn on the ' +
      'API Access switcher, then save.\n' +
      '  2. The API key is then shown under Account → API (or User Settings, top-right) for ' +
      'your account.\n' +
      '  3. Copy the key and paste it here.\n' +
      'Note: the key is long-lived and is sent as the api-key query parameter on every request.',
    example: '9876672da43110d164412e30a66fed87ac633d5c',
    validateOnEntry: (v) => validateCredential('SCALEO_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
