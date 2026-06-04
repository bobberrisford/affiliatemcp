/**
 * Eduzz setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Eduzz uses a token-exchange scheme. The publisher needs three values, all
 * found in the Eduzz panel under Ferramentas → API (or My Eduzz → Integrations
 * → API):
 *   - EDUZZ_EMAIL      — the account login email
 *   - EDUZZ_PUBLIC_KEY — the account PublicKey
 *   - EDUZZ_API_KEY    — the account APIKey
 *
 * The API key step performs a live token-exchange validation (it needs all
 * three values together) so the publisher learns immediately if the credentials
 * are wrong, rather than at first API use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'EDUZZ_EMAIL',
      label: 'Eduzz account email',
      type: 'text',
      description:
        'The email address you use to log in to Eduzz.\n' +
        'This is sent alongside your PublicKey and APIKey to the Eduzz token endpoint.',
      example: 'you@example.com',
      validateOnEntry: (v) => validateCredential('EDUZZ_EMAIL', v),
    },
    {
      field: 'EDUZZ_PUBLIC_KEY',
      label: 'Eduzz PublicKey',
      type: 'text',
      description:
        'Your Eduzz PublicKey. To find it:\n' +
        '  1. Log in to your Eduzz account.\n' +
        '  2. Open the panel menu and go to "Ferramentas" → "API"\n' +
        '     (or "My Eduzz" → "Integrações" → "API").\n' +
        '  3. Copy the value shown as "PublicKey".\n' +
        'The PublicKey and APIKey together are exchanged for a short-lived token.',
      example: 'kj23hkj2h3jk4h2k3j3j4234jk23',
      validateOnEntry: (v) => validateCredential('EDUZZ_PUBLIC_KEY', v),
    },
    {
      field: 'EDUZZ_API_KEY',
      label: 'Eduzz APIKey',
      type: 'password',
      description:
        'Your Eduzz APIKey. Find it on the same page as the PublicKey:\n' +
        '  Ferramentas → API → "APIKey".\n' +
        'This step validates the email, PublicKey and APIKey together against the\n' +
        'Eduzz token endpoint (https://api2.eduzz.com/credential/generate_token).\n' +
        'If validation fails, double-check all three values are copied without\n' +
        'leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('EDUZZ_API_KEY', v),
    },
  ];
}
