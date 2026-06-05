/**
 * Coupang Partners setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Coupang Partners uses HMAC-SHA256 request signing. The publisher self-issues
 * an Access Key + Secret Key pair from the Coupang Partners dashboard. The API
 * menu (오픈 API / Open API) is available once the account is approved and has
 * reached the minimum sales threshold Coupang requires to unlock the Open API.
 *
 *   - COUPANG_PARTNERS_ACCESS_KEY — the public half of the signing key pair.
 *   - COUPANG_PARTNERS_SECRET_KEY — the secret half; used to sign each request.
 *
 * The Secret Key step performs a live, signed validation call (a one-day
 * commission-report request) so the publisher learns immediately if the keys
 * are wrong rather than at first API use.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential, ACCESS_KEY_FIELD, SECRET_KEY_FIELD } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: ACCESS_KEY_FIELD,
      label: 'Coupang Partners Access Key',
      type: 'text',
      description:
        'Your Coupang Partners Open API Access Key. To find it:\n' +
        '  1. Sign in at https://partners.coupang.com/.\n' +
        '  2. Open the "도구" (Tools) menu in the top navigation.\n' +
        '  3. Select "오픈 API" (Open API).\n' +
        '  4. If you have not generated keys yet, click the button to issue an\n' +
        '     API key pair (발급). The Open API menu appears only after your\n' +
        '     account is approved and has met the minimum sales threshold.\n' +
        '  5. Copy the value shown as "Access Key".\n' +
        'The Access Key and Secret Key together sign every API request.',
      example: 'a1b2c3d4-0000-0000-0000-abcdef123456',
      validateOnEntry: (v) => validateCredential(ACCESS_KEY_FIELD, v),
    },
    {
      field: SECRET_KEY_FIELD,
      label: 'Coupang Partners Secret Key',
      type: 'password',
      description:
        'Your Coupang Partners Open API Secret Key. Find it on the same page as the\n' +
        'Access Key: 도구(Tools) → 오픈 API (Open API) → "Secret Key".\n' +
        'This step signs a live one-day commission-report request to validate both\n' +
        'keys against the Coupang API. If validation fails, double-check both values\n' +
        'are copied without leading or trailing spaces, and that they belong to the\n' +
        'same account.',
      validateOnEntry: (v) => validateCredential(SECRET_KEY_FIELD, v),
    },
  ];
}
