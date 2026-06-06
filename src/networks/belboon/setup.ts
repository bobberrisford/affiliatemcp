/**
 * Belboon setup steps.
 *
 * Belboon runs on the Ingenious Technologies platform; its publisher API is the
 * "export file" interface. Authentication is two values read from the dashboard
 * and baked into the export URL:
 *   - the Magic Key (Settings → API),
 *   - the numeric partner/user id (Account).
 *
 * Both are long-lived. There is no separate approval step for export access on
 * an active publisher account. The optional export-host override covers tenants
 * the Ingenious platform serves from a non-default subdomain.
 *
 * The descriptions are user-facing copy — they reference the literal dashboard
 * navigation a publisher sees. The exact labels are dashboard-gated and have
 * not been confirmed against a live account; the layout is described alongside.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'BELBOON_MAGIC_KEY',
    label: 'Belboon Magic Key',
    type: 'password',
    description:
      'Your Belboon API "Magic Key" (a UUID) authenticates every export request:\n' +
      '  1. Sign in at https://www.belboon.com/.\n' +
      '  2. Open Settings → API (some accounts show this under Tools → Webservices).\n' +
      '  3. Copy the Magic Key value.\n' +
      'The key is long-lived; if it is rotated you must update this value.',
    example: 'f0d58188-5420-4856-84b2-0417a3a85225',
    validateOnEntry: (v) => validateCredential('BELBOON_MAGIC_KEY', v),
  },
  {
    field: 'BELBOON_USER_ID',
    label: 'Belboon partner / user id',
    type: 'text',
    description:
      'Your numeric Belboon partner (user) id. It is baked into every export ' +
      'file name. Find it in the dashboard under Account, or read it from the ' +
      'numeric segment of an export download link (the part before the file ' +
      'extension, e.g. adm-conversionexport_123.csv → 123).',
    example: '123',
    validateOnEntry: (v) => validateCredential('BELBOON_USER_ID', v),
  },
  {
    field: 'BELBOON_EXPORT_HOST',
    label: 'Belboon export host (optional — only if your download links differ)',
    type: 'text',
    description:
      'Optional. Leave blank to use the default Belboon export host. Set this ' +
      'only if your export download links use a different host (the Ingenious ' +
      'platform serves some accounts from another subdomain). Enter the host ' +
      'shown in your own export download URLs.',
    example: 'export.net.belboon.com',
    validateOnEntry: (v) => validateCredential('BELBOON_EXPORT_HOST', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
