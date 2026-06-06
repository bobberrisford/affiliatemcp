/**
 * Post Affiliate Pro setup steps. Two credentials: the per-account API base URL
 * and the Bearer API key. Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'POST_AFFILIATE_PRO_BASE_URL',
      label: 'Post Affiliate Pro API base URL',
      type: 'text',
      example: 'https://demo.postaffiliatepro.com/api/v3',
      description:
        'Post Affiliate Pro is hosted per account, so the API lives on your own subdomain:\n' +
        '  1. Note the subdomain you log in to, e.g. `acme` in https://acme.postaffiliatepro.com.\n' +
        '  2. The API base URL is that subdomain followed by /api/v3, e.g.\n' +
        '     https://acme.postaffiliatepro.com/api/v3.\n' +
        'Enter the full URL including the scheme and the /api/v3 path.',
      validateOnEntry: (v) => validateCredential('POST_AFFILIATE_PRO_BASE_URL', v),
    },
    {
      field: 'POST_AFFILIATE_PRO_API_KEY',
      label: 'Post Affiliate Pro API key',
      type: 'password',
      description:
        'Create an API key in Post Affiliate Pro:\n' +
        '  1. Log in to the merchant panel.\n' +
        '  2. Open Configuration > Tools > Integration.\n' +
        '  3. Open the API v3 (REST API) section and create or copy an API key.\n' +
        'It is sent as a Bearer token in the Authorization header on every request. ' +
        'Keep it secret — it grants access to your Post Affiliate Pro data.',
      validateOnEntry: (v) => validateCredential('POST_AFFILIATE_PRO_API_KEY', v),
    },
  ];
}
