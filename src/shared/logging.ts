/**
 * Pino logger — stderr only.
 *
 * stdout is reserved for the MCP protocol channel; emitting any log line to
 * stdout will corrupt the JSON-RPC stream and break the client. Every logger
 * obtained via `createLogger` writes to fd 2 only.
 *
 * Redaction: any property whose key matches /token|secret|key|password|authorization/i
 * is replaced with `[REDACTED]`. This is best-effort — adapters should still
 * avoid putting raw credentials in log bindings.
 */

import pino, { type Logger } from 'pino';

const REDACT_KEY = /token|secret|key|password|authorization/i;

/**
 * Walk a serialisable object and redact sensitive-looking keys. Mutates a
 * shallow clone so pino's serialiser receives a sanitised view.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEY.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function resolveLevel(): string {
  const fromEnv = process.env.AFFILIATE_MCP_LOG_LEVEL ?? process.env.LOG_LEVEL;
  if (fromEnv && /^(trace|debug|info|warn|error|fatal|silent)$/i.test(fromEnv)) {
    return fromEnv.toLowerCase();
  }
  return 'info';
}

const root: Logger = pino(
  {
    level: resolveLevel(),
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      log(obj) {
        return redact(obj) as Record<string, unknown>;
      },
    },
  },
  // Force stderr — pino defaults to stdout otherwise.
  pino.destination({ fd: 2, sync: false }),
);

export function createLogger(name: string): Logger {
  return root.child({ component: name });
}

export type { Logger };
