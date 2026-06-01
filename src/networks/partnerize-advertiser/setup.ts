/**
 * Partnerize (Advertiser) — setup steps.
 *
 * Two credentials are required, both found on the same page in the Partnerize
 * dashboard. The wizard prompts for the Application Key first (format-validated
 * locally), then the User API Key (live-validated against the campaigns endpoint
 * if the Application Key is already set).
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'PARTNERIZE_APPLICATION_KEY',
      label: 'Partnerize Application Key',
      type: 'text',
      description:
        'The Application Key that identifies which Partnerize network your account belongs to.\n' +
        'Find it at: Partnerize dashboard → Settings → API Credentials → Application Key.\n' +
        'This key identifies the network (not the individual user), so all users in the same\n' +
        'network share the same Application Key.',
      example: 'a1b2c3d4e5f6...',
      validateOnEntry: (v) => validateCredential('PARTNERIZE_APPLICATION_KEY', v),
    },
    {
      field: 'PARTNERIZE_USER_API_KEY',
      label: 'Partnerize User API Key',
      type: 'password',
      description:
        'The User API Key that authenticates you personally against the Partnerize API.\n' +
        'Find it at: Partnerize dashboard → Settings → API Credentials → User API Key.\n' +
        'This key is per-user; each account holder has their own. Keep it confidential.\n' +
        'This adapter only issues GET requests; it will never modify campaign data.',
      validateOnEntry: (v) => validateCredential('PARTNERIZE_USER_API_KEY', v),
    },
  ];
}
