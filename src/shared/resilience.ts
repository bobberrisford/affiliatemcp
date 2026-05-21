/**
 * Resilience layer — the ONLY sanctioned path adapters use for network calls.
 *
 * Provides per-operation timeout, retries with exponential backoff + jitter,
 * and a circuit breaker. Policy (PRD §15.5/§15.7):
 *   - Never retry 4xx responses EXCEPT 429.
 *   - 5 consecutive failures → 60s circuit cooldown (configurable).
 *   - Surface circuit-open as a `NetworkErrorEnvelope { type: 'circuit_open' }`.
 *
 * Adapter authors: do NOT call fetch directly. Wrap every outgoing request in
 * `withResilience` so the policy applies uniformly and telemetry-free logging
 * stays consistent.
 */

import type { NetworkErrorEnvelope, NetworkSlug, ResilienceConfig } from './types.js';
import { NetworkError, buildErrorEnvelope } from './errors.js';
import { createLogger } from './logging.js';

const log = createLogger('resilience');

/**
 * Adapters throw this when an HTTP response is an actual failure they want
 * the resilience layer to inspect for retry eligibility. The `status` enables
 * the retry/no-retry decision; `body` is preserved verbatim (PRD principle 4.1).
 */
export class HttpStatusError extends Error {
  public readonly status: number;
  public readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
  }
}

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

const breakers = new Map<string, BreakerState>();

function breakerKey(network: NetworkSlug, operation: string): string {
  return `${network}:${operation}`;
}

function getBreaker(key: string): BreakerState {
  let s = breakers.get(key);
  if (!s) {
    s = { consecutiveFailures: 0, openedAt: null };
    breakers.set(key, s);
  }
  return s;
}

/** Test-only: reset all breakers. Not exported in the public surface intentionally. */
export function _resetBreakers(): void {
  breakers.clear();
}

export interface WithResilienceContext {
  network: NetworkSlug;
  operation: string;
}

/**
 * Run `fn` under the resilience policy.
 *
 * Behaviour:
 *   - Wraps `fn` in a timeout (rejects on overrun with a `timeout` envelope).
 *   - On thrown `HttpStatusError`:
 *       * status in `config.retryOn` → retry with exp backoff + jitter
 *       * 4xx (not 429, not in retryOn) → no retry, fail immediately
 *       * 5xx (not in retryOn) → no retry, fail immediately
 *   - On other thrown errors (network unavailable, abort) → retry up to `config.retries`.
 *   - Circuit opens after `config.circuitBreaker.threshold` consecutive failures;
 *     stays open for `cooldownMs`; subsequent calls fail fast with `circuit_open`.
 *
 * Throws `NetworkError` carrying a `NetworkErrorEnvelope` on failure.
 */
export async function withResilience<T>(
  ctx: WithResilienceContext,
  fn: () => Promise<T>,
  config: ResilienceConfig,
): Promise<T> {
  const key = breakerKey(ctx.network, ctx.operation);
  const breaker = getBreaker(key);
  const now = Date.now();

  // Circuit open check.
  if (breaker.openedAt !== null) {
    const elapsed = now - breaker.openedAt;
    if (elapsed < config.circuitBreaker.cooldownMs) {
      const remaining = config.circuitBreaker.cooldownMs - elapsed;
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'circuit_open',
          network: ctx.network,
          operation: ctx.operation,
          message: `Circuit breaker open for ${ctx.network}.${ctx.operation}; retry in ${Math.ceil(
            remaining / 1000,
          )}s.`,
          hint: 'Repeated upstream failures triggered the breaker. The cooldown will lift automatically.',
        }),
      );
    }
    // Cooldown elapsed — half-open: allow one attempt and reset counters.
    breaker.openedAt = null;
    breaker.consecutiveFailures = 0;
  }

  const maxAttempts = Math.max(1, config.retries + 1);
  let lastEnvelope: NetworkErrorEnvelope | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await runWithTimeout(fn, config.timeoutMs, ctx);
      // Success — reset breaker.
      breaker.consecutiveFailures = 0;
      breaker.openedAt = null;
      return result;
    } catch (err) {
      const envelope = classifyError(err, ctx);
      lastEnvelope = envelope;

      const shouldRetry = isRetryable(err, config, envelope.type) && attempt < maxAttempts;
      log.warn(
        {
          network: ctx.network,
          operation: ctx.operation,
          attempt,
          maxAttempts,
          type: envelope.type,
          httpStatus: envelope.httpStatus,
          willRetry: shouldRetry,
        },
        'operation failed',
      );

      if (!shouldRetry) {
        breaker.consecutiveFailures += 1;
        if (breaker.consecutiveFailures >= config.circuitBreaker.threshold) {
          breaker.openedAt = Date.now();
          log.warn(
            { network: ctx.network, operation: ctx.operation, threshold: config.circuitBreaker.threshold },
            'circuit breaker opened',
          );
        }
        throw new NetworkError(envelope);
      }

      // Backoff before next attempt: 200ms * 2^(attempt-1), jittered ±25%, capped at 5s.
      const base = Math.min(5000, 200 * 2 ** (attempt - 1));
      const jitter = base * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }

  // Defensive — loop always either returns or throws above.
  throw new NetworkError(
    lastEnvelope ??
      buildErrorEnvelope({
        type: 'network_api_error',
        network: ctx.network,
        operation: ctx.operation,
        message: 'Resilience layer exhausted retries without a result.',
      }),
  );
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  ctx: WithResilienceContext,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new NetworkError(
          buildErrorEnvelope({
            type: 'timeout',
            network: ctx.network,
            operation: ctx.operation,
            message: `Operation ${ctx.network}.${ctx.operation} timed out after ${timeoutMs}ms.`,
          }),
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRetryable(
  err: unknown,
  config: ResilienceConfig,
  classifiedType: NetworkErrorEnvelope['type'],
): boolean {
  // Never retry circuit-open, not-implemented, auth, or config errors.
  if (
    classifiedType === 'circuit_open' ||
    classifiedType === 'not_implemented' ||
    classifiedType === 'auth_error' ||
    classifiedType === 'config_error'
  ) {
    return false;
  }

  if (err instanceof HttpStatusError) {
    // Policy: never retry 4xx except 429 or anything explicitly opted into.
    if (err.status >= 400 && err.status < 500) {
      if (err.status === 429) return true;
      return config.retryOn.includes(err.status);
    }
    // 5xx: only retry if opted in.
    if (err.status >= 500) {
      return config.retryOn.includes(err.status);
    }
    return false;
  }

  // Timeouts and network-unavailable errors are retryable up to the limit.
  if (classifiedType === 'timeout' || classifiedType === 'network_unavailable') {
    return true;
  }
  return false;
}

function classifyError(err: unknown, ctx: WithResilienceContext): NetworkErrorEnvelope {
  if (err instanceof NetworkError) return err.envelope;

  if (err instanceof HttpStatusError) {
    let type: NetworkErrorEnvelope['type'] = 'network_api_error';
    if (err.status === 401 || err.status === 403) type = 'auth_error';
    else if (err.status === 429) type = 'rate_limit';
    return buildErrorEnvelope({
      type,
      network: ctx.network,
      operation: ctx.operation,
      httpStatus: err.status,
      networkErrorBody: err.body,
      message: err.message,
    });
  }

  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    if (lower.includes('econn') || lower.includes('enotfound') || lower.includes('unreachable')) {
      return buildErrorEnvelope({
        type: 'network_unavailable',
        network: ctx.network,
        operation: ctx.operation,
        message: err.message,
      });
    }
    return buildErrorEnvelope({
      type: 'network_api_error',
      network: ctx.network,
      operation: ctx.operation,
      message: err.message,
    });
  }

  return buildErrorEnvelope({
    type: 'network_api_error',
    network: ctx.network,
    operation: ctx.operation,
    message: typeof err === 'string' ? err : 'Unknown error',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The sensible default resilience config for an operation. Per-network adapters
 * override on a per-operation basis where the network's quirks demand it.
 */
export const DEFAULT_RESILIENCE: ResilienceConfig = {
  timeoutMs: 30_000,
  retries: 2,
  retryOn: [429, 502, 503, 504],
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 60_000,
  },
};
