/**
 * Affise setup steps.
 *
 * Affise is a multi-tenant CPA engine: many networks each run their own Affise
 * instance. A single set of credentials therefore needs two values:
 *
 *   1. AFFISE_BASE_URL — the network's own API host. This is the tracking
 *      domain shown in the partner panel under Settings → Tracking domains,
 *      e.g. https://api-yournetwork.affise.com. It is a CREDENTIAL, not a fixed
 *      constant, because each network's host is different.
 *
 *   2. AFFISE_API_KEY — the affiliate-panel API key, found under
 *      Settings → Security.
 *
 * Order matters: the base URL is entered first because validating the API key
 * requires a live call against that host.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'AFFISE_BASE_URL',
    label: 'Affise tracking-domain base URL',
    type: 'text',
    description:
      'Affise runs a separate instance per network, so the API host is specific to ' +
      'your network. Find it in your Affise partner panel:\n' +
      '  1. Sign in to your network\'s Affise partner panel.\n' +
      '  2. Open Settings → Tracking domains.\n' +
      '  3. Copy the tracking domain (the API responds on the same host).\n' +
      'Enter the full origin including the scheme, e.g. https://api-yournetwork.affise.com.',
    example: 'https://api-yournetwork.affise.com',
    validateOnEntry: (v) => validateCredential('AFFISE_BASE_URL', v),
  },
  {
    field: 'AFFISE_API_KEY',
    label: 'Affise affiliate API key',
    type: 'password',
    description:
      'Your Affise affiliate API key authenticates you against your network\'s host:\n' +
      '  1. In the same Affise partner panel, open Settings → Security.\n' +
      '  2. Copy the API key shown there (generate one if the panel offers the option).\n' +
      '  3. Paste it here. It is validated by listing one offer from your network.',
    example: '4sdf87fsdfd8723lkjhrn324',
    validateOnEntry: (v) => validateCredential('AFFISE_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
