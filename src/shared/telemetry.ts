/**
 * Privacy-first, explicitly opt-in telemetry.
 *
 * This module accepts only pre-classified, low-cardinality counters. It never
 * receives tool arguments, results, credentials, error text, or timestamps.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfigPaths } from '../cli/wizard/paths.js';

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_ENDPOINT =
  process.env['AFFILIATE_MCP_TELEMETRY_ENDPOINT'] ??
  'https://telemetry.agenticaffiliate.ai/v1/ingest';
export const PACKAGE_VERSION = '0.9.0';

export type TelemetrySurface = 'npm' | 'mcpb' | 'desktop-bundle' | 'unknown';
export type TelemetryOutcome =
  | 'success'
  | 'auth_error'
  | 'rate_limit'
  | 'config_error'
  | 'upstream_error'
  | 'other_error';

export interface TelemetryCount {
  network: string;
  operation: string;
  outcome: TelemetryOutcome;
  count: number;
}

export interface TelemetryPayload {
  schema_version: 1;
  day: string;
  monthly_install_id: string;
  package_version: string;
  surface: TelemetrySurface;
  counts: TelemetryCount[];
}

interface TelemetryState {
  consent: boolean;
  month?: string;
  monthlyInstallId?: string;
  lastSentDay?: string;
  pending?: Record<string, Record<string, number>>;
}

const OUTCOMES = new Set<TelemetryOutcome>([
  'success',
  'auth_error',
  'rate_limit',
  'config_error',
  'upstream_error',
  'other_error',
]);
const SAFE_DIMENSION = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function telemetryFilePath(): string {
  return path.join(resolveConfigPaths().dir, 'telemetry.json');
}

export function telemetryConsent(): 'enabled' | 'disabled' | 'unset' {
  const env = process.env['AFFILIATE_MCP_TELEMETRY']?.trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return 'enabled';
  if (env === '0' || env === 'false' || env === 'no') return 'disabled';
  const state = readState();
  if (!state) return 'unset';
  return state.consent ? 'enabled' : 'disabled';
}

export function setTelemetryConsent(enabled: boolean): void {
  if (!enabled) {
    writeState({ consent: false });
    return;
  }
  const state = readState() ?? { consent: true };
  state.consent = true;
  ensureMonthlyId(state);
  state.pending ??= {};
  writeState(state);
}

export function telemetryConsentPromptText(): string {
  return (
    'Share anonymous usage telemetry? Once daily we send the package version, launch surface, ' +
    'and counts by network, operation, and coarse outcome. A random identifier resets monthly. ' +
    'We never send credentials, affiliate data, prompts, arguments, results, or error text. ' +
    'You can disable this anytime with `affiliate-networks-mcp telemetry disable`.'
  );
}

export function recordTelemetry(
  network: string,
  operation: string,
  outcome: TelemetryOutcome,
  count = 1,
  day = utcDay(),
): void {
  try {
    if (telemetryConsent() !== 'enabled') return;
    if (
      !SAFE_DIMENSION.test(network) ||
      !SAFE_DIMENSION.test(operation) ||
      !OUTCOMES.has(outcome)
    ) {
      return;
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) return;

    const state = readState() ?? { consent: true };
    state.consent = true;
    ensureMonthlyId(state);
    state.pending ??= {};
    const daily = (state.pending[day] ??= {});
    const key = `${network}|${operation}|${outcome}`;
    daily[key] = Math.min((daily[key] ?? 0) + count, 1_000_000);
    writeState(state);
  } catch {
    // Telemetry must never affect the MCP server or a tool response.
  }
}

/**
 * Send the oldest completed day's summary. Current-day counters are retained
 * until a later active day, preventing multiple summaries for one day.
 */
export async function flushTelemetry(
  now = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await flushTelemetryInternal(now, fetchFn);
  } catch {
    // Telemetry must never affect package behaviour.
  }
}

async function flushTelemetryInternal(now: Date, fetchFn: typeof fetch): Promise<void> {
  if (telemetryConsent() !== 'enabled') return;
  const state = readState();
  if (!state?.consent) return;
  ensureMonthlyId(state, now);
  const today = utcDay(now);
  const day = Object.keys(state.pending ?? {})
    .filter((candidate) => candidate < today && candidate !== state.lastSentDay)
    .sort()[0];
  if (!day || !state.monthlyInstallId) {
    writeState(state);
    return;
  }

  const counts = parseCounts(state.pending?.[day] ?? {});
  if (counts.length === 0) {
    delete state.pending?.[day];
    writeState(state);
    return;
  }
  const payload: TelemetryPayload = {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    day,
    monthly_install_id: state.monthlyInstallId,
    package_version: PACKAGE_VERSION,
    surface: telemetrySurface(),
    counts,
  };

  const response = await fetchFn(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return;
  state.lastSentDay = day;
  delete state.pending?.[day];
  writeState(state);
}

export function telemetrySurface(): TelemetrySurface {
  const explicit = process.env['AFFILIATE_MCP_SURFACE'];
  if (explicit === 'npm' || explicit === 'mcpb' || explicit === 'desktop-bundle') return explicit;
  return process.env['npm_execpath'] || process.env['npm_config_user_agent'] ? 'npm' : 'unknown';
}

export function telemetryOutcomeFromErrorType(type: string): TelemetryOutcome {
  if (type === 'auth_error') return 'auth_error';
  if (type === 'rate_limit') return 'rate_limit';
  if (type === 'config_error') return 'config_error';
  if (
    type === 'network_api_error' ||
    type === 'network_unavailable' ||
    type === 'timeout' ||
    type === 'circuit_open'
  ) {
    return 'upstream_error';
  }
  return 'other_error';
}

export function _readTelemetryStateForTests(): TelemetryState | undefined {
  return readState();
}

function readState(): TelemetryState | undefined {
  const file = telemetryFilePath();
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const state = value as Partial<TelemetryState>;
    if (typeof state.consent !== 'boolean') return undefined;
    return state as TelemetryState;
  } catch {
    return undefined;
  }
}

function writeState(state: TelemetryState): void {
  const file = telemetryFilePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function ensureMonthlyId(state: TelemetryState, now = new Date()): void {
  const month = now.toISOString().slice(0, 7);
  if (state.month === month && state.monthlyInstallId) return;
  state.month = month;
  state.monthlyInstallId = randomUUID();
}

function parseCounts(raw: Record<string, number>): TelemetryCount[] {
  const counts: TelemetryCount[] = [];
  for (const [key, count] of Object.entries(raw)) {
    const [network, operation, outcome] = key.split('|');
    if (
      !network ||
      !operation ||
      !outcome ||
      !SAFE_DIMENSION.test(network) ||
      !SAFE_DIMENSION.test(operation) ||
      !OUTCOMES.has(outcome as TelemetryOutcome) ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      continue;
    }
    counts.push({ network, operation, outcome: outcome as TelemetryOutcome, count });
  }
  return counts;
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
