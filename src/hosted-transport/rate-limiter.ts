/**
 * Per-user token-bucket rate limiter for the hosted MCP transport (H4).
 *
 * In-memory, single-node, MVP-only, exactly as the workstream brief scoped
 * it: "simple per-user token-bucket in memory (single-node MVP) with
 * env-configured limits". A durable, multi-node-aware limiter (e.g. Durable
 * Objects or a shared KV/Redis counter) is later hardening once the hosted
 * transport runs on more than one node — noted here rather than silently
 * assumed away, since a second Node process would give each user a second,
 * independent bucket.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterOptions {
  /** Maximum burst size: the number of calls a user may make instantly after being idle. */
  capacity: number;
  /** Sustained refill rate, in tokens (tool calls) per second. */
  refillPerSecond: number;
}

/**
 * A per-user token bucket. `consume(userId)` returns `true` and deducts one
 * token when the user is within their limit, `false` when they are not (the
 * caller must not deduct anything or retry internally — the MCP-level
 * `rate_limit` envelope IS the retry signal, per the brief's "honest
 * envelope, not transport error" requirement).
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimiterOptions) {}

  consume(userId: string, nowMs: number = Date.now()): boolean {
    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: this.options.capacity, lastRefillMs: nowMs };
      this.buckets.set(userId, bucket);
    } else {
      const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
      bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsedSeconds * this.options.refillPerSecond);
      bucket.lastRefillMs = nowMs;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Test/diagnostic only: drop all per-user state. */
  _reset(): void {
    this.buckets.clear();
  }
}
