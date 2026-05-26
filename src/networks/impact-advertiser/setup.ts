/**
 * Impact advertiser setup steps.
 *
 * Two credentials, same dashboard page on Impact's side. The wizard explains
 * the agency vs brand-direct distinction upfront so the operator knows what
 * to paste.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'IMPACT_ADVERTISER_ACCOUNT_SID',
      label: 'Impact advertiser Account SID',
      type: 'text',
      description:
        'Your Impact Account SID. Two tiers are supported and the adapter auto-detects which you provide:\n' +
        '  - AGENCY tier (preferred for agencies): paste the AGENCY SID. One credential addresses every\n' +
        '    brand in your portfolio; brands are discovered via GET /Agencies/{SID}/Advertisers.\n' +
        '  - BRAND-DIRECT tier: paste the ADVERTISER SID. One credential, one brand.\n' +
        'Find it at: Impact dashboard → Settings → API → "Account SID and Auth Token". The agency\n' +
        'portal and the brand portal each show their own SID on this screen.',
      validateOnEntry: (v) => validateCredential('IMPACT_ADVERTISER_ACCOUNT_SID', v),
    },
    {
      field: 'IMPACT_ADVERTISER_AUTH_TOKEN',
      label: 'Impact advertiser Auth Token (Basic-auth password)',
      type: 'password',
      description:
        'Your Impact Auth Token. STRONGLY RECOMMENDED: create a READ-ONLY token at\n' +
        '  Impact dashboard → Settings → API → API Tokens → create token, role = "Read-only".\n' +
        'This adapter only ever issues GET requests; the client refuses any other method. Pairing\n' +
        'a read-only token with the client-side guard gives you defence in depth — even if a\n' +
        'future PR accidentally introduces a write call, Impact will reject it server-side.\n' +
        'On submit the wizard probes GET /Agencies/{SID} to auto-detect agency vs brand-direct.',
      validateOnEntry: (v) => validateCredential('IMPACT_ADVERTISER_AUTH_TOKEN', v),
    },
  ];
}
