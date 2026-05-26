/**
 * CJ advertiser setup steps.
 *
 * One credential: the Personal Access Token. CJ uses the same PAT for both
 * publisher and advertiser surfaces, so if the user has already configured
 * the publisher adapter (`CJ_API_TOKEN`) we surface that value in the prompt
 * description as a "paste this if you already have it" suggestion — we do NOT
 * auto-copy. Letting the user explicitly confirm or paste a different token
 * keeps the wizard's behaviour predictable.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';
import { getCredential } from '../../shared/config.js';

export function setupSteps(): SetupStep[] {
  // Build the description dynamically so the existing publisher PAT suggestion
  // reflects current process.env state at wizard time. This is a `() => string`
  // pattern used elsewhere in the codebase; here we just inline the call.
  const existingPublisherPat = getCredential('CJ_API_TOKEN');
  const reuseSuggestion = existingPublisherPat
    ? '\n\nYou already have a CJ publisher PAT configured under CJ_API_TOKEN. The same PAT works\n' +
      'for the advertiser surface — you can reuse that value here if your CJ account has\n' +
      'both publisher and advertiser relationships. We do NOT auto-copy: surfacing the\n' +
      'existing value lets you confirm intent or paste a different token if you prefer\n' +
      'per-surface separation.'
    : '';

  return [
    {
      field: 'CJ_ADVERTISER_API_TOKEN',
      label: 'CJ Personal Access Token (advertiser surface)',
      type: 'password',
      description:
        'Generate a Personal Access Token (PAT) in the CJ dashboard:\n' +
        '  1. Log in at https://members.cj.com/ (or the advertiser portal if you primarily\n' +
        '     manage a brand).\n' +
        '  2. Open the "Account" menu (top-right user avatar) → click "Account".\n' +
        '  3. Open the "Personal Access Tokens" tab in the sidebar.\n' +
        '  4. Click "Create Token" (or "Generate New Token" — label varies by tenant).\n' +
        '  5. Copy the value shown; CJ does not show it again.\n' +
        'The token is long-lived. The PAT addresses every CID the underlying user has been\n' +
        'granted on CJ\'s side — CJ enforces permission at query time. This adapter is\n' +
        'READ-ONLY: the GraphQL client refuses any operation that is not `query`.' +
        reuseSuggestion,
      validateOnEntry: (v) => validateCredential('CJ_ADVERTISER_API_TOKEN', v),
    },
  ];
}
