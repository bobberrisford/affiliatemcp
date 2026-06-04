/**
 * Monetizze setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Monetizze uses a single API access key (a "chave de acesso"). The publisher
 * needs one value:
 *   - MONETIZZE_API_KEY — created in the Monetizze panel via Menu > Ferramentas > API
 *
 * The key step performs a live token-exchange validation so the publisher learns
 * immediately if the key is wrong, rather than at first API use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'MONETIZZE_API_KEY',
      label: 'Monetizze API access key',
      type: 'password',
      description:
        'Your Monetizze API access key (chave de acesso). To create it:\n' +
        '  1. Log in to the Monetizze panel at https://app.monetizze.com.br/.\n' +
        '  2. Open the "Menu" (top navigation).\n' +
        '  3. Go to "Ferramentas" (Tools).\n' +
        '  4. Select "API".\n' +
        '  5. Create a new access key and copy the value shown.\n' +
        'This step validates the key against the Monetizze token endpoint. If it\n' +
        'fails, double-check the value is copied without leading or trailing spaces.',
      example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      validateOnEntry: (v) => validateCredential('MONETIZZE_API_KEY', v),
    },
  ];
}
