/**
 * Error envelope helpers.
 *
 * Principle 4.1 (PRD): every failure must name the network and the operation,
 * surface the verbatim network response body where one exists, never invent
 * success, and never collapse distinct failure modes into an opaque "an error
 * occurred". This module is the only sanctioned way to materialise that
 * contract.
 */

import type { NetworkErrorEnvelope, NetworkSlug } from './types.js';
import { NotImplementedError } from './types.js';

export { NotImplementedError };

export interface BuildErrorEnvelopeInput {
  type: NetworkErrorEnvelope['type'];
  network: NetworkSlug;
  operation: string;
  message: string;
  httpStatus?: number;
  networkErrorBody?: string;
  hint?: string;
}

export function buildErrorEnvelope(input: BuildErrorEnvelopeInput): NetworkErrorEnvelope {
  return {
    type: input.type,
    network: input.network,
    operation: input.operation,
    message: input.message,
    httpStatus: input.httpStatus,
    networkErrorBody: input.networkErrorBody,
    hint: input.hint,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Best-effort coercion of an arbitrary thrown value into an error envelope.
 * Used by the MCP server when an adapter throws something that didn't already
 * surface as a structured envelope.
 */
export function toErrorEnvelope(
  err: unknown,
  context: { network: NetworkSlug; operation: string },
): NetworkErrorEnvelope {
  // Already an envelope? Pass through (defensive type check).
  if (isErrorEnvelope(err)) return err;

  if (err instanceof NotImplementedError) {
    return buildErrorEnvelope({
      type: 'not_implemented',
      network: context.network,
      operation: context.operation,
      message: err.reason,
      hint: 'This operation is not implemented for this network at v0.1. See the network claim_status in network.json.',
    });
  }

  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    let type: NetworkErrorEnvelope['type'] = 'network_api_error';
    if (lower.includes('timeout') || lower.includes('timed out')) type = 'timeout';
    else if (lower.includes('circuit')) type = 'circuit_open';
    else if (lower.includes('auth') || lower.includes('unauthor')) type = 'auth_error';
    else if (lower.includes('rate limit') || lower.includes('429')) type = 'rate_limit';
    else if (lower.includes('econn') || lower.includes('unreachable') || lower.includes('enotfound'))
      type = 'network_unavailable';

    return buildErrorEnvelope({
      type,
      network: context.network,
      operation: context.operation,
      message: err.message,
    });
  }

  return buildErrorEnvelope({
    type: 'network_api_error',
    network: context.network,
    operation: context.operation,
    message: typeof err === 'string' ? err : 'Unknown error',
  });
}

export function isErrorEnvelope(value: unknown): value is NetworkErrorEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.network === 'string' &&
    typeof v.operation === 'string' &&
    typeof v.message === 'string' &&
    typeof v.timestamp === 'string'
  );
}

/**
 * A specialised error class carrying a fully-formed envelope. Adapters throw
 * this when they want to short-circuit the generic coercion above.
 */
export class NetworkError extends Error {
  public readonly envelope: NetworkErrorEnvelope;
  constructor(envelope: NetworkErrorEnvelope) {
    super(envelope.message);
    this.name = 'NetworkError';
    this.envelope = envelope;
  }
}
