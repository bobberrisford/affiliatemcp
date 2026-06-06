/**
 * TUNE (HasOffers) setup steps.
 *
 * TUNE is a multi-tenant CPA engine: many networks each run their own HasOffers
 * instance. A single set of affiliate credentials therefore needs two values:
 *
 *   1. TUNE_NETWORK_ID — the network identifier. The API host is built from it
 *      as https://{network_id}.api.hasoffers.com. It is a CREDENTIAL, not a
 *      fixed constant, because each network's host is different.
 *
 *   2. TUNE_API_KEY — the affiliate API key from the publisher dashboard.
 *
 * Order matters: the NetworkId is entered first because validating the API key
 * requires a live call against that network's host.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'TUNE_NETWORK_ID',
    label: 'TUNE network identifier',
    type: 'text',
    description:
      'TUNE (HasOffers) runs a separate instance per network, so your API host is ' +
      'specific to your network. Find your NetworkId in the publisher dashboard:\n' +
      '  1. Sign in to your network\'s TUNE/HasOffers affiliate dashboard.\n' +
      '  2. Open the API section (often labelled "API" or "API access" under your ' +
      'account/profile menu).\n' +
      '  3. Copy the NetworkId shown alongside your API key.\n' +
      'Enter the bare identifier only, e.g. "atollsnet". The host is built as ' +
      'https://{network_id}.api.hasoffers.com.',
    example: 'atollsnet',
    validateOnEntry: (v) => validateCredential('TUNE_NETWORK_ID', v),
  },
  {
    field: 'TUNE_API_KEY',
    label: 'TUNE affiliate API key',
    type: 'password',
    description:
      'Your TUNE affiliate API key authenticates you against your network\'s host:\n' +
      '  1. In the same API section of the affiliate dashboard, locate your API key.\n' +
      '  2. Copy the key (generate one if the dashboard offers the option).\n' +
      '  3. Paste it here. It is validated by listing one offer from your network.',
    example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    validateOnEntry: (v) => validateCredential('TUNE_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
