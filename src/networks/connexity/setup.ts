/**
 * Connexity setup steps.
 *
 * Defines the prompts the wizard (`src/cli/setup.ts`) shows during
 * `affiliate-mcp setup`. The wizard consumes the step list and each step's
 * optional `validateOnEntry` (which calls `validateCredential` in `auth.ts`).
 *
 * Connexity requires two credentials, both read from the publisher portal:
 *   - CONNEXITY_PUBLISHER_ID — the numeric publisher ID.
 *   - CONNEXITY_API_KEY — the API key used alongside the publisher ID on every
 *     request.
 *
 * Both are entered manually; neither can be derived from the other, so there is
 * no `derivedValues` flow here. The publisher ID is prompted first because the
 * API key validation needs it to make a live call.
 *
 * The descriptions reference verbatim portal navigation so a person who has
 * never used Connexity can still complete setup.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'CONNEXITY_PUBLISHER_ID',
    label: 'Connexity publisher ID',
    type: 'text',
    example: '725846',
    description:
      'Your numeric Connexity publisher ID:\n' +
      '  1. Log in to the Connexity publisher portal at https://publisher.connexity.com/.\n' +
      '  2. Open Account → API Access.\n' +
      '  3. Copy the "Publisher ID" value shown on that screen.',
    validateOnEntry: (v) => validateCredential('CONNEXITY_PUBLISHER_ID', v),
  },
  {
    field: 'CONNEXITY_API_KEY',
    label: 'Connexity API key',
    type: 'password',
    description:
      'Your Connexity API key, used together with the publisher ID on every request:\n' +
      '  1. On the same Account → API Access screen in the publisher portal.\n' +
      '  2. Copy the "API Key" value (or click "Generate API Key" if none exists).\n' +
      'The key is long-lived and can be regenerated from the same screen.',
    validateOnEntry: (v) => validateCredential('CONNEXITY_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
