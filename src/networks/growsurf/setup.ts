/**
 * GrowSurf setup steps. Two credentials: the API key (bearer token) and the
 * campaign id (the programme the key acts against — GrowSurf is campaign-scoped).
 * Reference: `src/networks/rewardful/setup.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'GROWSURF_API_KEY',
      label: 'GrowSurf API key',
      type: 'password',
      description:
        'Find or generate your API key in GrowSurf:\n' +
        '  1. Log in to your GrowSurf account.\n' +
        '  2. Open Settings (the gear icon).\n' +
        '  3. Open the Account tab, then the API section.\n' +
        '  4. Generate a new API key or copy an existing one.\n' +
        'It is sent as a bearer token (Authorization: Bearer <key>) on every request. ' +
        'Keep it secret — it grants full access to your GrowSurf data.',
      validateOnEntry: (v) => validateCredential('GROWSURF_API_KEY', v),
    },
    {
      field: 'GROWSURF_CAMPAIGN_ID',
      label: 'GrowSurf campaign (programme) id',
      type: 'text',
      description:
        'Find your campaign id in the GrowSurf dashboard:\n' +
        '  1. Open the campaign (programme) you want to manage.\n' +
        '  2. Read the id from the dashboard URL — it is the segment after /campaign/ ' +
        '(for example, 4pdlhb in .../campaign/4pdlhb).\n' +
        'GrowSurf is campaign-scoped: this id is part of every data request.',
      example: '4pdlhb',
      validateOnEntry: (v) => validateCredential('GROWSURF_CAMPAIGN_ID', v),
    },
  ];
}
