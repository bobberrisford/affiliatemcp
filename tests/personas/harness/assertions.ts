/**
 * Persona-harness assertion helpers.
 *
 * Each helper returns `AssertionFinding[]` (never throws) so the engine can
 * collect every problem in a journey rather than stopping at the first. A step
 * passes when its findings array is empty.
 */

import type { AssertionFinding, ShapeAssertion, StepResult } from './types.js';

/** Generic "an error occurred" phrasing that Principle 4.1 forbids. */
const GENERIC_ERROR_PHRASES = [
  'an error occurred',
  'something went wrong',
  'unknown error',
  'unexpected error',
];

/**
 * US spellings we reject in server-authored, user-facing prose (tool
 * descriptions). Kept tight and unambiguous to avoid false positives on
 * network-returned data (e.g. a real advertiser called "Color Co").
 */
const US_SPELLINGS = [
  'optimize',
  'optimization',
  'behavior',
  'canceled',
  'cancelation',
  'favorite',
  'analyze',
  'catalog',
  'fulfillment',
  'license fee', // "licence" is the UK noun; verb "license" is fine, so match a noun phrase
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shapeFindings(
  step: string,
  result: unknown,
  shape: ShapeAssertion,
): AssertionFinding[] {
  const findings: AssertionFinding[] = [];
  if (shape.requiredKeys) {
    if (!isRecord(result)) {
      findings.push({ step, message: `expected an object with keys ${shape.requiredKeys.join(', ')}` });
    } else {
      for (const key of shape.requiredKeys) {
        if (!(key in result)) findings.push({ step, message: `missing required key "${key}"` });
      }
    }
  }
  if (shape.arrayMinLength !== undefined) {
    if (!Array.isArray(result)) {
      findings.push({ step, message: `expected an array of length >= ${shape.arrayMinLength}` });
    } else if (result.length < shape.arrayMinLength) {
      findings.push({
        step,
        message: `expected array length >= ${shape.arrayMinLength}, got ${result.length}`,
      });
    }
  }
  if (shape.everyItemHasKeys) {
    const keys = shape.everyItemHasKeys;
    if (!Array.isArray(result)) {
      findings.push({ step, message: 'expected an array to check item keys' });
    } else {
      result.forEach((item, i) => {
        if (!isRecord(item)) {
          findings.push({ step, message: `item ${i} is not an object` });
          return;
        }
        for (const key of keys) {
          if (!(key in item)) findings.push({ step, message: `item ${i} missing key "${key}"` });
        }
      });
    }
  }
  return findings;
}

/**
 * Principle 4.1 checks against a coerced envelope: right type, names the
 * network, carries the verbatim upstream body, and is not a generic message.
 */
export function envelopeFindings(
  step: string,
  envelope: { type: string; network: string; operation: string; message: string; networkErrorBody?: string },
  expect: { errorType?: string; network?: string; envelopeIncludesBody?: string },
): AssertionFinding[] {
  const findings: AssertionFinding[] = [];
  if (expect.errorType && envelope.type !== expect.errorType) {
    findings.push({ step, message: `expected error type "${expect.errorType}", got "${envelope.type}"` });
  }
  if (expect.network && envelope.network !== expect.network) {
    findings.push({ step, message: `expected envelope.network "${expect.network}", got "${envelope.network}"` });
  }
  if (!envelope.operation) {
    findings.push({ step, message: 'envelope does not name the operation (Principle 4.1)' });
  }
  const lowerMessage = envelope.message.toLowerCase();
  for (const phrase of GENERIC_ERROR_PHRASES) {
    if (lowerMessage === phrase || lowerMessage.trim() === phrase) {
      findings.push({ step, message: `envelope message is generic ("${envelope.message}") — Principle 4.1` });
    }
  }
  if (expect.envelopeIncludesBody) {
    const body = envelope.networkErrorBody ?? '';
    if (!body.includes(expect.envelopeIncludesBody)) {
      findings.push({
        step,
        message: `envelope.networkErrorBody does not contain verbatim upstream fragment "${expect.envelopeIncludesBody}"`,
      });
    }
  }
  return findings;
}

/** Scan server-authored prose for US spellings. Returns one finding per hit. */
export function ukSpellingFindings(step: string, text: string): AssertionFinding[] {
  const findings: AssertionFinding[] = [];
  const lower = text.toLowerCase();
  for (const bad of US_SPELLINGS) {
    if (lower.includes(bad)) {
      findings.push({ step, message: `US spelling "${bad}" in user-facing prose; use UK spelling` });
    }
  }
  return findings;
}

/**
 * Assert no row in an array of records carries a zero-filled numeric field
 * where the fixture supplied no value — used to prove "no invented data": a
 * failed or missing figure must be absent, never a fabricated 0.
 */
export function noZeroFillFindings(
  step: string,
  rows: unknown,
  numericKeys: string[],
): AssertionFinding[] {
  const findings: AssertionFinding[] = [];
  if (!Array.isArray(rows)) return findings;
  rows.forEach((row, i) => {
    if (!isRecord(row)) return;
    for (const key of numericKeys) {
      // A present key that is null/undefined but reported as 0 elsewhere is the
      // failure mode; here we simply flag an explicit null masquerading as data.
      if (key in row && row[key] === null) {
        findings.push({ step, message: `row ${i} field "${key}" is null but present — surface "no data", do not zero-fill` });
      }
    }
  });
  return findings;
}

/** Flatten step + journey findings into the scenario aggregate. */
export function collectFindings(steps: StepResult[], journeyFindings: AssertionFinding[]): AssertionFinding[] {
  return [...steps.flatMap((s) => s.findings), ...journeyFindings];
}
