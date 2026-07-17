/**
 * Semi-technical operator — first-run health check.
 *
 * Stands in for `affiliate-network-status`: the operator who has just wired the
 * server up and asks "is my setup working?". It proves the discovery + honest-
 * failure surface: `list_networks` enumerates registered adapters, a scoped
 * `run_diagnostic` returns one honest result per network (here every call fails
 * auth because the key is a placeholder), and `verify_auth` returns a clean
 * `{ ok: false }` rather than throwing or faking success.
 */

import type { PersonaScenario } from '../../harness/index.js';

export const scenario: PersonaScenario = {
  id: 'operator-first-run-health-check',
  persona: 'semi-technical-operator',
  title: 'Operator checks whether the freshly-configured setup is working',
  entitlementTier: 'free',
  env: {
    AWIN_API_TOKEN: 'persona-fake-awin',
    AWIN_PUBLISHER_ID: '123456',
  },
  // Nothing is genuinely authenticated on a first run: every outbound call 401s.
  fetch: { mode: 'status', status: 401, body: '{"error":"invalid_token"}' },
  steps: [
    {
      kind: 'tool',
      tool: 'affiliate_list_networks',
      args: {},
      expect: {
        outcome: 'ok',
        shape: { arrayMinLength: 1, everyItemHasKeys: ['slug', 'name', 'claimStatus'] },
        assert: (result) => {
          const rows = result as Array<{ slug: string }>;
          return rows.some((r) => r.slug === 'awin')
            ? []
            : [{ step: 'affiliate_list_networks', message: 'expected awin to be a registered network' }];
        },
      },
    },
    {
      kind: 'tool',
      tool: 'affiliate_run_diagnostic',
      args: { network: 'awin' },
      expect: {
        outcome: 'ok',
        shape: { requiredKeys: ['generatedAt', 'results'] },
        assert: (result) => {
          const r = result as { results: Array<{ network: string }> };
          if (!Array.isArray(r.results) || r.results.length === 0)
            return [{ step: 'affiliate_run_diagnostic', message: 'expected at least one diagnostic result' }];
          return r.results[0]?.network === 'awin'
            ? []
            : [{ step: 'affiliate_run_diagnostic', message: `expected first result for awin, got ${r.results[0]?.network}` }];
        },
      },
    },
    {
      kind: 'tool',
      tool: 'affiliate_awin_verify_auth',
      args: {},
      // verifyAuth returns a structured result, it does not throw on bad creds.
      expect: {
        outcome: 'ok',
        assert: (result) => {
          const r = result as { ok: boolean };
          return r.ok === false
            ? []
            : [{ step: 'affiliate_awin_verify_auth', message: 'expected verify_auth to report ok:false for a placeholder key' }];
        },
      },
    },
  ],
};
