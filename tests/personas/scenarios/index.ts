/**
 * The registered persona scenarios. Adding a scenario file means importing it
 * here; `personas.test.ts` and `scripts/persona-run.ts` both drive this list,
 * so a scenario is validated and reported the moment it is registered.
 */

import type { PersonaScenario } from '../harness/index.js';
import { scenario as agencyAmWeeklyImpact } from './agency-account-manager/agency-am-weekly-impact.scenario.js';
import { scenario as publisherEarningsBadKey } from './publisher/publisher-earnings-multi-network-with-bad-key.scenario.js';
import { scenario as operatorFirstRunHealthCheck } from './semi-technical-operator/operator-first-run-health-check.scenario.js';

export const ALL_SCENARIOS: PersonaScenario[] = [
  agencyAmWeeklyImpact,
  publisherEarningsBadKey,
  operatorFirstRunHealthCheck,
];
