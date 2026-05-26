/**
 * Awin advertiser setup steps.
 *
 * One credential: the OAuth bearer token. Awin's token is user-scoped, so the
 * same token a user might already have configured for the publisher Awin
 * adapter (`AWIN_API_TOKEN`) usually works for the advertiser surface too —
 * provided the underlying Awin sign-in is linked to one or more advertiser
 * accounts.
 *
 * If the publisher token is set, surface its value in the prompt description
 * as a "you can reuse this" suggestion. We do NOT auto-copy: same pattern as
 * the CJ adapter (see `src/networks/cj-advertiser/setup.ts`). Explicit
 * confirmation keeps the wizard's behaviour predictable and lets the operator
 * choose per-surface separation if they prefer.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, getPublisherToken } from './auth.js';

export function setupSteps(): SetupStep[] {
  // Build the description dynamically so the reuse suggestion reflects the
  // current process.env state at wizard time.
  const existingPublisherToken = getPublisherToken();
  const reuseSuggestion = existingPublisherToken
    ? '\n\nYou already have an Awin publisher token configured under AWIN_API_TOKEN. Awin tokens\n' +
      'are user-scoped — the same token usually works for the advertiser surface as long as\n' +
      'your Awin sign-in is linked to at least one advertiser account. You can reuse that\n' +
      'value here if you prefer a single token, or paste a different one if you want\n' +
      'per-surface separation. We do NOT auto-copy: surfacing the existing value lets you\n' +
      'confirm intent explicitly.'
    : '';

  return [
    {
      field: 'AWIN_ADVERTISER_API_TOKEN',
      label: 'Awin advertiser OAuth token',
      type: 'password',
      description:
        'Generate an OAuth token in the Awin dashboard:\n' +
        '  1. Sign in at https://ui.awin.com/ (advertiser portal) or https://members.awin.com/\n' +
        '     (publisher portal — same sign-in, same token).\n' +
        '  2. Open Toolbox → API Credentials.\n' +
        '  3. Click Generate Token (or rotate an existing one if you have lost the value).\n' +
        '  4. Copy the token value shown; Awin will not display it again.\n' +
        'The token is long-lived and user-scoped. The adapter is READ-ONLY: the HTTP client\n' +
        'refuses any non-GET method. Awin enforces a 20-calls-per-minute rate limit per user;\n' +
        'the client queues bursty operations rather than failing fast.\n' +
        'Awin\'s advertiser API is gated to the Accelerate and Advanced plans — brands on the\n' +
        'Entry-tier plan appear in your account list but return 401/403 on data endpoints.\n' +
        'On submit the wizard runs GET /accounts to verify the token and count addressable\n' +
        'advertiser accounts.' +
        reuseSuggestion,
      validateOnEntry: (v) => validateCredential('AWIN_ADVERTISER_API_TOKEN', v),
    },
  ];
}
