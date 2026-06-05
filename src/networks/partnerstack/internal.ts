/**
 * Small shared helpers for the PartnerStack (partner) adapter. Kept out of
 * `adapter.ts` so the operation methods stay readable.
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { SLUG } from './client.js';

/** Build a `config_error` NetworkError for the PartnerStack partner adapter. */
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
