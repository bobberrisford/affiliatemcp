/**
 * Adservice setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Adservice authenticates with two cookie values obtained from the publisher
 * account via /Account.pl/loginToken:
 *   - ADSERVICE_UID         — the publisher/client ID
 *   - ADSERVICE_LOGIN_TOKEN — the login token
 * plus an optional human-readable identity label:
 *   - ADSERVICE_AFFILIATE_ID — the Affiliate ID shown in the Account section
 *
 * The LoginToken step performs a live Statistics.pl read so the publisher learns
 * immediately if the credentials are wrong, rather than at first API use.
 *
 * Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'ADSERVICE_UID',
      label: 'Adservice UID (publisher/client ID)',
      type: 'text',
      description:
        'Your Adservice UID — the publisher/client identifier sent as the `UID` cookie.\n' +
        'To find it:\n' +
        '  1. Log in to your Adservice publisher account at https://publisher.adservice.com/.\n' +
        '  2. Obtain your UID and LoginToken via the Account API (/Account.pl/loginToken),\n' +
        '     as described in the API documentation\n' +
        '     (https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html).\n' +
        'The UID and LoginToken together authenticate every API request as cookies.',
      example: '12345',
      validateOnEntry: (v) => validateCredential('ADSERVICE_UID', v),
    },
    {
      field: 'ADSERVICE_LOGIN_TOKEN',
      label: 'Adservice LoginToken',
      type: 'password',
      description:
        'Your Adservice LoginToken — obtained alongside the UID via /Account.pl/loginToken.\n' +
        'This step validates both the UID and LoginToken against the Adservice Statistics API\n' +
        'immediately after you enter the token. If validation fails, double-check both values\n' +
        'are copied without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('ADSERVICE_LOGIN_TOKEN', v),
    },
    {
      field: 'ADSERVICE_AFFILIATE_ID',
      label: 'Adservice Affiliate ID (optional)',
      type: 'text',
      description:
        'Optional. Your Adservice Affiliate ID, shown in the Account section of the publisher\n' +
        'dashboard. It is used only as a human-readable identity label in diagnostics; it is\n' +
        'not sent on API requests. Leave blank if you do not know it.',
      example: 'aff-67890',
      validateOnEntry: (v) => validateCredential('ADSERVICE_AFFILIATE_ID', v),
    },
  ];
}
