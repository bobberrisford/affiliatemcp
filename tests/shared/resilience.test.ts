import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RESILIENCE,
  HttpStatusError,
  _resetBreakers,
  withResilience,
} from '../../src/shared/resilience.js';
import { NetworkError } from '../../src/shared/errors.js';

const FAST_CONFIG = {
  ...DEFAULT_RESILIENCE,
  timeoutMs: 500,
  retries: 2,
  retryOn: [429, 503],
  circuitBreaker: { threshold: 3, cooldownMs: 50 },
};

beforeEach(() => {
  _resetBreakers();
});

describe('withResilience', () => {
  it('returns the value on first success', async () => {
    const result = await withResilience(
      { network: 'test', operation: 'op' },
      async () => 42,
      FAST_CONFIG,
    );
    expect(result).toBe(42);
  });

  it('retries on a configured 5xx status', async () => {
    let calls = 0;
    const result = await withResilience(
      { network: 'test', operation: 'op' },
      async () => {
        calls += 1;
        if (calls < 2) throw new HttpStatusError(503, 'svc unavailable');
        return 'ok';
      },
      FAST_CONFIG,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does NOT retry on 401 (auth error)', async () => {
    let calls = 0;
    await expect(
      withResilience(
        { network: 'test', operation: 'op' },
        async () => {
          calls += 1;
          throw new HttpStatusError(401, 'bad token');
        },
        FAST_CONFIG,
      ),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it('retries on 429 even without explicit opt-in', async () => {
    let calls = 0;
    const cfg = { ...FAST_CONFIG, retryOn: [] };
    try {
      await withResilience(
        { network: 'test', operation: 'op' },
        async () => {
          calls += 1;
          throw new HttpStatusError(429, 'too many');
        },
        cfg,
      );
    } catch {
      // expected
    }
    expect(calls).toBeGreaterThan(1);
  });

  it('opens the circuit after threshold consecutive failures', async () => {
    const cfg = { ...FAST_CONFIG, retries: 0, circuitBreaker: { threshold: 2, cooldownMs: 200 } };
    const fn = async () => {
      throw new HttpStatusError(500, 'boom');
    };
    await expect(
      withResilience({ network: 't', operation: 'op' }, fn, cfg),
    ).rejects.toBeInstanceOf(NetworkError);
    await expect(
      withResilience({ network: 't', operation: 'op' }, fn, cfg),
    ).rejects.toBeInstanceOf(NetworkError);
    // Third call should fail fast with circuit_open.
    try {
      await withResilience({ network: 't', operation: 'op' }, fn, cfg);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('circuit_open');
    }
  });
});
