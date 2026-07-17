/**
 * Persona-harness engine.
 *
 * `runScenario` drives the real generated tool surface exactly as the MCP
 * server would (`generateAllTools()` → `ToolDefinition.handle`), minus the
 * JSON-RPC transport, against a mocked `globalThis.fetch`. It is behaviourally
 * identical to a tool call: same Zod parse, cache, brand resolution, adapter,
 * resilience, and error envelope. This is the same pattern every existing
 * integration test uses.
 *
 * Determinism: a fresh tmp `AFFILIATE_MCP_CONFIG_DIR` per scenario, breakers
 * and per-network caches reset, and the FS cache cleared before and after. Each
 * scenario restores every env var and `globalThis.fetch` it touched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import '../../../src/networks/index.js'; // side-effect: populate the adapter registry.
import { generateAllTools } from '../../../src/tools/generate.js';
import type { ToolDefinition } from '../../../src/tools/types.js';
import { saveBrands } from '../../../src/shared/brands.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { clearCache } from '../../../src/shared/cache.js';
import {
  BrandNotRegistered,
  buildErrorEnvelope,
  toErrorEnvelope,
} from '../../../src/shared/errors.js';
import type { NetworkErrorEnvelope } from '../../../src/shared/types.js';

import type {
  AssertionFinding,
  FetchPlan,
  FixtureRef,
  PersonaScenario,
  ScenarioResult,
  StepResult,
  ToolStep,
} from './types.js';
import { collectFindings, envelopeFindings, shapeFindings } from './assertions.js';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures');

function responseFor(ref: FixtureRef): Response {
  const status = ref.status ?? 200;
  let body: string;
  if (ref.fixture !== undefined) body = readFileSync(path.join(FIXTURE_ROOT, ref.fixture), 'utf8');
  else if (ref.json !== undefined) body = JSON.stringify(ref.json);
  else body = ref.body ?? '';
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

interface ActivePlan {
  next(url: string): Response;
  drained(): boolean;
}

function instantiate(plan: FetchPlan): ActivePlan {
  if (plan.mode === 'queue') {
    const queue = [...plan.responses];
    return {
      next() {
        const ref = queue.shift();
        if (!ref) throw new Error('persona harness: fetch queue exhausted');
        return responseFor(ref);
      },
      drained: () => queue.length === 0,
    };
  }
  if (plan.mode === 'router') {
    return {
      next(url: string) {
        const route = plan.routes.find((r) => url.includes(r.match));
        if (route) return responseFor(route.respond);
        if (plan.fallback) return responseFor(plan.fallback);
        throw new Error(`persona harness: no route for ${url}`);
      },
      drained: () => true,
    };
  }
  // status
  return {
    next: () => new Response(plan.body, { status: plan.status, headers: { 'content-type': 'application/json' } }),
    drained: () => true,
  };
}

function isApiGap(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'api-gap';
}

function toEnvelope(err: unknown, tool: string, expectNetwork?: string): NetworkErrorEnvelope {
  if (err instanceof BrandNotRegistered) {
    return buildErrorEnvelope({
      type: 'config_error',
      network: err.network,
      operation: tool,
      message: err.message,
    });
  }
  return toErrorEnvelope(err, { network: expectNetwork ?? '(unknown)', operation: tool });
}

async function runToolStep(
  step: ToolStep,
  tools: Map<string, ToolDefinition>,
  scenario: PersonaScenario,
  state: { active?: ActivePlan },
  labelPrefix = '',
): Promise<StepResult> {
  const label = `${labelPrefix}${step.tool}`;
  const def = tools.get(step.tool);
  if (!def) {
    return {
      label,
      tool: step.tool,
      outcome: 'missing-tool',
      findings: [{ step: label, message: `tool "${step.tool}" is not in the generated registry` }],
    };
  }

  const plan = step.fetch ?? scenario.fetch;
  state.active = plan ? instantiate(plan) : undefined;

  let outcome: StepResult['outcome'];
  let result: unknown;
  let envelope: NetworkErrorEnvelope | undefined;
  let caught: unknown;
  try {
    result = await def.handle(step.args ?? {});
    outcome = isApiGap(result) ? 'api-gap' : 'ok';
  } catch (err) {
    caught = err;
    outcome = 'error';
    envelope = toEnvelope(err, step.tool, step.expect.network);
  }

  const findings: AssertionFinding[] = [];
  const exp = step.expect;

  if (outcome !== exp.outcome) {
    const detail = caught instanceof Error ? ` (${caught.message})` : '';
    findings.push({ step: label, message: `expected outcome "${exp.outcome}", got "${outcome}"${detail}` });
  } else if (exp.outcome === 'error' && envelope) {
    findings.push(...envelopeFindings(label, envelope, exp));
  } else if (exp.outcome === 'ok' || exp.outcome === 'api-gap') {
    if (exp.shape) findings.push(...shapeFindings(label, result, exp.shape));
    if (exp.assert) findings.push(...exp.assert(result));
  }

  if (plan?.mode === 'queue' && state.active && !state.active.drained()) {
    findings.push({ step: label, message: 'fetch queue not fully drained (unexpected extra or missing HTTP call)' });
  }

  return { label, tool: step.tool, outcome, result, envelope, findings };
}

export async function runScenario(scenario: PersonaScenario): Promise<ScenarioResult> {
  const tools = new Map(generateAllTools().map((t) => [t.name, t]));

  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const tmp = mkdtempSync(path.join(tmpdir(), `amcp-persona-${scenario.id}-`));
  setEnv('AFFILIATE_MCP_CONFIG_DIR', tmp);
  for (const [key, value] of Object.entries(scenario.env)) setEnv(key, value);

  const originalFetch = globalThis.fetch;
  const state: { active?: ActivePlan } = {};
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!state.active) throw new Error(`persona harness: fetch(${url}) with no active plan for this step`);
    return state.active.next(url);
  }) as unknown as typeof fetch;

  const resetAll = (): void => {
    _resetBreakers();
    try {
      clearCache();
    } catch {
      /* cache dir may not exist yet */
    }
    for (const reset of scenario.resets ?? []) reset();
  };

  resetAll();
  const steps: StepResult[] = [];
  try {
    if (scenario.brands) saveBrands(scenario.brands);

    if (scenario.strategy) {
      const setStrategy = tools.get('affiliate_set_client_strategy');
      for (const seed of scenario.strategy) {
        state.active = undefined; // strategy writes are local; no fetch expected
        await setStrategy?.handle(seed);
      }
    }

    for (const step of scenario.steps) {
      if (step.kind === 'tool') {
        steps.push(await runToolStep(step, tools, scenario, state));
        continue;
      }
      // skill step: run its documented tool sequence, then journey assertions.
      const callResults: StepResult[] = [];
      for (const call of step.calls) {
        callResults.push(await runToolStep(call, tools, scenario, state, `${step.skill}:`));
      }
      steps.push(...callResults);
      if (step.journey) {
        steps.push({ label: `${step.skill} (journey)`, outcome: 'ok', findings: step.journey(callResults) });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAll();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return {
    id: scenario.id,
    persona: scenario.persona,
    title: scenario.title,
    steps,
    findings: collectFindings(steps, []),
  };
}
