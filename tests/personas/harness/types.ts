/**
 * Persona-testing harness — scenario model.
 *
 * A persona scenario is a typed, declarative journey: a persona identity, the
 * fake credentials and brand bindings that persona would have configured, and
 * an ordered sequence of steps. Each step is either a direct tool call or a
 * "skill step" — a skill journey expressed as the underlying `affiliate_*`
 * tool-call sequence its SKILL.md mandates (a skill cannot be invoked from a
 * unit test, so we encode the documented tool sequence instead).
 *
 * Scenarios drive the real generated tool surface (`generateAllTools()`), with
 * `globalThis.fetch` mocked from `tests/fixtures/<slug>/`. Nothing here touches
 * a real network or a real credential; a guard test rejects real-looking
 * secrets in `env`.
 *
 * Assertions check the observable CONTRACT, not just "no crash": envelope
 * correctness (Principle 4.1), no invented data, honest limitation surfacing,
 * and journey completeness. The harness has no model in the loop, so it proves
 * the data and envelopes a persona relies on are correct — not that a model
 * phrased the final report well (see tests/personas/README.md).
 */

import type { BrandsFile, NetworkErrorEnvelope } from '../../../src/shared/types.js';

export type PersonaId = 'agency-account-manager' | 'publisher' | 'semi-technical-operator';

/**
 * One HTTP response the mock should return. Exactly one source is used, in
 * precedence order: a fixture file (path relative to `tests/fixtures/`), inline
 * `json`, or a raw `body` string. `status` defaults to 200.
 */
export interface FixtureRef {
  fixture?: string;
  json?: unknown;
  body?: string;
  status?: number;
}

/**
 * How `globalThis.fetch` behaves for a step (or, as `scenario.fetch`, the
 * default for every step that does not override it).
 *
 *  - `queue`  — ordered responses, one shifted per fetch (mirrors the Awin
 *    journeys test). Best for a strictly ordered single-network call sequence;
 *    the engine asserts the queue is fully drained after the step.
 *  - `router` — match by URL substring (mirrors the brand-context-threading
 *    test). Best for multi-network journeys and adapters that probe/token-
 *    exchange before the real call.
 *  - `status` — a blanket status + body for every fetch (mirrors the bad-key
 *    rehearsal). Best for revoked-key and diagnostic journeys.
 */
export type FetchPlan =
  | { mode: 'queue'; responses: FixtureRef[] }
  | { mode: 'router'; routes: Array<{ match: string; respond: FixtureRef }>; fallback?: FixtureRef }
  | { mode: 'status'; status: number; body: string };

/** Declarative shape checks for an `ok`/`api-gap` result — no inline code needed. */
export interface ShapeAssertion {
  /** The result is an object with (at least) these keys. */
  requiredKeys?: string[];
  /** The result is an array with at least this many items. */
  arrayMinLength?: number;
  /** The result is an array and every item has these keys. */
  everyItemHasKeys?: string[];
}

export interface StepExpectation {
  outcome: 'ok' | 'error' | 'api-gap';
  /** error only: the envelope `type` the failure must classify to. */
  errorType?: NetworkErrorEnvelope['type'];
  /** error only: a verbatim fragment the envelope's `networkErrorBody` must contain (Principle 4.1). */
  envelopeIncludesBody?: string;
  /** error only: the network the envelope must name. */
  network?: string;
  /** ok/api-gap: declarative shape check. */
  shape?: ShapeAssertion;
  /** Escape hatch for bespoke checks; returns findings, never throws. */
  assert?: (result: unknown) => AssertionFinding[];
}

export interface ToolStep {
  kind: 'tool';
  tool: string;
  args?: Record<string, unknown>;
  /** Per-step fetch override; falls back to `scenario.fetch`. */
  fetch?: FetchPlan;
  expect: StepExpectation;
}

export interface SkillStep {
  kind: 'skill';
  /** The skill this journey stands in for (its SKILL.md is the source of truth). */
  skill: string;
  /** The documented underlying tool-call sequence. */
  calls: ToolStep[];
  /** Journey-level assertion over the collected call results (sequence, composition). */
  journey?: (results: StepResult[]) => AssertionFinding[];
}

export type ScenarioStep = ToolStep | SkillStep;

export interface StrategySeed {
  brand: string;
  strategyMarkdown?: string;
  kpiMarkdown?: string;
}

export interface PersonaScenario {
  id: string;
  persona: PersonaId;
  title: string;
  /** Fake credentials stashed into `process.env` for the run. Never real. */
  env: Record<string, string>;
  /** brands.json contents written to the sandboxed config dir (advertiser personas). */
  brands?: BrandsFile;
  /** Advisory strategy/KPI seeded via `affiliate_set_client_strategy`. */
  strategy?: StrategySeed[];
  /**
   * Descriptive only today: tiers are enforced by the hosted layer, not the
   * local core (see the plan's open decision D3). Recorded so a scenario reads
   * as the persona it models and so the hosted harness can reuse it later.
   */
  entitlementTier?: 'free' | 'solo' | 'pro';
  /** Default fetch behaviour; steps may override per step. */
  fetch?: FetchPlan;
  /** Per-network cache resets to run in setup/teardown (e.g. `_resetCredentialCache`). */
  resets?: Array<() => void>;
  steps: ScenarioStep[];
}

export interface AssertionFinding {
  step: string;
  message: string;
}

export interface StepResult {
  label: string;
  tool?: string;
  outcome: 'ok' | 'error' | 'api-gap' | 'missing-tool';
  result?: unknown;
  envelope?: NetworkErrorEnvelope;
  findings: AssertionFinding[];
}

export interface ScenarioResult {
  id: string;
  persona: PersonaId;
  title: string;
  steps: StepResult[];
  /** Aggregate of every step + journey finding. Empty means the journey passed. */
  findings: AssertionFinding[];
}
