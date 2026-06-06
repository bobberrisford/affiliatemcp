/**
 * AvantLink setup steps.
 *
 * AvantLink authenticates by query parameter and scopes reports per website, so
 * the wizard prompts for three values: the affiliate ID, the API key
 * (`auth_key`), and the website ID. None can be derived from another — every
 * authenticated module needs all three — so there is no `derivedValues` flow.
 *
 * The API key is the only secret; the two IDs are public numeric identifiers.
 * The IDs are format-validated locally; the API key is checked live via the
 * AssociationFeed module once the IDs are present.
 *
 * Why this file is separate from `adapter.ts`: the wizard imports the steps
 * statically without instantiating the adapter, so the step list must be a
 * small, side-effect-free module. Treat the descriptions as user-facing copy
 * and reference the exact dashboard labels.
 *
 * Docs: https://support.avantlink.com/hc/en-us/articles/360004058972-Where-can-I-find-my-ID-
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'AVANTLINK_AFFILIATE_ID',
    label: 'AvantLink affiliate ID',
    type: 'text',
    example: '123456',
    description:
      'Your numeric AvantLink affiliate ID.\n' +
      '  1. Log in at https://classic.avantlink.com/.\n' +
      '  2. Open Account → API.\n' +
      '  3. Copy the "Affiliate ID" shown at the top of the page.',
    validateOnEntry: (v) => validateCredential('AVANTLINK_AFFILIATE_ID', v),
  },
  {
    field: 'AVANTLINK_WEBSITE_ID',
    label: 'AvantLink website ID',
    type: 'text',
    example: '789012',
    description:
      'The numeric ID of the registered website you report on. AvantLink scopes ' +
      'reports and tracking links per website.\n' +
      '  1. Open Account → Websites.\n' +
      '  2. Copy the "Website ID" shown beside the site you want to use.',
    validateOnEntry: (v) => validateCredential('AVANTLINK_WEBSITE_ID', v),
  },
  {
    field: 'AVANTLINK_API_KEY',
    label: 'AvantLink API key (auth_key)',
    type: 'password',
    description:
      'Your 32-character AvantLink API key, used as the auth_key query parameter.\n' +
      '  1. Open Account → API.\n' +
      '  2. Copy the "API Key" (a 32-character mixed alphanumeric string). Use ' +
      '"Regenerate" there if you need a fresh one.\n' +
      'The key is long-lived; it does not auto-expire but can be regenerated.',
    validateOnEntry: (v) => validateCredential('AVANTLINK_API_KEY', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
