/** Persona-harness public surface. */
export { runScenario } from './engine.js';
export {
  envelopeFindings,
  noZeroFillFindings,
  shapeFindings,
  ukSpellingFindings,
} from './assertions.js';
export type {
  AssertionFinding,
  FetchPlan,
  FixtureRef,
  PersonaId,
  PersonaScenario,
  ScenarioResult,
  ScenarioStep,
  SkillStep,
  StepExpectation,
  StepResult,
  ToolStep,
} from './types.js';
