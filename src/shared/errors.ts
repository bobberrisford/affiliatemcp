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

  // NetworkError wraps a pre-built envelope — surface it verbatim.
  if (err instanceof NetworkError) return err.envelope;

  if (err instanceof NotImplementedError) {
    return buildErrorEnvelope({
      type: 'not_implemented',
      network: context.network,
      operation: context.operation,
      message: err.reason,
      hint: 'This operation is not implemented for this network at v0.1. See the network claim_status in network.json.',
    });
  }

  // BrandNotRegistered documents itself as a config_error envelope; without
  // this branch it fell through to the message sniff below and surfaced as
  // network_api_error, despite no network call having been made.
  if (err instanceof BrandNotRegistered) {
    return buildErrorEnvelope({
      type: 'config_error',
      network: context.network,
      operation: context.operation,
      message: err.message,
      hint: 'Register the brand with `affiliate-networks-mcp setup`, or call affiliate_resolve_brand to see what is registered.',
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

/**
 * Thrown when an advertiser-side tool is invoked with a `brand` argument that
 * has not been bound to the named network in `brands.json`. Surfaces as a
 * `config_error` envelope at the MCP layer. Distinct from `NetworkError`
 * because the brand-resolution layer fails before any network call is made.
 */
export class BrandNotRegistered extends Error {
  public readonly brand: string;
  public readonly network: NetworkSlug;
  constructor(brand: string, network: NetworkSlug) {
    super(
      `Brand "${brand}" is not registered for network "${network}" in brands.json. ` +
        `Run \`affiliate-networks-mcp setup\` and add the brand, or call ` +
        `\`affiliate_resolve_brand\` to see what is registered.`,
    );
    this.name = 'BrandNotRegistered';
    this.brand = brand;
    this.network = network;
  }
}
