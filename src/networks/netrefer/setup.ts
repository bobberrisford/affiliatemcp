/**
 * NetRefer ASR setup steps.
 *
 * The wizard (`src/cli/setup.ts`) consumes these to prompt the user. Step
 * descriptions are user-facing — keep them factual and reference what NetRefer
 * issues at onboarding so a person unfamiliar with the portal can complete
 * setup.
 *
 * Five credentials are required:
 *   - NETREFER_BASE_URL      (per-operator ASR host — a credential, not fixed)
 *   - NETREFER_CLIENT_ID
 *   - NETREFER_CLIENT_SECRET
 *   - NETREFER_USERNAME
 *   - NETREFER_PASSWORD
 *
 * The four OAuth fields are issued together at ASR onboarding; the base URL is
 * the per-operator host the affiliate is told to call. None can be auto-derived
 * — `verifyAuth()` returns `derivedValues: {}`.
 *
 * Approval friction: ASR access is provisioned per affiliate during NetRefer
 * onboarding. We surface that in the first step so the user knows the
 * credentials may not yet exist on their account.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export const SETUP_STEPS: SetupStep[] = [
  {
    field: 'NETREFER_BASE_URL',
    label: 'NetRefer ASR base URL',
    type: 'text',
    example: 'https://asr.operator.netrefer.com',
    description:
      'The per-operator ASR (Affiliate Standard Reporting) host you call for reports. ' +
      'NetRefer issues this to you at ASR onboarding — it is specific to the operator whose ' +
      'programme you are reporting on, not a single shared host. Enter the full base URL ' +
      'including the https:// scheme.',
    validateOnEntry: (v) => validateCredential('NETREFER_BASE_URL', v),
  },
  {
    field: 'NETREFER_CLIENT_ID',
    label: 'NetRefer OAuth2 Client ID',
    type: 'text',
    description:
      'Your ASR OAuth2 client ID. To obtain it:\n' +
      '  1. Request ASR access from your NetRefer operator / account manager.\n' +
      '  2. NetRefer provisions an ASR credential set during onboarding (client ID, client ' +
      'secret, username, and password). Provisioning is manual; ask your operator for the ' +
      'expected turnaround.\n' +
      '  3. The Client ID is one of the four values returned with that credential set.',
    validateOnEntry: (v) => validateCredential('NETREFER_CLIENT_ID', v),
  },
  {
    field: 'NETREFER_CLIENT_SECRET',
    label: 'NetRefer OAuth2 Client Secret',
    type: 'password',
    description:
      'Paired with the Client ID above, issued in the same ASR onboarding credential set. ' +
      'If you have lost it, request a new credential set from your NetRefer operator.',
    validateOnEntry: (v) => validateCredential('NETREFER_CLIENT_SECRET', v),
  },
  {
    field: 'NETREFER_USERNAME',
    label: 'NetRefer ASR username',
    type: 'text',
    description:
      'The username issued with your ASR credential set. The ASR token endpoint uses the ' +
      'OAuth2 resource-owner password grant, so a username and password accompany the ' +
      'client ID and secret.',
    validateOnEntry: (v) => validateCredential('NETREFER_USERNAME', v),
  },
  {
    field: 'NETREFER_PASSWORD',
    label: 'NetRefer ASR password',
    type: 'password',
    description:
      'The password issued with your ASR credential set, paired with the username above. ' +
      'Stored locally in ~/.affiliate-mcp/.env and sent only to the NetRefer / Microsoft ' +
      'Entra token endpoint.',
    validateOnEntry: (v) => validateCredential('NETREFER_PASSWORD', v),
  },
];

export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
