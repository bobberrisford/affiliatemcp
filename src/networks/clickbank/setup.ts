/**
 * ClickBank setup steps.
 *
 * ClickBank needs three values written to `~/.affiliate-mcp/.env`:
 *   - CLICKBANK_DEV_KEY    — account-wide developer key.
 *   - CLICKBANK_CLERK_KEY  — per-user (clerk) API key.
 *   - CLICKBANK_NICKNAME   — the account login handle, used to build HopLinks
 *                            and to label the authenticated identity.
 *
 * Both keys are created on the same screen (Settings → API Management). The
 * developer key validates only once paired with the clerk key, so the wizard
 * may report the dev-key step as "will validate after the clerk key" until both
 * are present — see `validateCredential` in `auth.ts`.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'CLICKBANK_DEV_KEY',
      label: 'ClickBank developer API key',
      type: 'password',
      description:
        'Your account-wide ClickBank developer key:\n' +
        '  1. Sign in to ClickBank at https://accounts.clickbank.com/.\n' +
        '  2. Open Settings → "My Account" → API Management.\n' +
        '  3. Under "Developer API Keys" click "Create New Developer Key" and copy the value.\n' +
        'The developer key is shared across the account; the per-user clerk key is entered next.\n' +
        'Note: a key is only fully verified once both the developer key and the clerk key are set, ' +
        'so this step may re-check after the clerk key is entered.',
      example: 'DEV-XXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      validateOnEntry: (v) => validateCredential('CLICKBANK_DEV_KEY', v),
    },
    {
      field: 'CLICKBANK_CLERK_KEY',
      label: 'ClickBank clerk (API user) key',
      type: 'password',
      description:
        'Your per-user ClickBank clerk key:\n' +
        '  1. Still under Settings → API Management, find the "Clerk API Keys" section.\n' +
        '  2. Add a user (or select an existing one) and grant it API permissions.\n' +
        '  3. Copy that user\'s clerk key.\n' +
        'ClickBank authenticates with the developer key and the clerk key together, ' +
        'joined as "DEV-KEY:CLERK-KEY" in the Authorization header.',
      example: 'API-XXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      validateOnEntry: (v) => validateCredential('CLICKBANK_CLERK_KEY', v),
    },
    {
      field: 'CLICKBANK_NICKNAME',
      label: 'ClickBank account nickname',
      type: 'text',
      description:
        'Your ClickBank account nickname — the login handle you use to sign in (e.g. "myacct"). ' +
        'It is the affiliate identifier embedded in every HopLink ' +
        '(https://NICKNAME.VENDOR.hop.clickbank.net) and is shown in your ClickBank dashboard ' +
        'header after login. Used to build tracking links and to label your identity in diagnostics.',
      example: 'myacct',
      validateOnEntry: (v) => validateCredential('CLICKBANK_NICKNAME', v),
    },
  ];
}
