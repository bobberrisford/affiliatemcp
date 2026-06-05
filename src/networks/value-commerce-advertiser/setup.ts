/**
 * ValueCommerce advertiser (EC / merchant) setup steps.
 *
 * Defines the prompts the wizard shows during `affiliate-networks-mcp setup`.
 *
 * ValueCommerce uses a self-issued report API authentication key pair:
 *   - VALUE_COMMERCE_ADVERTISER_CLIENT_KEY    — from Settings → Report API auth key
 *   - VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET — from the same page
 *
 * The secret step performs a live token-acquisition validation so the advertiser
 * learns immediately if the key pair is wrong, rather than at first API use.
 *
 * To issue the key pair: advertiser management console → 広告 (Ads) → 対応機能別 →
 * Web service (Webサービス), agree to the terms and issue the key. The values then
 * appear under Settings (設定) → Report API auth key (レポートAPI認証キーの取得).
 * Only the contract owner or a sub-contract owner can issue the key.
 *   Source: https://help.valuecommerce.ne.jp/aff/tool/api/02/
 */

import type { SetupStep } from '../../shared/types.js';
import { validateCredential } from './auth.js';

export function setupSteps(): SetupStep[] {
  return [
    {
      field: 'VALUE_COMMERCE_ADVERTISER_CLIENT_KEY',
      label: 'ValueCommerce advertiser CLIENT_KEY (report API auth key)',
      type: 'text',
      description:
        'Your ValueCommerce advertiser report API authentication key (CLIENT_KEY). To find it:\n' +
        '  1. Log in to the ValueCommerce advertiser management console.\n' +
        '  2. Open Ads (広告) → 対応機能別 → Web service (Webサービス).\n' +
        '  3. On first use, agree to the terms and issue the API authentication key.\n' +
        '  4. Open Settings (設定) → Report API auth key (レポートAPI認証キーの取得).\n' +
        '  5. Copy the value shown as CLIENT_KEY.\n' +
        'The CLIENT_KEY and CLIENT_SECRET together are Base64-encoded to obtain a\n' +
        'bearer token for API calls. Only the contract owner or a sub-contract owner\n' +
        'can issue the key.',
      example: 'vc_adv_client_key_example',
      validateOnEntry: (v) => validateCredential('VALUE_COMMERCE_ADVERTISER_CLIENT_KEY', v),
    },
    {
      field: 'VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET',
      label: 'ValueCommerce advertiser CLIENT_SECRET (report API auth key)',
      type: 'password',
      description:
        'Your ValueCommerce advertiser report API authentication secret (CLIENT_SECRET).\n' +
        'Find it on the same page as the CLIENT_KEY:\n' +
        '  Settings (設定) → Report API auth key (レポートAPI認証キーの取得).\n' +
        'This step validates both the CLIENT_KEY and CLIENT_SECRET against the\n' +
        'ValueCommerce advertiser token endpoint. If validation fails, double-check\n' +
        'both values are copied without leading or trailing spaces.',
      validateOnEntry: (v) => validateCredential('VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET', v),
    },
  ];
}
