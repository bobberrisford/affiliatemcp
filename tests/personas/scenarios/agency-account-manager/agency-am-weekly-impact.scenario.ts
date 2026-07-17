/**
 * Agency account manager — weekly performance report for one brand on Impact.
 *
 * Stands in for the `programme-performance-report` skill (weekly profile). It
 * exercises the richest advertiser path: brand resolution → advisory strategy
 * load → per-publisher performance for the current and comparison windows,
 * with `networkBrandId` threaded from brands.json down to the adapter.
 *
 * What it proves: both windows are fetched (not one), rows carry a real
 * currency and commission (no zero-fill), and the recorded plan is read before
 * the verdict — the difference between "no crash" and "the deliverable the AM
 * ships is actually built on correct data".
 */

import { _resetCredentialCache } from '../../../../src/networks/impact-advertiser/auth.js';
import type { AssertionFinding, PersonaScenario, StepResult } from '../../harness/index.js';
import { noZeroFillFindings } from '../../harness/index.js';

const CURRENT = { from: '2026-05-01', to: '2026-05-22' };
const COMPARISON = { from: '2026-04-09', to: '2026-04-30' };

function bothWindowsFetched(results: StepResult[]): AssertionFinding[] {
  const findings: AssertionFinding[] = [];
  const perf = results.filter((r) => r.tool?.endsWith('_get_programme_performance'));
  if (perf.length !== 2) {
    findings.push({
      step: 'programme-performance-report (journey)',
      message: `expected two get_programme_performance calls (current + comparison), got ${perf.length}`,
    });
  }
  for (const call of perf) {
    if (call.outcome !== 'ok' || !Array.isArray(call.result) || call.result.length === 0) {
      findings.push({ step: call.label, message: 'expected a non-empty ProgrammePerformanceRow[]' });
      continue;
    }
    findings.push(...noZeroFillFindings(call.label, call.result, ['grossSale', 'commission']));
  }
  return findings;
}

export const scenario: PersonaScenario = {
  id: 'agency-am-weekly-impact',
  persona: 'agency-account-manager',
  title: 'Agency AM builds a weekly Impact performance report for Acme',
  entitlementTier: 'pro',
  env: {
    IMPACT_ADVERTISER_ACCOUNT_SID: 'IRA-AGENCY-1',
    IMPACT_ADVERTISER_AUTH_TOKEN: 'persona-fake-token',
  },
  brands: {
    version: 1,
    brands: {
      acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1001' }],
    },
  },
  strategy: [
    {
      brand: 'acme',
      strategyMarkdown:
        '# Acme strategy\n\nGrow approved revenue quarter on quarter. Prefer premium content ' +
        'partners; deprioritise incentive and coupon partners. Report weekly to the client in a ' +
        'plain, matter-of-fact voice. Escalate any drop over 20% week on week immediately.\n',
    },
  ],
  resets: [_resetCredentialCache],
  fetch: {
    mode: 'router',
    routes: [
      {
        match: 'Reports/adv_performance_by_media',
        respond: { fixture: 'impact-advertiser/performance-report-sync.json' },
      },
      // Credential shape-detection probe (agency-tier token).
      { match: '/Agencies/IRA-AGENCY-1', respond: { json: { Id: 'IRA-AGENCY-1' } } },
    ],
  },
  steps: [
    {
      kind: 'tool',
      tool: 'affiliate_resolve_brand',
      args: { network: 'impact-advertiser' },
      expect: {
        outcome: 'ok',
        shape: { arrayMinLength: 1 },
        assert: (result) => {
          const rows = result as Array<{ brand: string; networkBrandId: string }>;
          const acme = rows.find((r) => r.brand === 'acme');
          if (!acme) return [{ step: 'affiliate_resolve_brand', message: 'acme binding not returned' }];
          if (acme.networkBrandId !== 'IA-1001')
            return [{ step: 'affiliate_resolve_brand', message: `expected networkBrandId IA-1001, got ${acme.networkBrandId}` }];
          return [];
        },
      },
    },
    {
      kind: 'tool',
      tool: 'affiliate_get_client_strategy',
      args: { brand: 'acme' },
      expect: {
        outcome: 'ok',
        shape: { requiredKeys: ['brand', 'strategy', 'kpi'] },
        assert: (result) => {
          const r = result as { strategy: { present: boolean } };
          return r.strategy.present
            ? []
            : [{ step: 'affiliate_get_client_strategy', message: 'expected recorded strategy to be present' }];
        },
      },
    },
    {
      kind: 'skill',
      skill: 'programme-performance-report',
      calls: [
        {
          kind: 'tool',
          tool: 'affiliate_impact-advertiser_get_programme_performance',
          args: { brand: 'acme', ...CURRENT },
          expect: {
            outcome: 'ok',
            shape: { arrayMinLength: 1, everyItemHasKeys: ['publisherId', 'commission', 'currency', 'status'] },
          },
        },
        {
          kind: 'tool',
          tool: 'affiliate_impact-advertiser_get_programme_performance',
          args: { brand: 'acme', ...COMPARISON },
          expect: {
            outcome: 'ok',
            shape: { arrayMinLength: 1, everyItemHasKeys: ['publisherId', 'commission', 'currency', 'status'] },
          },
        },
      ],
      journey: bothWindowsFetched,
    },
  ],
};
