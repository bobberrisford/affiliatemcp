/**
 * Lomadee setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * Lomadee uses a `custom` auth model. The publisher needs five values:
 *   - LOMADEE_APP_TOKEN       — affiliate panel → Credenciais de API → Gerar Token
 *   - LOMADEE_SOURCE_ID       — the sourceId for the publisher channel
 *   - LOMADEE_PUBLISHER_ID    — the numeric publisher ID (needed by the report API)
 *   - LOMADEE_REPORT_USER     — the account e-mail (mints the report token)
 *   - LOMADEE_REPORT_PASSWORD — the account password (mints the report token)
 *
 * The source-ID step performs a live deeplink probe so the publisher learns
 * immediately if the app-token / sourceId pair is wrong. The report-password
 * step performs a live createToken probe for the same reason.
 *
 * Why two credential families: the offers and deeplink APIs authenticate with
 * the app-token + sourceId, but the "Consulte suas vendas" sales-report API
 * authenticates with a token minted from the account e-mail and password. Both
 * are needed for the full operation set.
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'LOMADEE_APP_TOKEN',
      label: 'Lomadee app-token',
      type: 'password',
      description:
        'Your Lomadee app-token. To create it:\n' +
        '  1. Sign in at https://developer.lomadee.com/ (or the affiliate panel).\n' +
        '  2. Open your user menu and select "Credenciais de API".\n' +
        '  3. Click "Gerar Token".\n' +
        '  4. Copy the generated token.\n' +
        'Note: Lomadee may take up to 3 days to release API access on a new account.\n' +
        'The app-token authenticates the offers and deeplink APIs.',
      example: '1234567890abcdef1234567890abcdef',
      validateOnEntry: (v) => validateCredential('LOMADEE_APP_TOKEN', v),
    },
    {
      field: 'LOMADEE_SOURCE_ID',
      label: 'Lomadee source ID',
      type: 'text',
      description:
        'Your Lomadee sourceId — the identifier of the publisher channel that\n' +
        'links and offers are attributed to. Find or generate it in the Lomadee\n' +
        'affiliate panel. This step validates the app-token and sourceId together\n' +
        'against the Lomadee deeplink endpoint.',
      example: '12345678',
      validateOnEntry: (v) => validateCredential('LOMADEE_SOURCE_ID', v),
    },
    {
      field: 'LOMADEE_PUBLISHER_ID',
      label: 'Lomadee publisher ID',
      type: 'text',
      description:
        'Your numeric Lomadee publisher ID. It is required by the sales-report API\n' +
        '(reportTransaction). Find it in the Lomadee affiliate panel under your\n' +
        'account details.',
      example: '654321',
      validateOnEntry: (v) => validateCredential('LOMADEE_PUBLISHER_ID', v),
    },
    {
      field: 'LOMADEE_REPORT_USER',
      label: 'Lomadee account e-mail (for reports)',
      type: 'text',
      description:
        'The e-mail address you use to sign in to Lomadee/SocialSoul. The sales-\n' +
        'report API mints a report token from your e-mail and password via the\n' +
        'createToken endpoint.',
      example: 'you@example.com',
      validateOnEntry: (v) => validateCredential('LOMADEE_REPORT_USER', v),
    },
    {
      field: 'LOMADEE_REPORT_PASSWORD',
      label: 'Lomadee account password (for reports)',
      type: 'password',
      description:
        'The password you use to sign in to Lomadee/SocialSoul. This step validates\n' +
        'the report e-mail and password together against the Lomadee createToken\n' +
        'endpoint. It is used only to mint the report token; it is not sent on any\n' +
        'other API call.',
      validateOnEntry: (v) => validateCredential('LOMADEE_REPORT_PASSWORD', v),
    },
  ];
}
