/**
 * Small shared helpers for the Rewardful adapter. Kept out of `adapter.ts` so
 * the operation methods stay readable.
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AdapterCallContext } from '../../shared/types.js';
import { SLUG } from './client.js';

/** Build a `config_error` NetworkError for the Rewardful adapter. */
export function configErrorFor(
  operation: string,
  message: string,
  opts?: { hint?: string },
): NetworkError {
  return new NetworkError(
    buildErrorEnvelope({
      type: 'config_error',
      network: SLUG,
      operation,
      message,
      hint: opts?.hint,
    }),
  );
}

/**
 * Require an `AdapterCallContext` on advertiser-side operations. A Rewardful API
 * Secret scopes a single merchant account, so `networkBrandId` is currently
 * informational rather than used to address the API — but the advertiser tool
 * dispatch path always supplies it (resolved from `brand` via brands.json), so
 * we require it for a clear error rather than a runtime TypeError.
 */
export function requireCtx(operation: string, ctx?: AdapterCallContext): AdapterCallContext {
  if (!ctx || !ctx.networkBrandId) {
    throw configErrorFor(
      operation,
      `Rewardful ${operation} requires a brand context (networkBrandId).`,
      {
        hint:
          'Advertiser-side tools require a `brand` argument that the dispatcher resolves to a ' +
          'networkBrandId via brands.json. Call `affiliate_resolve_brand` to see which brands are bound.',
      },
    );
  }
  return ctx;
}
