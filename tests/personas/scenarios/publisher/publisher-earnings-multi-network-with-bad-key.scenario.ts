/**
 * Publisher — consolidated earnings across two networks, one with a revoked key.
 *
 * Stands in for `affiliate-earnings-report` where the publisher has Awin and CJ
 * configured but the Awin token has been revoked. It proves partial-failure
 * honesty: the dead network surfaces a clean `auth_error` envelope carrying the
 * verbatim upstream body (Principle 4.1), and the healthy network still returns
 * its real summary — the consolidated report must not sink on one failure, and
 * must never fabricate the missing figure.
 */

import type { PersonaScenario } from '../../harness/index.js';

const REVOKED_BODY = '{"error":"invalid_token","detail":"token rejected by upstream"}';
const WINDOW = { from: '2026-04-01', to: '2026-04-30' };

export const scenario: PersonaScenario = {
  id: 'publisher-earnings-multi-network-with-bad-key',
  persona: 'publisher',
  title: 'Publisher pulls earnings across Awin (revoked key) and CJ (healthy)',
  entitlementTier: 'solo',
  env: {
    AWIN_API_TOKEN: 'persona-fake-awin',
    AWIN_PUBLISHER_ID: '123456',
    CJ_API_TOKEN: 'persona-fake-cj',
    CJ_COMPANY_ID: '1234567',
  },
  steps: [
    {
      kind: 'tool',
      tool: 'affiliate_awin_get_earnings_summary',
      args: WINDOW,
      // Revoked key: every Awin call returns 401.
      fetch: { mode: 'status', status: 401, body: REVOKED_BODY },
      expect: {
        outcome: 'error',
        errorType: 'auth_error',
        network: 'awin',
        envelopeIncludesBody: 'invalid_token',
      },
    },
    {
      kind: 'tool',
      tool: 'affiliate_cj_get_earnings_summary',
      args: WINDOW,
      fetch: {
        mode: 'router',
        routes: [{ match: 'commissions.api.cj.com', respond: { fixture: 'cj/commissions.json' } }],
      },
      expect: {
        outcome: 'ok',
        shape: { requiredKeys: ['network', 'totalEarnings', 'byStatus', 'periodFrom', 'periodTo'] },
        assert: (result) => {
          const r = result as { network: string };
          return r.network === 'cj'
            ? []
            : [{ step: 'affiliate_cj_get_earnings_summary', message: `expected network "cj", got "${r.network}"` }];
        },
      },
    },
  ],
};
