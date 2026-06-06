/**
 * ShopMy setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-mcp setup shopmy`.
 * ShopMy issues a single brand partner token; the optional brand-name label is
 * purely cosmetic (used in the identity string) and never sent to the API.
 *
 * Reference: src/networks/awin/setup.ts.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'SHOPMY_API_TOKEN',
    label: 'ShopMy brand partner API token',
    type: 'password',
    description:
      'Generate a brand partner API token from the ShopMy brand dashboard:\n' +
      '  1. Sign in to your ShopMy brand account.\n' +
      '  2. Open the brand settings and find the API or integrations section.\n' +
      '  3. Generate (or copy) your brand partner token and paste it here.\n' +
      'The token is long-lived and scoped to your brand. If you do not see an API ' +
      'section, contact your ShopMy partner manager to enable brand partner API access.',
    validateOnEntry: (v) => validateCredential('SHOPMY_API_TOKEN', v),
  },
  {
    field: 'SHOPMY_BRAND_NAME',
    label: 'ShopMy brand name (optional display label)',
    type: 'text',
    example: 'Acme',
    description:
      'An optional label for your brand, used only to make the identity line readable ' +
      'in diagnostics. It is never sent to ShopMy. Leave blank to skip.',
    validateOnEntry: (v) => validateCredential('SHOPMY_BRAND_NAME', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
