/**
 * TradeTracker setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-mcp setup`. The wizard consumes the step list and each step's
 * optional `validateOnEntry` (which calls `validateCredential` in `auth.ts`).
 *
 * TradeTracker has no auto-derivable credential: the customer ID, passphrase,
 * and affiliate site ID are all read from the dashboard, so each is a prompt.
 * The descriptions reference the exact dashboard navigation so a person who has
 * never used the TradeTracker API can complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'TRADETRACKER_CUSTOMER_ID',
      label: 'TradeTracker Customer ID',
      type: 'text',
      example: '123456',
      description:
        'Your TradeTracker customer ID. To find it:\n' +
        '  1. Sign in to the TradeTracker affiliate dashboard.\n' +
        '  2. Open Account → Web Services.\n' +
        '  3. The customer ID is shown alongside the API passphrase.',
      validateOnEntry: (v) => validateCredential('TRADETRACKER_CUSTOMER_ID', v),
    },
    {
      field: 'TRADETRACKER_PASSPHRASE',
      label: 'TradeTracker API Passphrase',
      type: 'password',
      description:
        'Your TradeTracker API passphrase, on the same Account → Web Services screen ' +
        'as the customer ID. It can be regenerated there if compromised. The passphrase ' +
        'is used to open a SOAP session; it is not a long-lived bearer token.',
      validateOnEntry: (v) => validateCredential('TRADETRACKER_PASSPHRASE', v),
    },
    {
      field: 'TRADETRACKER_SITE_ID',
      label: 'TradeTracker Affiliate Site ID',
      type: 'text',
      example: '654321',
      description:
        'The numeric affiliate site ID most affiliate calls require (campaigns, ' +
        'transactions, clicks). Find it in the TradeTracker dashboard under Affiliate ' +
        'Sites — each registered site has its own ID. If you run several sites, use the ' +
        'one whose reporting you want this server to read.',
      validateOnEntry: (v) => validateCredential('TRADETRACKER_SITE_ID', v),
    },
  ];
}
